package execution

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// Substep is one node in the auto-derived progress tree of a pipeline step.
// IDs are hierarchical dot-paths ("1", "1.2", "1.2.3") and double as the
// marker payload the runner emits at runtime.
type Substep struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Source   string    `json:"source,omitempty"`
	Children []Substep `json:"children,omitempty"`
}

// PlanResult is what a step's planner returns: the visible substep tree and
// the instrumented script body that emits runtime progress markers as it
// executes. The instrumented script is what we feed to docker / k8s exec.
type PlanResult struct {
	Substeps   []Substep
	Script     string
	MarkerTag  string
	HasMarkers bool
}

// MaxScriptParseBytes caps how large an external script we'll instrument.
// Anything larger we treat as opaque — pulling 1 MB of shell into the parent
// script as a heredoc would balloon the WS payload and exec arglist.
const MaxScriptParseBytes = 256 * 1024 // 256 KB

// DefaultMaxPlanDepth bounds recursion through nested function and
// external-script expansions when no per-step override is set. Cycles are
// caught earlier via the per-function visiting flag; this cap exists to
// keep the substep tree at a useful "what functions did it actually call"
// depth without descending into every tiny utility helper.
//
// The cap is the deepest body-depth we'll plan. A function whose body is at
// depth N may itself contain calls whose names are surfaced as leaf
// substeps, so the user-visible nesting is N+1 levels. With depth=2 we get
// a top-level call (level 1) → its body's calls (level 2) → those calls'
// names (level 3) — three levels of names visible, anything deeper runs
// but stays collapsed.
const DefaultMaxPlanDepth = 2

// MaxAllowedPlanDepth caps how high the YAML can push substep_depth. Above
// this the runner clamps and warns. Generous but bounded — even 10 levels
// is more than any real-world script benefits from, and ungated values
// would balloon parse time on pathological inputs.
const MaxAllowedPlanDepth = 10

// trivialCommandHeads are shell builtins / no-op commands that aren't worth
// surfacing as user-visible substeps. The list is purely syntactic.
var trivialCommandHeads = map[string]bool{
	"cd": true, "pushd": true, "popd": true, "pwd": true,
	"set": true, "shift": true, "unset": true,
	"export": true, "readonly": true, "declare": true, "typeset": true, "local": true,
	"true": true, "false": true, ":": true,
	"return": true, "break": true, "continue": true,
	"trap": true, "umask": true, "exec": true,
	"alias": true, "unalias": true, "type": true, "hash": true,
}

// PlanOptions tunes how PlanSubsteps walks the script. Zero values mean
// "use defaults" — call sites pass per-step overrides resolved from YAML.
type PlanOptions struct {
	// MaxDepth bounds recursion through nested function/script expansions.
	// Values ≤ 0 use DefaultMaxPlanDepth; values above MaxAllowedPlanDepth
	// are clamped (callers should warn the user before clamping).
	MaxDepth int
}

// PlanSubsteps is the public entry point: parse `script`, walk the AST,
// and return the substep tree plus an instrumented script body that emits
// runtime markers as it executes. If the script is unparseable (or has no
// usable substeps), the result is empty and the runner falls back to
// running the original script un-instrumented.
func PlanSubsteps(script, basePath, mountedRepoPath string, opts PlanOptions) PlanResult {
	tag := newMarkerTag()
	depth := opts.MaxDepth
	if depth <= 0 {
		depth = DefaultMaxPlanDepth
	}
	if depth > MaxAllowedPlanDepth {
		depth = MaxAllowedPlanDepth
	}
	p := &planner{
		basePath:        basePath,
		mountedRepoPath: mountedRepoPath,
		markerTag:       tag,
		maxDepth:        depth,
	}
	subs, instrumented, ok := p.planFile(script, 0)
	if !ok || len(subs) == 0 {
		return PlanResult{}
	}
	// Convert all-relative IDs into absolute dot-paths. The runtime markers
	// emit absolute IDs (because __codeci_with_stack accumulates the call
	// path), so the plan tree must match.
	return PlanResult{
		Substeps:   absolutize(subs, ""),
		Script:     p.preamble() + instrumented,
		MarkerTag:  tag,
		HasMarkers: true,
	}
}

// absolutize walks the substep tree and rewrites every node's ID to its
// absolute dot-path. The planner produces all-relative IDs at every level
// (each node's ID is its position within its direct parent), and this final
// pass resolves them in one consistent place.
func absolutize(subs []Substep, parentPath string) []Substep {
	if len(subs) == 0 {
		return nil
	}
	out := make([]Substep, len(subs))
	for i, s := range subs {
		absID := s.ID
		if parentPath != "" {
			absID = parentPath + "." + s.ID
		}
		out[i] = Substep{
			ID:       absID,
			Name:     s.Name,
			Source:   s.Source,
			Children: absolutize(s.Children, absID),
		}
	}
	return out
}

// MarkerKind classifies a substep marker line.
type MarkerKind int

const (
	// MarkerNone — the line isn't a marker. Forward as normal output.
	MarkerNone MarkerKind = iota
	// MarkerStart — substep started; transition it to running.
	MarkerStart
	// MarkerName — name override for the substep (echoes with $vars). The
	// `name` return holds the resolved label.
	MarkerName
	// MarkerEnd — substep finished. Frontend should mark it success and any
	// still-running descendants too. Authoritative status (success/failed)
	// stays on the step's `exit` event.
	MarkerEnd
)

// ParseSubstepMarker classifies a streamed output line. For MarkerName the
// returned `name` is the resolved label; for other kinds it's empty.
// Returns MarkerNone with empty strings when the line isn't a marker.
func ParseSubstepMarker(line, tag string) (id, name string, kind MarkerKind) {
	const prefix = "::codeci::"
	idx := strings.Index(line, prefix)
	if idx < 0 {
		return "", "", MarkerNone
	}
	rest := line[idx+len(prefix):]
	if !strings.HasPrefix(rest, tag+"::") {
		return "", "", MarkerNone
	}
	rest = rest[len(tag)+2:]

	if strings.HasPrefix(rest, "name::") {
		rest = rest[len("name::"):]
		sep := strings.Index(rest, "::")
		if sep < 0 {
			return "", "", MarkerNone
		}
		idPart := strings.TrimSpace(rest[:sep])
		nm := strings.TrimSpace(rest[sep+2:])
		if !looksLikeSubstepID(idPart) {
			return "", "", MarkerNone
		}
		return idPart, nm, MarkerName
	}

	if strings.HasPrefix(rest, "end::") {
		rest = rest[len("end::"):]
		idPart := strings.TrimSpace(rest)
		if !looksLikeSubstepID(idPart) {
			return "", "", MarkerNone
		}
		return idPart, "", MarkerEnd
	}

	idPart := strings.TrimSpace(rest)
	if !looksLikeSubstepID(idPart) {
		return "", "", MarkerNone
	}
	return idPart, "", MarkerStart
}

func looksLikeSubstepID(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if !(c == '.' || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}

// ────────────────────────────────────────────────────────────────────────────
// planner internals
// ────────────────────────────────────────────────────────────────────────────

type planner struct {
	basePath        string
	mountedRepoPath string
	markerTag       string

	// maxDepth is the resolved recursion cap (already validated/clamped by
	// PlanSubsteps). All depth gates inside the planner read this — never
	// the package-level DefaultMaxPlanDepth.
	maxDepth int

	// funcs is per-file scope. planFile saves/restores it so nested file
	// planning (external scripts) has its own function map.
	funcs map[string]*funcEntry
}

// funcEntry tracks a local function declaration plus its lazily-computed
// substep template and instrumented body. Multiple call sites reuse the
// same template — the per-call disambiguation happens at runtime via the
// __codeci_with_stack helper, not statically.
type funcEntry struct {
	decl     *syntax.FuncDecl
	stmts    []*syntax.Stmt
	src      []byte // raw file bytes the AST offsets reference
	bodyLo   int    // first byte INSIDE the `{`
	bodyHi   int    // first byte of the `}` (exclusive on body)

	visited  bool
	visiting bool // cycle guard
	template []Substep
	bodyOut  string
}

// planFile parses a script, collects local function declarations, and plans
// top-level statements. The returned instrumented string is the file body
// only — callers prepend their own preamble (PlanSubsteps does that once).
func (p *planner) planFile(script string, depth int) ([]Substep, string, bool) {
	if depth > p.maxDepth || len(script) > MaxScriptParseBytes {
		return nil, "", false
	}
	parser := syntax.NewParser(syntax.Variant(syntax.LangBash))
	file, err := parser.Parse(strings.NewReader(script), "")
	if err != nil {
		return nil, "", false
	}
	src := []byte(script)

	// External scripts get their own function scope. Save+restore so we
	// don't leak parent funcs into child planning.
	prevFuncs := p.funcs
	p.funcs = make(map[string]*funcEntry)
	defer func() { p.funcs = prevFuncs }()

	for _, stmt := range file.Stmts {
		fd, ok := stmt.Cmd.(*syntax.FuncDecl)
		if !ok {
			continue
		}
		block, ok := fd.Body.Cmd.(*syntax.Block)
		if !ok {
			continue // function with non-block body — leave it alone
		}
		lo := int(block.Lbrace.Offset()) + 1
		hi := int(block.Rbrace.Offset())
		if lo < 0 || hi > len(src) || lo > hi {
			continue
		}
		p.funcs[fd.Name.Value] = &funcEntry{
			decl:   fd,
			stmts:  block.Stmts,
			src:    src,
			bodyLo: lo,
			bodyHi: hi,
		}
	}

	subs, body := p.planStmts(file.Stmts, src, depth)
	if len(subs) == 0 {
		return nil, "", false
	}
	return subs, body, true
}

// planStmts walks a contiguous slice of statements and produces (a) the
// substep nodes for this scope and (b) the source code with markers and
// call wrappers injected at the appropriate byte offsets.
//
// Top-level stmts in the slice produce substeps directly when they're
// meaningful (echoes, commands, function/script calls). Stmts inside
// compound constructs (if/for/while/case) get scanned recursively for
// function or external-script calls — those nested calls also become
// substeps in this scope's flat list, with markers injected at their
// in-source positions so progress fires whichever conditional branch is
// actually taken at runtime.
//
// All substep IDs returned here are RELATIVE (just sequential numbers).
// PlanSubsteps' absolutize pass turns them into absolute dot-paths at the
// end so the recursion across function calls / external scripts stays
// consistent regardless of nesting depth.
func (p *planner) planStmts(stmts []*syntax.Stmt, src []byte, depth int) ([]Substep, string) {
	if len(stmts) == 0 {
		return nil, ""
	}
	rangeStart := int(stmts[0].Pos().Offset())
	rangeEnd := int(stmts[len(stmts)-1].End().Offset())
	if rangeEnd > len(src) {
		rangeEnd = len(src)
	}

	var (
		subs    []Substep
		edits   []scriptEdit
		counter int
	)

	// addSubstep records a substep + the source edits announcing it at
	// runtime. The ID is assigned from the shared counter so nested
	// (inside-a-compound) substeps interleave naturally with top-level
	// ones in their source order.
	addSubstep := func(stmt *syntax.Stmt, label string, isDyn bool, kind expandKind, repl string, children []Substep) {
		counter++
		id := strconv.Itoa(counter)
		startOff := int(stmt.Pos().Offset())
		// Use the inner Cmd's End() so the statement separator (`;` / `&`)
		// stays in place after the replacement. stmt.End() includes the
		// terminator, and swallowing it breaks one-line constructs like
		// `if fn; then ...; fi` — fn would absorb the `;` and the parser
		// would see `with_stack fn then ...` (no separator → syntax error).
		endOff := int(stmt.Cmd.End().Offset())
		if endOff > len(src) {
			endOff = len(src)
		}

		switch kind {
		case expandFunction, expandScript:
			// Patch the call-site id into the wrapper template the
			// expander produced. The placeholder appears multiple times
			// (the `__codeci_with_stack` arg AND the open + close heredoc
			// tags for script expansion), so replace all occurrences.
			finalRepl := strings.ReplaceAll(repl, callSitePlaceholder, id)
			var b strings.Builder
			b.WriteString(p.startMarker(id))
			b.WriteString("\n")
			b.WriteString(finalRepl)
			edits = append(edits, scriptEdit{pos: startOff, replaceLen: endOff - startOff, text: b.String()})
			source := ""
			if kind == expandScript {
				source = "file:" + childSource(stmt, src)
			}
			subs = append(subs, Substep{ID: id, Name: label, Source: source, Children: children})
		default:
			var b strings.Builder
			b.WriteString(p.startMarker(id))
			b.WriteString("\n")
			if isDyn {
				if expr := dynamicLabelExpr(stmt, src); expr != "" {
					b.WriteString(p.nameMarkerEmit(id, expr))
					b.WriteString("\n")
				}
			}
			edits = append(edits, scriptEdit{pos: startOff, replaceLen: 0, text: b.String()})
			subs = append(subs, Substep{ID: id, Name: label})
		}
	}

	// Recursively walk a stmt (and its compound children) looking for
	// function-call or external-script-call sites to surface. Used when
	// the parent stmt itself wasn't surfaced (e.g. it was an if block).
	var descend func(stmt *syntax.Stmt)
	descend = func(stmt *syntax.Stmt) {
		switch cmd := stmt.Cmd.(type) {
		case *syntax.IfClause:
			for _, s := range cmd.Cond {
				descend(s)
			}
			for _, s := range cmd.Then {
				descend(s)
			}
			if cmd.Else != nil {
				descend(&syntax.Stmt{Cmd: cmd.Else})
			}
		case *syntax.ForClause:
			for _, s := range cmd.Do {
				descend(s)
			}
		case *syntax.WhileClause:
			for _, s := range cmd.Cond {
				descend(s)
			}
			for _, s := range cmd.Do {
				descend(s)
			}
		case *syntax.CaseClause:
			for _, item := range cmd.Items {
				for _, s := range item.Stmts {
					descend(s)
				}
			}
		case *syntax.Block:
			for _, s := range cmd.Stmts {
				descend(s)
			}
		case *syntax.Subshell:
			for _, s := range cmd.Stmts {
				descend(s)
			}
		case *syntax.BinaryCmd:
			if cmd.X != nil {
				descend(cmd.X)
			}
		case *syntax.CallExpr:
			// Inside compounds only expansions count — surfacing every
			// `aws cli call` or echo here would produce more noise than
			// signal. Function calls and bash X.sh are what map well to
			// progress milestones.
			repl, children, kind := p.tryExpandCall(stmt, src, callSitePlaceholder, depth)
			if kind == expandNone {
				return
			}
			label, _, keep := labelFromStmt(stmt, src)
			if !keep {
				return
			}
			addSubstep(stmt, label, false, kind, repl, children)
		}
	}

	// Two passes. Pass 1: walk non-FuncDecl stmts, surfacing substeps and
	// triggering lazy planning of called functions at THEIR call-site
	// depth (which is what we want for the depth-limit gating to work).
	// Pass 2: emit FuncDecl rewrites using the cached, depth-correct
	// bodies that pass 1 produced via lazy planning.
	//
	// If FuncDecls were rewritten eagerly in document order, every
	// function would get its body planned at depth=1 regardless of the
	// actual call chain — and the depth-limit gate would never fire.
	for _, stmt := range stmts {
		if _, ok := stmt.Cmd.(*syntax.FuncDecl); ok {
			continue
		}
		label, isDyn, keep := labelFromStmt(stmt, src)
		if !keep {
			descend(stmt)
			continue
		}
		repl, children, kind := p.tryExpandCall(stmt, src, callSitePlaceholder, depth)
		addSubstep(stmt, label, isDyn, kind, repl, children)
	}

	for _, stmt := range stmts {
		fd, ok := stmt.Cmd.(*syntax.FuncDecl)
		if !ok {
			continue
		}
		stmtStart := int(stmt.Pos().Offset())
		stmtEnd := int(stmt.End().Offset())
		if stmtEnd > len(src) {
			stmtEnd = len(src)
		}
		rewritten := p.rewriteFuncDecl(fd, src, depth)
		edits = append(edits, scriptEdit{pos: stmtStart, replaceLen: stmtEnd - stmtStart, text: rewritten})
	}

	return subs, applyEdits(src, rangeStart, rangeEnd, edits)
}

// callSitePlaceholder is the temporary marker id used inside replacement
// strings produced by tryExpandCall. addSubstep patches it with the real
// id once the substep counter has been advanced — this lets tryExpandCall
// stay id-agnostic and reusable from both the top-level loop and the
// descend-into-compounds walker.
const callSitePlaceholder = "@@CODECI_CALL_ID@@"

// scriptEdit is one byte-level edit applied to the source: insert when
// replaceLen=0, replace otherwise.
type scriptEdit struct {
	pos        int
	replaceLen int
	text       string
}

// applyEdits returns src[rangeStart:rangeEnd] with all edits applied in
// source order. Overlapping or out-of-range edits are skipped defensively
// rather than panicking — corruption in one edit shouldn't take the whole
// script down.
func applyEdits(src []byte, rangeStart, rangeEnd int, edits []scriptEdit) string {
	sorted := make([]scriptEdit, len(edits))
	copy(sorted, edits)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j].pos < sorted[j-1].pos; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}

	var b strings.Builder
	cursor := rangeStart
	for _, e := range sorted {
		if e.pos < cursor || e.pos > rangeEnd {
			continue
		}
		if e.pos > cursor {
			b.Write(src[cursor:e.pos])
		}
		b.WriteString(e.text)
		end := e.pos + e.replaceLen
		if end < cursor {
			end = cursor
		}
		if end > rangeEnd {
			end = rangeEnd
		}
		cursor = end
	}
	if cursor < rangeEnd {
		b.Write(src[cursor:rangeEnd])
	}
	return b.String()
}

// rewriteFuncDecl returns the function declaration with its body content
// replaced by the instrumented version. Whitespace inside the braces is
// preserved so the output stays roughly aligned with the original source.
//
// IMPORTANT: this never triggers planning itself — it uses whatever body
// was cached during pass 1's lazy planning. Triggering planning here would
// pre-plan every function at the file's top-level depth, defeating the
// depth-limit logic that relies on lazy, call-site-driven planning.
func (p *planner) rewriteFuncDecl(fd *syntax.FuncDecl, src []byte, depth int) string {
	_ = depth
	entry, ok := p.funcs[fd.Name.Value]
	if !ok {
		// Unknown shape (non-Block body) — emit verbatim.
		return string(src[fd.Pos().Offset():fd.End().Offset()])
	}

	startOff := int(fd.Pos().Offset())
	endOff := int(fd.End().Offset())
	if endOff > len(src) {
		endOff = len(src)
	}

	// Function was never reached from any call site (or the body planning
	// hit the depth ceiling) — emit verbatim. The function will still run
	// correctly at runtime; it just won't emit progress markers internally.
	if entry.bodyOut == "" {
		return string(src[startOff:endOff])
	}

	// Figure out leading/trailing whitespace inside the braces so we keep
	// "{\n  …\n}" formatting roughly intact.
	firstStmtStart := int(entry.stmts[0].Pos().Offset())
	lastStmtEnd := int(entry.stmts[len(entry.stmts)-1].End().Offset())
	if lastStmtEnd > len(src) {
		lastStmtEnd = len(src)
	}

	var b strings.Builder
	b.Grow(endOff - startOff + len(entry.bodyOut))
	b.Write(src[startOff:entry.bodyLo])
	if entry.bodyLo < firstStmtStart {
		b.Write(src[entry.bodyLo:firstStmtStart])
	}
	b.WriteString(entry.bodyOut)
	if lastStmtEnd < entry.bodyHi {
		b.Write(src[lastStmtEnd:entry.bodyHi])
	}
	b.Write(src[entry.bodyHi:endOff])
	return b.String()
}

// ensureFunctionPlanned populates entry.template + entry.bodyOut once.
// While a function is being planned (visiting=true), recursive calls back
// to it are treated as leaves — the original body is emitted unchanged in
// that case, avoiding infinite expansion.
func (p *planner) ensureFunctionPlanned(entry *funcEntry, depth int) {
	if entry.visited || entry.visiting {
		return
	}
	entry.visiting = true
	defer func() { entry.visiting = false; entry.visited = true }()

	if depth+1 > p.maxDepth {
		entry.bodyOut = ""
		return
	}
	subs, body := p.planStmts(entry.stmts, entry.src, depth+1)
	entry.template = subs
	entry.bodyOut = body
}

// lookupFunc returns the funcEntry for `name` if one is in scope.
func (p *planner) lookupFunc(name string) *funcEntry {
	if p.funcs == nil {
		return nil
	}
	return p.funcs[name]
}

// ────────────────────────────────────────────────────────────────────────────
// Call expansion
// ────────────────────────────────────────────────────────────────────────────

type expandKind int

const (
	expandNone     expandKind = 0
	expandFunction expandKind = 1
	expandScript   expandKind = 2
)

// tryExpandCall detects whether the statement is a call to a known local
// function or a readable external script and builds the runtime wrapper +
// callee plan tree (with absolute IDs prefixed by the call site).
func (p *planner) tryExpandCall(stmt *syntax.Stmt, src []byte, id string, depth int) (string, []Substep, expandKind) {
	if stmt.Background || stmt.Coprocess || len(stmt.Redirs) > 0 {
		return "", nil, expandNone
	}
	call, ok := stmt.Cmd.(*syntax.CallExpr)
	if !ok || len(call.Args) == 0 || len(call.Assigns) > 0 {
		return "", nil, expandNone
	}
	headLit, ok := singleLit(call.Args[0])
	if !ok {
		return "", nil, expandNone
	}

	if entry := p.lookupFunc(headLit); entry != nil && !entry.visiting {
		p.ensureFunctionPlanned(entry, depth)
		// Cap the visible template at this call site's remaining depth.
		// Even when the cached template includes deep children (because
		// the function was first encountered at a shallower depth), we
		// hide them here when we're already at the depth budget. Runtime
		// markers still fire — the frontend silently ignores markers
		// that don't match any plan node.
		var template []Substep
		if depth+1 <= p.maxDepth {
			template = entry.template
		}
		args := argsVerbatim(call.Args[1:], src)
		repl := fmt.Sprintf("__codeci_with_stack %q %s%s", id, headLit, args)
		return repl, template, expandFunction
	}

	var scriptPath string
	var scriptArgIdx int
	switch headLit {
	case "bash", "sh":
		i := 1
		for ; i < len(call.Args); i++ {
			lit, ok := singleLit(call.Args[i])
			if !ok {
				return "", nil, expandNone
			}
			if strings.HasPrefix(lit, "-") {
				if lit == "-c" || lit == "-s" {
					return "", nil, expandNone
				}
				continue
			}
			scriptPath = lit
			scriptArgIdx = i
			break
		}
		if scriptPath == "" {
			return "", nil, expandNone
		}
	case "source", ".":
		if len(call.Args) < 2 {
			return "", nil, expandNone
		}
		lit, ok := singleLit(call.Args[1])
		if !ok {
			return "", nil, expandNone
		}
		scriptPath = lit
		scriptArgIdx = 1
	default:
		if !looksLikeScriptInvocation(headLit) {
			return "", nil, expandNone
		}
		scriptPath = headLit
		scriptArgIdx = 0
	}

	body, _, ok := p.readScript(scriptPath)
	if !ok {
		return "", nil, expandNone
	}
	childSubs, instrumented, ok := p.planFile(body, depth+1)
	if !ok {
		return "", nil, expandNone
	}
	// Same rationale as function expansion: children carry relative IDs;
	// absolutize() at the planner's outermost boundary resolves them.
	children := childSubs

	heredocTag := "__CODECI_BODY_" + p.markerTag + "_" + strings.ReplaceAll(id, ".", "_")
	// Process substitution (`bash <(...)`) rather than `bash -c "$(...)" bash`:
	// the latter runs in command-string mode, where bash leaves BASH_SOURCE
	// empty. Real-world scripts that do `set -u` and then dereference
	// `${BASH_SOURCE[0]}` (a common pattern for SCRIPT_DIR resolution) abort
	// with "unbound variable". With `<(...)` bash sees the body as a script
	// file at /dev/fd/N, so BASH_SOURCE[0] is set and $0 is a real path.
	var b strings.Builder
	b.WriteString("__codeci_with_stack ")
	b.WriteString(strconv.Quote(id))
	b.WriteString(" bash <(cat <<'")
	b.WriteString(heredocTag)
	b.WriteString("'\n")
	b.WriteString(p.preamble())
	b.WriteString(instrumented)
	if !strings.HasSuffix(instrumented, "\n") {
		b.WriteString("\n")
	}
	b.WriteString(heredocTag)
	b.WriteString("\n)")
	for i := scriptArgIdx + 1; i < len(call.Args); i++ {
		startOff := int(call.Args[i].Pos().Offset())
		endOff := int(call.Args[i].End().Offset())
		if endOff > len(src) {
			endOff = len(src)
		}
		b.WriteString(" ")
		b.Write(src[startOff:endOff])
	}
	return b.String(), children, expandScript
}

func argsVerbatim(args []*syntax.Word, src []byte) string {
	if len(args) == 0 {
		return ""
	}
	var b strings.Builder
	for _, w := range args {
		startOff := int(w.Pos().Offset())
		endOff := int(w.End().Offset())
		if endOff > len(src) {
			endOff = len(src)
		}
		b.WriteString(" ")
		b.Write(src[startOff:endOff])
	}
	return b.String()
}

// ────────────────────────────────────────────────────────────────────────────
// Marker preamble + emit helpers
// ────────────────────────────────────────────────────────────────────────────

// preamble installs the marker emitters and the runtime call-stack helper
// used to namespace markers across nested calls. The stack is exported so
// external scripts spawned via `bash <(...)` inherit the current call path
// automatically.
//
// The stack is initialized via `${__codeci_stack:-}` rather than `""` so
// that nested invocations preserve the parent's exported value. The
// outermost preamble starts with the variable unset (empty default); an
// inner preamble inherits e.g. "1." from its caller and keeps it, so the
// inner script's markers come out as `1.X` (matching the plan tree) rather
// than `X` (which would match no plan node and stall the UI).
//
// `__codeci_with_stack` emits an END marker after the wrapped command
// returns — regardless of exit code. Without this the frontend has no
// signal to advance off the last started substep when the surrounding
// code has no plan nodes (e.g., the caller's body was depth-capped). The
// step's overall `exit` event is still authoritative for failure status.
func (p *planner) preamble() string {
	return fmt.Sprintf(`__codeci_stack="${__codeci_stack:-}"
export __codeci_stack
__codeci_marker() { printf '::codeci::%s::%%s%%s\n' "$__codeci_stack" "$1" 1>&2; }
__codeci_marker_name() { printf '::codeci::%s::name::%%s%%s::%%s\n' "$__codeci_stack" "$1" "$2" 1>&2; }
__codeci_marker_end() { printf '::codeci::%s::end::%%s%%s\n' "$__codeci_stack" "$1" 1>&2; }
__codeci_with_stack() {
  local __site="$1"; shift
  local __prev="$__codeci_stack"
  __codeci_stack="${__prev}${__site}."
  export __codeci_stack
  "$@"
  local __rc=$?
  __codeci_stack="$__prev"
  export __codeci_stack
  __codeci_marker_end "$__site"
  return $__rc
}
`, p.markerTag, p.markerTag, p.markerTag)
}

func (p *planner) startMarker(id string) string {
	return fmt.Sprintf("__codeci_marker %q", id)
}

// nameMarkerEmit returns a `__codeci_marker_name "ID" <expr>` line, where
// `expr` is the raw source text of the echo's first argument — passed
// through verbatim so quoting + variable / command-substitution semantics
// match the original echo.
func (p *planner) nameMarkerEmit(id, expr string) string {
	return fmt.Sprintf("__codeci_marker_name %q %s", id, expr)
}

// dynamicLabelExpr returns the raw source text of the first argument of an
// echo / printf statement, suitable to embed as the second arg of
// __codeci_marker_name. Returns "" when the statement isn't a dynamic echo.
func dynamicLabelExpr(stmt *syntax.Stmt, src []byte) string {
	call, ok := stmt.Cmd.(*syntax.CallExpr)
	if !ok || len(call.Args) < 2 {
		return ""
	}
	if head, _ := singleLit(call.Args[0]); head != "echo" && head != "printf" {
		return ""
	}
	w := call.Args[1]
	startOff := int(w.Pos().Offset())
	endOff := int(w.End().Offset())
	if startOff < 0 || endOff > len(src) || endOff <= startOff {
		return ""
	}
	return string(src[startOff:endOff])
}

// ────────────────────────────────────────────────────────────────────────────
// Label generation
// ────────────────────────────────────────────────────────────────────────────

// labelFromStmt derives a human-readable substep label from a statement.
// Returns:
//   - label    : the user-facing label
//   - isDynamic: whether to also emit a name-update marker at runtime so the
//                resolved value (e.g. "AWS Region: us-east-1") replaces the
//                static prefix label once the statement actually runs
//   - keep     : false when the statement should be excluded from the plan
//                list entirely (control flow, declarations, etc.) — these
//                still get emitted in the instrumented body, they just
//                aren't visible to the user as progress milestones
func labelFromStmt(stmt *syntax.Stmt, src []byte) (label string, isDynamic bool, keep bool) {
	switch stmt.Cmd.(type) {
	case *syntax.IfClause, *syntax.ForClause, *syntax.WhileClause,
		*syntax.CaseClause, *syntax.Subshell, *syntax.Block:
		return "", false, false
	case *syntax.FuncDecl, *syntax.DeclClause:
		return "", false, false
	case *syntax.BinaryCmd:
		bc := stmt.Cmd.(*syntax.BinaryCmd)
		if bc.X != nil {
			return labelFromStmt(bc.X, src)
		}
		return "", false, false
	case *syntax.CallExpr:
		// fall through
	default:
		return "", false, false
	}

	call := stmt.Cmd.(*syntax.CallExpr)
	if len(call.Args) == 0 {
		return "", false, false
	}
	headLit, headOK := singleLit(call.Args[0])
	if !headOK {
		return "", false, false
	}
	if trivialCommandHeads[headLit] {
		return "", false, false
	}

	if headLit == "echo" || headLit == "printf" {
		if len(call.Args) < 2 {
			return "", false, false
		}
		w := call.Args[1]
		if msg, isStatic := singleLit(w); isStatic {
			cleaned := sanitizeLabel(stripBannerPunct(msg))
			if cleaned == "" {
				return "", false, false
			}
			return cleaned, false, true
		}
		// Dynamic echo: take the literal prefix as the pending label, and
		// rely on the runtime name-update marker to fill in the resolved
		// value. If there's no literal prefix at all (echo "$var"), drop
		// the substep — we'd have nothing meaningful to show in the UI
		// until the variable is expanded at runtime, and a row with an
		// empty label is just noise.
		prefix := sanitizeLabel(stripBannerPunct(literalPrefix(w)))
		if prefix == "" {
			return "", false, false
		}
		return prefix, true, true
	}

	if headLit == "bash" || headLit == "sh" {
		for i := 1; i < len(call.Args); i++ {
			arg, ok := singleLit(call.Args[i])
			if !ok || strings.HasPrefix(arg, "-") {
				continue
			}
			return "Run " + filepath.Base(arg), false, true
		}
		return "", false, false
	}
	if headLit == "source" || headLit == "." {
		if len(call.Args) >= 2 {
			if arg, ok := singleLit(call.Args[1]); ok && arg != "" {
				return "Load " + filepath.Base(arg), false, true
			}
		}
		return "", false, false
	}
	if looksLikeScriptInvocation(headLit) {
		return "Run " + filepath.Base(headLit), false, true
	}

	if isIdentifierWord(headLit) && len(call.Args) == 1 {
		return prettifyIdentifier(headLit), false, true
	}

	return commandLabel(call), false, true
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

func literalPrefix(w *syntax.Word) string {
	if w == nil {
		return ""
	}
	var b strings.Builder
	for _, part := range w.Parts {
		switch p := part.(type) {
		case *syntax.Lit:
			b.WriteString(p.Value)
		case *syntax.SglQuoted:
			b.WriteString(p.Value)
		case *syntax.DblQuoted:
			for _, inner := range p.Parts {
				lit, ok := inner.(*syntax.Lit)
				if !ok {
					return strings.TrimSpace(b.String())
				}
				b.WriteString(lit.Value)
			}
		default:
			return strings.TrimSpace(b.String())
		}
	}
	return strings.TrimSpace(b.String())
}

func commandLabel(call *syntax.CallExpr) string {
	if len(call.Args) == 0 {
		return ""
	}
	head, ok := singleLit(call.Args[0])
	if !ok {
		return ""
	}
	parts := []string{head}
	for i := 1; i < len(call.Args) && len(parts) < 3; i++ {
		arg, ok := singleLit(call.Args[i])
		if !ok {
			break
		}
		if strings.HasPrefix(arg, "-") {
			if !strings.Contains(arg, "=") && i+1 < len(call.Args) {
				if next, ok := singleLit(call.Args[i+1]); ok && !looksLikeSubcommand(next) {
					i++
				}
			}
			continue
		}
		if !looksLikeSubcommand(arg) {
			break
		}
		parts = append(parts, arg)
	}
	return sanitizeLabel(strings.Join(parts, " "))
}

func looksLikeSubcommand(s string) bool {
	if s == "" {
		return false
	}
	if strings.ContainsAny(s, "/=:@{}[]\"'") {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
}

func isIdentifierWord(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		switch {
		case r == '_':
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case (r >= '0' && r <= '9') && i > 0:
		default:
			return false
		}
	}
	return true
}

func prettifyIdentifier(s string) string {
	var b strings.Builder
	for i, r := range s {
		if r == '_' || r == '-' {
			b.WriteRune(' ')
			continue
		}
		if i > 0 && r >= 'A' && r <= 'Z' {
			b.WriteRune(' ')
			b.WriteRune(r + ('a' - 'A'))
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return s
	}
	first := out[0]
	if first >= 'a' && first <= 'z' {
		out = string(first-('a'-'A')) + out[1:]
	}
	return out
}

func sanitizeLabel(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	s = maskCredentialURLs(s)
	s = maskKnownTokens(s)
	return summarize(s)
}

var reCredURL = regexp.MustCompile(`(?i)\b((?:https?|git|ssh)://)[^\s/@]+@`)

func maskCredentialURLs(s string) string {
	return reCredURL.ReplaceAllString(s, "$1***@")
}

var reKnownTokens = regexp.MustCompile(`\b(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_|sk-[a-zA-Z0-9]{16,}|xox[abp]-)[A-Za-z0-9_\-]{8,}`)

func maskKnownTokens(s string) string {
	return reKnownTokens.ReplaceAllString(s, "***")
}

func summarize(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "\t", " ")
	for strings.Contains(s, "  ") {
		s = strings.ReplaceAll(s, "  ", " ")
	}
	if s == "" {
		return "(empty)"
	}
	r := []rune(s)
	if len(r) > 90 {
		return string(r[:89]) + "…"
	}
	return s
}

func firstLine(s string) string {
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		return s[:idx]
	}
	return s
}

func stripBannerPunct(s string) string {
	s = strings.TrimSpace(s)
	for len(s) > 0 {
		c := s[0]
		if c != '=' && c != '#' && c != '*' && c != '-' {
			break
		}
		s = s[1:]
	}
	for len(s) > 0 {
		c := s[len(s)-1]
		if c != '=' && c != '#' && c != '*' && c != '-' {
			break
		}
		s = s[:len(s)-1]
	}
	return strings.TrimSpace(s)
}

// singleLit returns the value of a Word when it's purely literal (no $vars,
// command substitutions, arithmetic). Quoted-but-static strings count.
func singleLit(w *syntax.Word) (string, bool) {
	if w == nil || len(w.Parts) == 0 {
		return "", false
	}
	var b strings.Builder
	for _, part := range w.Parts {
		switch p := part.(type) {
		case *syntax.Lit:
			b.WriteString(p.Value)
		case *syntax.SglQuoted:
			b.WriteString(p.Value)
		case *syntax.DblQuoted:
			for _, inner := range p.Parts {
				lit, ok := inner.(*syntax.Lit)
				if !ok {
					return "", false
				}
				b.WriteString(lit.Value)
			}
		default:
			return "", false
		}
	}
	return b.String(), true
}

func looksLikeScriptInvocation(head string) bool {
	if strings.HasPrefix(head, "./") || strings.HasPrefix(head, "../") {
		return true
	}
	if strings.HasPrefix(head, "/") &&
		(strings.HasSuffix(head, ".sh") || strings.HasSuffix(head, ".bash")) {
		return true
	}
	return false
}

func childSource(stmt *syntax.Stmt, src []byte) string {
	startOff := int(stmt.Pos().Offset())
	endOff := int(stmt.End().Offset())
	if endOff > len(src) {
		endOff = len(src)
	}
	return firstLine(string(src[startOff:endOff]))
}

func joinID(prefix string, idx int) string {
	if prefix == "" {
		return strconv.Itoa(idx)
	}
	return prefix + "." + strconv.Itoa(idx)
}

func newMarkerTag() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// readScript locates and reads a referenced shell script. Tries:
//  1. the literal path
//  2. mounted-repo-mapped path (when the path starts with /tmp/codeci-deploy/)
//  3. relative to basePath
func (p *planner) readScript(path string) (string, string, bool) {
	candidates := []string{path}
	if p.mountedRepoPath != "" && strings.HasPrefix(path, "/tmp/codeci-deploy/") {
		candidates = append(candidates, filepath.Join(p.mountedRepoPath, strings.TrimPrefix(path, "/tmp/codeci-deploy/")))
	}
	if p.basePath != "" && !filepath.IsAbs(path) {
		candidates = append(candidates, filepath.Join(p.basePath, path))
	}
	for _, c := range candidates {
		cleaned := filepath.Clean(c)
		if !strings.HasSuffix(strings.ToLower(cleaned), ".sh") && !strings.HasSuffix(strings.ToLower(cleaned), ".bash") {
			continue
		}
		data, err := os.ReadFile(cleaned)
		if err != nil {
			continue
		}
		if len(data) > MaxScriptParseBytes {
			return "", "", false
		}
		return string(data), cleaned, true
	}
	return "", "", false
}
