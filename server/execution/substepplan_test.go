package execution

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlanSubsteps_FlatScript(t *testing.T) {
	script := `set -euo pipefail
cd /tmp/work
export FOO=bar
aws sts get-caller-identity --no-cli-pager
helm pull oci://example.com/chart --version 1.0
kubectl apply -f manifest.yaml
echo "All done"
`
	plan := PlanSubsteps(script, ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatalf("expected HasMarkers=true, got false (substeps=%v)", plan.Substeps)
	}

	got := flattenNames(plan.Substeps)
	// Labels are human-readable: command + leading subcommands only, no
	// flags, no paths, no raw shell. Trivial commands (set, cd, export)
	// are filtered. echo content surfaces as the bare message.
	want := []string{
		"aws sts get-caller-identity",
		"helm pull",
		"kubectl apply",
		"All done",
	}
	if !equalSlices(got, want) {
		t.Errorf("got substeps %#v, want %#v", got, want)
	}

	// Marker preamble + per-statement marker must be present.
	if !strings.Contains(plan.Script, "__codeci_marker()") {
		t.Errorf("instrumented script is missing the marker function definition:\n%s", plan.Script)
	}
	if !strings.Contains(plan.Script, "__codeci_marker \"1\"") {
		t.Errorf("instrumented script is missing the first marker emit:\n%s", plan.Script)
	}
	// Trivial statements must STAY in the script body (the filter only
	// hides them from the substep list) — dropping them would break things
	// like working-directory changes and environment exports the rest of
	// the script depends on.
	for _, trivial := range []string{"cd /tmp/work", "export FOO=bar", "set -euo pipefail"} {
		if !strings.Contains(plan.Script, trivial) {
			t.Errorf("instrumented script unexpectedly stripped trivial statement %q:\n%s", trivial, plan.Script)
		}
	}
}

func TestPlanSubsteps_RecursiveExpansion(t *testing.T) {
	dir := t.TempDir()
	child := `set -e
echo "=== child start ==="
helm pull foo
kubectl apply -f bar.yaml
`
	childPath := filepath.Join(dir, "child.sh")
	if err := os.WriteFile(childPath, []byte(child), 0o644); err != nil {
		t.Fatal(err)
	}

	parent := "cd /tmp/work\nbash " + childPath + " --flag value\necho done\n"
	plan := PlanSubsteps(parent, dir, "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatalf("expected HasMarkers=true")
	}
	if len(plan.Substeps) != 2 {
		t.Fatalf("expected 2 top-level substeps, got %d (%#v)", len(plan.Substeps), plan.Substeps)
	}
	bashCall := plan.Substeps[0]
	if len(bashCall.Children) == 0 {
		t.Fatalf("expected bash %s call to be recursively expanded, got no children", childPath)
	}
	childNames := flattenNames(bashCall.Children)
	want := []string{"child start", "helm pull foo", "kubectl apply"}
	if !equalSlices(childNames, want) {
		t.Errorf("child substep names = %#v, want %#v", childNames, want)
	}

	// Each marker ID must be unique and hierarchical.
	if bashCall.Children[0].ID != "1.1" || bashCall.Children[2].ID != "1.3" {
		t.Errorf("bad child IDs: %#v", bashCall.Children)
	}

	// The heredoc that carries the child body must be present in the
	// instrumented parent — this is what enables runtime markers from the
	// child script to flow back through the parent's stdio.
	if !strings.Contains(plan.Script, "__CODECI_BODY_") {
		t.Errorf("expected child heredoc tag in instrumented script:\n%s", plan.Script)
	}
}

func TestPlanSubsteps_UnreadableExternalScriptFallsBack(t *testing.T) {
	// External script doesn't exist on disk — recursion must fail silently
	// and the call is kept as a single top-level substep.
	script := "bash /no/such/path/script.sh --foo bar\n"
	plan := PlanSubsteps(script, ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatalf("expected HasMarkers=true")
	}
	if len(plan.Substeps) != 1 {
		t.Fatalf("expected 1 substep, got %d", len(plan.Substeps))
	}
	if plan.Substeps[0].Children != nil {
		t.Errorf("expected no children when external script is unreadable, got %#v", plan.Substeps[0].Children)
	}
}

func TestPlanSubsteps_FilterTrivialOnly(t *testing.T) {
	// A script that's nothing but trivial commands should plan no substeps.
	script := "cd /tmp\nset -e\nexport FOO=bar\nreadonly X=1\n"
	plan := PlanSubsteps(script, ".", "", PlanOptions{})
	if plan.HasMarkers {
		t.Errorf("expected HasMarkers=false for trivial-only script, got plan: %#v", plan.Substeps)
	}
}

func TestPlanSubsteps_ControlFlowHiddenFromPlan(t *testing.T) {
	// Control-flow constructs are plumbing — they should NOT appear in the
	// substep list (showing the user "if if [...]; then" is just code).
	// The if-block stays in the script body (so the conditional still
	// executes); it just isn't surfaced as a milestone.
	script := `if [ -n "$X" ]; then
  echo "have X"
  helm pull foo
fi
echo done
`
	plan := PlanSubsteps(script, ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatalf("expected HasMarkers=true")
	}
	if len(plan.Substeps) != 1 {
		t.Fatalf("expected 1 top-level substep (only the trailing echo), got %d (%#v)", len(plan.Substeps), plan.Substeps)
	}
	if plan.Substeps[0].Name != "done" {
		t.Errorf("expected 'done' as substep name, got %q", plan.Substeps[0].Name)
	}
	// But the if-block must still be in the instrumented script body.
	if !strings.Contains(plan.Script, "if [ -n \"$X\" ]") {
		t.Errorf("instrumented script unexpectedly dropped the if block:\n%s", plan.Script)
	}
}

func TestSanitizeLabel_MasksCredentials(t *testing.T) {
	cases := map[string]string{
		// PAT injected into a clone URL — the realistic leak vector.
		"Repository: https://github_pat_11AQHR5DI0hbdislOcIaNx_0JEvp5MdltyT19xdPKI1xhcu9Cvu2yD3xx4@github.com/foo/bar": "Repository: https://***@github.com/foo/bar",
		// Generic embedded credentials.
		"clone https://user:pass@gitlab.example/foo": "clone https://***@gitlab.example/foo",
		"git@github.com:foo/bar.git no scheme":      "git@github.com:foo/bar.git no scheme", // no userinfo / scheme — left alone
		// Bare token in text without an URL.
		"using token gho_aAa1bBb2cCc3dDd4 for auth": "using token *** for auth",
		// Plain text stays plain.
		"AWS Caller Identity": "AWS Caller Identity",
	}
	for in, want := range cases {
		got := sanitizeLabel(in)
		if got != want {
			t.Errorf("sanitizeLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLabelFromStmt_EchoWithCommandSubstitution(t *testing.T) {
	// echo strings that mix literal prefixes with $(...) substitutions or
	// $vars should yield the literal prefix only — never the raw command.
	script := `echo "Branch: $(git rev-parse --short HEAD) @ $(date)"
echo "AWS Region: $AWS_REGION"
`
	plan := PlanSubsteps(script, ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("expected HasMarkers=true")
	}
	if len(plan.Substeps) != 2 {
		t.Fatalf("expected 2 substeps, got %d", len(plan.Substeps))
	}
	// Trailing punctuation (a colon) is preserved — it's part of the user's
	// label and harmless. The important part is that the $(…) substitution
	// is NOT included.
	want := []string{"Branch:", "AWS Region:"}
	got := flattenNames(plan.Substeps)
	if !equalSlices(got, want) {
		t.Errorf("got %#v, want %#v", got, want)
	}
}

func TestLabelFromStmt_FunctionCallAndScriptInvocation(t *testing.T) {
	script := `verify_versions
deploy_namespace
bash /tmp/codeci-deploy/foo/deploy-application.sh --override-cluster=devops
source /tmp/codeci-deploy/scripts/helpers.sh
`
	plan := PlanSubsteps(script, ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("expected HasMarkers=true")
	}
	want := []string{
		"Verify versions",            // snake_case → "Verify versions"
		"Deploy namespace",           // snake_case → "Deploy namespace"
		"Run deploy-application.sh",  // bash X → "Run <basename>"
		"Load helpers.sh",            // source X → "Load <basename>"
	}
	got := flattenNames(plan.Substeps)
	if !equalSlices(got, want) {
		t.Errorf("got %#v, want %#v", got, want)
	}
}

func TestParseSubstepMarker(t *testing.T) {
	tag := "abc123"
	type want struct {
		id, name string
		kind     MarkerKind
	}
	cases := map[string]want{
		"::codeci::abc123::1":                                 {"1", "", MarkerStart},
		"::codeci::abc123::1.2.3":                             {"1.2.3", "", MarkerStart},
		"some prefix ::codeci::abc123::4":                     {"4", "", MarkerStart},
		"::codeci::abc123::name::5::AWS Region: us-east-1":    {"5", "AWS Region: us-east-1", MarkerName},
		"::codeci::abc123::name::5.2::Branch: develop @ a1b2": {"5.2", "Branch: develop @ a1b2", MarkerName},
		"::codeci::abc123::end::1":                            {"1", "", MarkerEnd},
		"::codeci::abc123::end::1.2.3":                        {"1.2.3", "", MarkerEnd},
		"::codeci::wrongtag::1":                               {"", "", MarkerNone},
		"plain log line":                                      {"", "", MarkerNone},
		"::codeci::abc123::not-an-id":                         {"", "", MarkerNone},
		"::codeci::abc123::name::bad-id::label":               {"", "", MarkerNone},
		"::codeci::abc123::end::bad-id":                       {"", "", MarkerNone},
	}
	for line, w := range cases {
		gotID, gotName, gotKind := ParseSubstepMarker(line, tag)
		if gotID != w.id || gotName != w.name || gotKind != w.kind {
			t.Errorf("ParseSubstepMarker(%q) = (%q, %q, %d), want (%q, %q, %d)", line, gotID, gotName, gotKind, w.id, w.name, w.kind)
		}
	}
}

func TestPlanSubsteps_FunctionBodyExpansion(t *testing.T) {
	// Local function definitions: their bodies should be walked so a call
	// to main() shows the steps inside it as children — not a single
	// opaque "Main" substep that runs for 20 minutes.
	script := `
ensure_login() {
  aws ecr get-login-password
  docker login example
}

main() {
  echo "Discovering clusters..."
  ensure_login
  helm pull oci://example/chart
}

main
`
	plan := PlanSubsteps(script, ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("expected HasMarkers=true")
	}
	if len(plan.Substeps) != 1 {
		t.Fatalf("expected one top-level substep (the main call), got %d", len(plan.Substeps))
	}
	top := plan.Substeps[0]
	if top.Name != "Main" {
		t.Errorf("expected top substep label 'Main', got %q", top.Name)
	}
	if len(top.Children) == 0 {
		t.Fatalf("expected children expanded from main()'s body, got none")
	}
	gotNames := flattenNames(top.Children)
	want := []string{"Discovering clusters...", "Ensure login", "helm pull"}
	if !equalSlices(gotNames, want) {
		t.Errorf("main() expansion = %#v, want %#v", gotNames, want)
	}
	// "Ensure login" is itself a call to a known function — recursive
	// expansion should populate its children.
	ensure := top.Children[1]
	if ensure.Name != "Ensure login" {
		t.Fatalf("expected nested function label 'Ensure login', got %q", ensure.Name)
	}
	if len(ensure.Children) == 0 {
		t.Fatalf("expected ensure_login() body to be expanded recursively")
	}
	// IDs are hierarchical.
	if top.ID != "1" || ensure.ID != "1.2" {
		t.Errorf("expected hierarchical IDs (1 / 1.2), got top=%q ensure=%q", top.ID, ensure.ID)
	}
	if ensure.Children[0].ID != "1.2.1" {
		t.Errorf("expected grandchild id 1.2.1, got %q", ensure.Children[0].ID)
	}

	// The instrumented script must include the runtime stack helper +
	// a __codeci_with_stack call site for the main() invocation.
	if !strings.Contains(plan.Script, "__codeci_with_stack") {
		t.Errorf("instrumented script missing __codeci_with_stack helper:\n%s", plan.Script)
	}
}

func TestPlanSubsteps_FunctionRecursionGuard(t *testing.T) {
	// Self-recursive function: planner must not infinite-loop. The first
	// call gets expanded; the recursive call inside is treated as a leaf.
	script := `
fact() {
  echo "step"
  fact
}
fact
`
	// Should not hang or panic.
	plan := PlanSubsteps(script, ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("expected HasMarkers=true")
	}
	if len(plan.Substeps) != 1 {
		t.Fatalf("expected 1 substep, got %d", len(plan.Substeps))
	}
}

func TestPlanSubsteps_DynamicLabelEmitsNameMarker(t *testing.T) {
	// An echo with a $var or $(...) — the static label is the literal
	// prefix, but the instrumented script must also emit a name-update
	// marker so the UI relabels the substep with the resolved value.
	script := `echo "AWS Region: $AWS_REGION"
echo "static label"
`
	plan := PlanSubsteps(script, ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("expected HasMarkers=true")
	}
	got := flattenNames(plan.Substeps)
	want := []string{"AWS Region:", "static label"}
	if !equalSlices(got, want) {
		t.Errorf("static labels = %#v, want %#v", got, want)
	}
	// Dynamic echo MUST get a name-update marker emit.
	if !strings.Contains(plan.Script, `__codeci_marker_name "1" "AWS Region: $AWS_REGION"`) {
		t.Errorf("instrumented script missing dynamic name-update emit:\n%s", plan.Script)
	}
	// Static echo MUST NOT get one (no point spending shell cycles on it).
	if strings.Contains(plan.Script, `__codeci_marker_name "2"`) {
		t.Errorf("static echo should not have a name-update emit:\n%s", plan.Script)
	}
}

func TestPlanSubsteps_IfThenOneLinerKeepsSemicolon(t *testing.T) {
	// One-liner if statements like `if fn; then ...; fi` used to break:
	// the planner replaced [stmt.Pos, stmt.End) which included the trailing
	// `;`, leaving `with_stack fn then ...` (no separator) → syntax error
	// on the `then` token. Verify the `;` survives instrumentation.
	script := `is_namespace_new() { return 0; }
if is_namespace_new "$NAMESPACE"; then is_new_ns="true"; fi
`
	plan := PlanSubsteps(script, ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("expected HasMarkers=true")
	}
	// The `; then` separator must be preserved verbatim. Searching for
	// `then` alone is too weak — we need the `;` immediately before it.
	if !strings.Contains(plan.Script, `"$NAMESPACE"; then`) {
		t.Errorf("instrumented script lost the `;` before `then` — `if cmd; then` will fail to parse:\n%s", plan.Script)
	}
}

func TestPlanSubsteps_ExternalScriptHeredocTagFullyResolved(t *testing.T) {
	// The script-expansion wrapper builds its heredoc tag from the call-site
	// id; that id is a placeholder until addSubstep patches it. The patch
	// previously used strings.Replace(..., 1) and missed the closing tag,
	// leaving a literal `@@CODECI_CALL_ID@@` in the output (which would
	// still parse, but it's a sign the substitution is incomplete).
	dir := t.TempDir()
	child := "echo hello\n"
	childPath := filepath.Join(dir, "child.sh")
	if err := os.WriteFile(childPath, []byte(child), 0o644); err != nil {
		t.Fatal(err)
	}
	parent := "bash " + childPath + "\n"
	plan := PlanSubsteps(parent, dir, "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("expected HasMarkers=true")
	}
	if strings.Contains(plan.Script, "@@CODECI_CALL_ID@@") {
		t.Errorf("call-site placeholder leaked into instrumented script (incomplete substitution):\n%s", plan.Script)
	}
}

func TestPlanSubsteps_ExternalScriptUsesProcessSubstitution(t *testing.T) {
	// External-script expansion must use `bash <(cat <<TAG ... TAG)`, not
	// `bash -c "$(cat <<TAG ... TAG)" bash`. Under `bash -c` mode the inner
	// script sees BASH_SOURCE as empty; combined with `set -u` (very common
	// in shell scripts) that aborts the run with `BASH_SOURCE[0]: unbound
	// variable`. Process substitution gives the inner bash a /dev/fd path,
	// so BASH_SOURCE[0] is populated.
	dir := t.TempDir()
	child := "echo hi\n"
	childPath := filepath.Join(dir, "child.sh")
	if err := os.WriteFile(childPath, []byte(child), 0o644); err != nil {
		t.Fatal(err)
	}
	plan := PlanSubsteps("bash "+childPath+"\n", dir, "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("expected HasMarkers=true")
	}
	if !strings.Contains(plan.Script, "bash <(cat <<'__CODECI_BODY_") {
		t.Errorf("instrumented script does not use process substitution for the external-script call:\n%s", plan.Script)
	}
	if strings.Contains(plan.Script, "bash -c \"$(cat <<'__CODECI_BODY_") {
		t.Errorf("instrumented script still uses `bash -c \"$(...)\"` which breaks BASH_SOURCE under set -u:\n%s", plan.Script)
	}
}

func TestPlanSubsteps_DepthCapsAtThree(t *testing.T) {
	// Three levels of function nesting (call → call → call) — the deepest
	// body must not be expanded. The call still runs at runtime; we just
	// don't surface its insides to keep the substep tree readable.
	script := `
a() { b; }
b() { c; }
c() { d; }
d() { echo "leaf"; }
a
`
	plan := PlanSubsteps(script, ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("expected HasMarkers=true")
	}
	// a is top-level (level 1). Walk down: a.b.c — that's three call levels.
	// c's body should NOT be expanded (level 4 would be `echo "leaf"`).
	if len(plan.Substeps) != 1 || plan.Substeps[0].Name != "A" {
		t.Fatalf("unexpected top-level substeps: %#v", plan.Substeps)
	}
	a := plan.Substeps[0]
	if len(a.Children) == 0 {
		t.Fatalf("a() must expand to show b — got no children")
	}
	b := a.Children[0]
	if len(b.Children) == 0 {
		t.Fatalf("b() must expand to show c — got no children")
	}
	c := b.Children[0]
	if len(c.Children) != 0 {
		t.Errorf("c() should NOT expand at depth 3 — got %d children: %#v", len(c.Children), c.Children)
	}
}

func TestPlanSubsteps_PreamblePreservesInheritedStack(t *testing.T) {
	// The preamble must NOT clobber an inherited __codeci_stack. When a top-
	// level call wraps an external script via `bash <(...)`, the parent
	// exports `__codeci_stack="1."` before invoking; the inner preamble runs
	// inside that child bash. If the preamble does `__codeci_stack=""`, the
	// inner script's markers come out as `::codeci::tag::1`, `…::2`, … — none
	// of which match plan ids of `1.1`, `1.2`, … so the UI stalls on the
	// parent. The fix initializes from `${__codeci_stack:-}` (preserves
	// inherited value, defaults to empty when unset at the outermost level).
	plan := PlanSubsteps("echo hello\n", ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("expected HasMarkers=true")
	}
	if strings.Contains(plan.Script, `__codeci_stack=""`) {
		t.Errorf("preamble still resets __codeci_stack to empty — nested marker ids will not be namespaced:\n%s", plan.Script)
	}
	if !strings.Contains(plan.Script, `__codeci_stack="${__codeci_stack:-}"`) {
		t.Errorf("preamble does not preserve inherited __codeci_stack:\n%s", plan.Script)
	}
}

func TestPlanSubsteps_RespectsDepthOverride(t *testing.T) {
	// With the default depth (2), the chain a→b→c shows c as a leaf.
	// Setting MaxDepth=1 should stop one level earlier — b becomes a leaf
	// (its body isn't planned), so a.Children[0] == b with no children.
	script := `
a() { b; }
b() { c; }
c() { echo leaf; }
a
`
	deep := PlanSubsteps(script, ".", "", PlanOptions{}) // default depth=2
	if !deep.HasMarkers {
		t.Fatal("default plan: expected HasMarkers=true")
	}
	if len(deep.Substeps[0].Children) == 0 || len(deep.Substeps[0].Children[0].Children) == 0 {
		t.Fatalf("default depth should surface a→b→c; got %#v", deep.Substeps)
	}

	shallow := PlanSubsteps(script, ".", "", PlanOptions{MaxDepth: 1})
	if !shallow.HasMarkers {
		t.Fatal("shallow plan: expected HasMarkers=true")
	}
	if len(shallow.Substeps) != 1 || shallow.Substeps[0].Name != "A" {
		t.Fatalf("expected single top substep 'A', got %#v", shallow.Substeps)
	}
	if len(shallow.Substeps[0].Children) != 1 || shallow.Substeps[0].Children[0].Name != "B" {
		t.Fatalf("MaxDepth=1 should surface a→b only; got %#v", shallow.Substeps[0].Children)
	}
	if len(shallow.Substeps[0].Children[0].Children) != 0 {
		t.Errorf("MaxDepth=1 should make b a leaf; got children %#v", shallow.Substeps[0].Children[0].Children)
	}
}

func TestPlanSubsteps_ClampsAboveMaxAllowed(t *testing.T) {
	// Asking for an absurd depth must clamp to MaxAllowedPlanDepth without
	// panicking or running away. The clamped plan must match the explicit
	// cap-depth plan — same number of substeps + same instrumented size.
	// (Script bytes can't be byte-equal because each PlanSubsteps mints a
	// fresh marker tag.)
	script := `
a() { b; }
b() { c; }
c() { echo leaf; }
a
`
	hugeAsk := PlanSubsteps(script, ".", "", PlanOptions{MaxDepth: MaxAllowedPlanDepth * 100})
	capAsk := PlanSubsteps(script, ".", "", PlanOptions{MaxDepth: MaxAllowedPlanDepth})
	if !hugeAsk.HasMarkers || !capAsk.HasMarkers {
		t.Fatal("both plans should produce markers")
	}
	if len(hugeAsk.Script) != len(capAsk.Script) {
		t.Errorf("clamping not effective: huge=%d cap=%d bytes", len(hugeAsk.Script), len(capAsk.Script))
	}
	if len(flattenIDs(hugeAsk.Substeps)) != len(flattenIDs(capAsk.Substeps)) {
		t.Errorf("clamping produced a different substep count: huge=%d cap=%d",
			len(flattenIDs(hugeAsk.Substeps)), len(flattenIDs(capAsk.Substeps)))
	}
}

func flattenIDs(subs []Substep) []string {
	var out []string
	var walk func([]Substep)
	walk = func(xs []Substep) {
		for _, s := range xs {
			out = append(out, s.ID)
			walk(s.Children)
		}
	}
	walk(subs)
	return out
}

func TestPlanSubsteps_EmitsEndMarkerFromWithStack(t *testing.T) {
	// The preamble's __codeci_with_stack must call __codeci_marker_end after
	// the wrapped command returns — this is what stops the indicator from
	// freezing on the last leaf substep when surrounding code has no plan
	// nodes.
	plan := PlanSubsteps("echo hi\n", ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("expected HasMarkers=true")
	}
	if !strings.Contains(plan.Script, "__codeci_marker_end()") {
		t.Errorf("preamble missing __codeci_marker_end definition:\n%s", plan.Script)
	}
	if !strings.Contains(plan.Script, `__codeci_marker_end "$__site"`) {
		t.Errorf("__codeci_with_stack does not emit an end marker:\n%s", plan.Script)
	}
}

// flattenNames returns just the names (top-level only) for assertion convenience.
func flattenNames(subs []Substep) []string {
	out := make([]string, 0, len(subs))
	for _, s := range subs {
		out = append(out, s.Name)
	}
	return out
}

func equalSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
