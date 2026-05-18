package pipeline

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// ImportResult reports the outcome of importing a single YAML payload.
// Filename is the source name (e.g. "deploy.yaml" or "archive.zip/deploy.yaml").
// ID and Slug are populated only on success. Error is populated only on failure.
type ImportResult struct {
	Filename string `json:"filename"`
	Status   string `json:"status"` // "imported" | "renamed" | "error"
	ID       string `json:"id,omitempty"`
	Saved    string `json:"saved,omitempty"`
	Error    string `json:"error,omitempty"`
}

// ValidatePipelineYAML checks that the given bytes parse, expand, and validate
// as a Pipeline. It is the same path used by Create/Update so import can never
// land a file the rest of the codebase would refuse to load.
func ValidatePipelineYAML(data []byte) (*Pipeline, error) {
	var p Pipeline
	if err := yaml.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("invalid YAML: %w", err)
	}
	if strings.TrimSpace(p.Name) == "" {
		return nil, fmt.Errorf("pipeline.name is required")
	}
	if len(p.Steps) == 0 {
		return nil, fmt.Errorf("pipeline must declare at least one step")
	}
	p.Expand()
	if p.MaxConcurrentRuns < 1 {
		p.MaxConcurrentRuns = 1
	}
	if err := normaliseQueueStrategy(&p); err != nil {
		return nil, err
	}
	if err := validateSteps(p.Steps); err != nil {
		return nil, err
	}
	return &p, nil
}

type Loader struct {
	dir string

	// listCache memoises List() between calls. Invalidated by directory
	// mtime, so any file create/update/delete in dir refreshes it.
	listCache struct {
		sync.RWMutex
		mtime     time.Time
		pipelines []Pipeline
	}
}

func NewLoader(dir string) *Loader {
	return &Loader{dir: dir}
}

// invalidateListCache forces the next List() call to re-read the directory.
// Callers that mutate dir must invoke this so cached results stay accurate
// regardless of filesystem mtime resolution.
func (l *Loader) invalidateListCache() {
	l.listCache.Lock()
	l.listCache.mtime = time.Time{}
	l.listCache.pipelines = nil
	l.listCache.Unlock()
}

func (l *Loader) List() ([]Pipeline, error) {
	dirInfo, err := os.Stat(l.dir)
	if err != nil {
		return nil, fmt.Errorf("reading pipelines dir: %w", err)
	}
	dirMtime := dirInfo.ModTime()

	l.listCache.RLock()
	if !l.listCache.mtime.IsZero() && l.listCache.mtime.Equal(dirMtime) && l.listCache.pipelines != nil {
		cached := l.listCache.pipelines
		l.listCache.RUnlock()
		// Return a shallow copy so callers can't mutate the cache.
		out := make([]Pipeline, len(cached))
		copy(out, cached)
		return out, nil
	}
	l.listCache.RUnlock()

	entries, err := os.ReadDir(l.dir)
	if err != nil {
		return nil, fmt.Errorf("reading pipelines dir: %w", err)
	}

	type loaded struct {
		p       Pipeline
		modTime time.Time
	}
	var items []loaded
	for _, e := range entries {
		if e.IsDir() || (!strings.HasSuffix(e.Name(), ".yaml") && !strings.HasSuffix(e.Name(), ".yml")) {
			continue
		}
		p, err := l.load(e.Name())
		if err != nil {
			continue // skip malformed files
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		items = append(items, loaded{p: *p, modTime: info.ModTime()})
	}
	// Newest first by file modification time.
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].modTime.After(items[j].modTime)
	})
	pipelines := make([]Pipeline, len(items))
	for i, it := range items {
		pipelines[i] = it.p
	}

	l.listCache.Lock()
	l.listCache.mtime = dirMtime
	l.listCache.pipelines = pipelines
	l.listCache.Unlock()

	out := make([]Pipeline, len(pipelines))
	copy(out, pipelines)
	return out, nil
}

func (l *Loader) Get(id string) (*Pipeline, error) {
	filename, err := l.findFile(id)
	if err != nil {
		return nil, err
	}
	return l.load(filename)
}

func (l *Loader) GetRaw(id string) (string, error) {
	filename, err := l.findFile(id)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(filepath.Join(l.dir, filename))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (l *Loader) Update(id string, content string) error {
	filename, err := l.findFile(id)
	if err != nil {
		return err
	}

	// Validate content is valid YAML and matches schema
	var p Pipeline
	if err := yaml.Unmarshal([]byte(content), &p); err != nil {
		return fmt.Errorf("invalid YAML: %w", err)
	}

	path := filepath.Join(l.dir, filename)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return err
	}
	l.invalidateListCache()
	return nil
}

func (l *Loader) Delete(id string) error {
	filename, err := l.findFile(id)
	if err != nil {
		return err
	}
	path := filepath.Join(l.dir, filename)
	if err := os.Remove(path); err != nil {
		return err
	}
	l.invalidateListCache()
	return nil
}

func (l *Loader) findFile(id string) (string, error) {
	// Prevent path traversal
	if strings.Contains(id, "/") || strings.Contains(id, "..") {
		return "", fmt.Errorf("invalid pipeline id")
	}

	entries, err := os.ReadDir(l.dir)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if !e.IsDir() && (strings.HasSuffix(e.Name(), ".yaml") || strings.HasSuffix(e.Name(), ".yml")) && toSlug(e.Name()) == id {
			return e.Name(), nil
		}
	}
	return "", fmt.Errorf("pipeline not found: %s", id)
}

func (l *Loader) load(filename string) (*Pipeline, error) {
	path := filepath.Join(l.dir, filename)
	// Resolve to absolute and confirm it's inside l.dir
	absDir, _ := filepath.Abs(l.dir)
	absPath, _ := filepath.Abs(path)
	if !strings.HasPrefix(absPath, absDir+string(os.PathSeparator)) {
		return nil, fmt.Errorf("path traversal detected")
	}

	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}

	var p Pipeline
	if err := yaml.Unmarshal(data, &p); err != nil {
		return nil, err
	}
	p.Expand()
	if p.MaxConcurrentRuns < 1 {
		p.MaxConcurrentRuns = 1
	}
	if err := normaliseQueueStrategy(&p); err != nil {
		return nil, err
	}
	if err := validateSteps(p.Steps); err != nil {
		return nil, err
	}
	p.ID = toSlug(filename)
	return &p, nil
}

// normaliseQueueStrategy defaults empty/unset to "fifo" and validates the
// "replace" strategy invariant (max_concurrent_runs must be 1, otherwise
// the semantic — "only the newest queued submission survives" — is
// undefined). Returns an error the caller can surface to the API consumer.
func normaliseQueueStrategy(p *Pipeline) error {
	switch p.QueueStrategy {
	case "", QueueStrategyFIFO:
		p.QueueStrategy = QueueStrategyFIFO
	case QueueStrategyReplace:
		if p.MaxConcurrentRuns != 1 {
			return fmt.Errorf("queue_strategy %q requires max_concurrent_runs: 1 (got %d)", QueueStrategyReplace, p.MaxConcurrentRuns)
		}
	default:
		return fmt.Errorf("invalid queue_strategy %q (allowed: %q, %q)", p.QueueStrategy, QueueStrategyFIFO, QueueStrategyReplace)
	}
	return nil
}

// validateSteps enforces the runner/codebuild invariants. A step must have
// exactly one of Run (docker) or CodeBuild (codebuild). The Runner field is
// optional but, if present, must agree with which body is set.
func validateSteps(steps []Step) error {
	for i, s := range steps {
		runner := s.Runner
		if runner == "" {
			if s.CodeBuild != nil {
				runner = "codebuild"
			} else {
				runner = "docker"
			}
		}
		switch runner {
		case "docker":
			if s.CodeBuild != nil {
				return fmt.Errorf("step %d (%q): docker runner cannot have codebuild block", i, s.Name)
			}
			if strings.TrimSpace(s.Run) == "" {
				return fmt.Errorf("step %d (%q): docker runner requires non-empty run", i, s.Name)
			}
		case "codebuild":
			if s.CodeBuild == nil {
				return fmt.Errorf("step %d (%q): codebuild runner requires codebuild block", i, s.Name)
			}
			if strings.TrimSpace(s.CodeBuild.Project) == "" {
				return fmt.Errorf("step %d (%q): codebuild.project is required", i, s.Name)
			}
			if strings.TrimSpace(s.Run) != "" {
				return fmt.Errorf("step %d (%q): codebuild runner cannot also set run", i, s.Name)
			}
		default:
			return fmt.Errorf("step %d (%q): unknown runner %q (allowed: docker, codebuild)", i, s.Name, runner)
		}
	}
	return nil
}

// ExportZip writes a zip archive of every YAML pipeline file in the directory
// to w. Each entry preserves its original filename and modification time.
func (l *Loader) ExportZip(w io.Writer) error {
	entries, err := os.ReadDir(l.dir)
	if err != nil {
		return fmt.Errorf("reading pipelines dir: %w", err)
	}

	zw := zip.NewWriter(w)
	defer zw.Close()

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if !strings.HasSuffix(e.Name(), ".yaml") && !strings.HasSuffix(e.Name(), ".yml") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = e.Name()
		header.Method = zip.Deflate
		fw, err := zw.CreateHeader(header)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(filepath.Join(l.dir, e.Name()))
		if err != nil {
			return err
		}
		if _, err := fw.Write(data); err != nil {
			return err
		}
	}
	return nil
}

func (l *Loader) Create(name string, content string) (string, error) {
	slug := toSlug(name)
	if slug == "" {
		slug = "unnamed"
	}

	// Ensure uniqueness
	filename := slug + ".yaml"
	if _, err := os.Stat(filepath.Join(l.dir, filename)); err == nil {
		// File exists, add a short unique suffix
		filename = fmt.Sprintf("%s-%x.yaml", slug, time.Now().Unix()%0xFFF)
	}

	// Validate content is valid YAML
	var p Pipeline
	if err := yaml.Unmarshal([]byte(content), &p); err != nil {
		return "", fmt.Errorf("invalid YAML: %w", err)
	}

	path := filepath.Join(l.dir, filename)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return "", err
	}
	l.invalidateListCache()

	return toSlug(filename), nil
}

// ImportYAML validates and writes a single pipeline YAML file. The basename is
// taken from the supplied filename (path components are stripped); collisions
// pick a unique suffix instead of overwriting an existing pipeline. The
// resulting ImportResult records the saved filename / pipeline id.
func (l *Loader) ImportYAML(filename string, data []byte) ImportResult {
	res := ImportResult{Filename: filename}

	if _, err := ValidatePipelineYAML(data); err != nil {
		res.Status = "error"
		res.Error = err.Error()
		return res
	}

	base := filepath.Base(filename)
	ext := strings.ToLower(filepath.Ext(base))
	if ext != ".yaml" && ext != ".yml" {
		res.Status = "error"
		res.Error = "expected .yaml or .yml extension"
		return res
	}

	target := base
	if _, err := os.Stat(filepath.Join(l.dir, target)); err == nil {
		stem := strings.TrimSuffix(base, ext)
		target = fmt.Sprintf("%s-imported-%x%s", stem, time.Now().UnixNano()%0xFFFFFF, ext)
		res.Status = "renamed"
	} else {
		res.Status = "imported"
	}

	if err := os.WriteFile(filepath.Join(l.dir, target), data, 0644); err != nil {
		return ImportResult{Filename: filename, Status: "error", Error: err.Error()}
	}
	l.invalidateListCache()
	res.Saved = target
	res.ID = toSlug(target)
	return res
}

// ImportZipReader walks the zip archive and imports every .yaml/.yml entry it
// finds. Non-YAML entries are skipped silently. Each entry's result is keyed
// by "<archive>/<entry-name>" so the UI can show where the file came from.
func (l *Loader) ImportZipReader(archiveName string, r io.ReaderAt, size int64) ([]ImportResult, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, fmt.Errorf("invalid zip: %w", err)
	}
	var out []ImportResult
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := f.Name
		lower := strings.ToLower(name)
		if !strings.HasSuffix(lower, ".yaml") && !strings.HasSuffix(lower, ".yml") {
			continue
		}
		// Reject zip-slip style entries early; we only ever use the basename.
		if strings.Contains(name, "..") {
			out = append(out, ImportResult{
				Filename: archiveName + "/" + name,
				Status:   "error",
				Error:    "unsafe entry path",
			})
			continue
		}
		rc, err := f.Open()
		if err != nil {
			out = append(out, ImportResult{
				Filename: archiveName + "/" + name,
				Status:   "error",
				Error:    err.Error(),
			})
			continue
		}
		buf := new(bytes.Buffer)
		if _, err := io.Copy(buf, rc); err != nil {
			rc.Close()
			out = append(out, ImportResult{
				Filename: archiveName + "/" + name,
				Status:   "error",
				Error:    err.Error(),
			})
			continue
		}
		rc.Close()
		res := l.ImportYAML(filepath.Base(name), buf.Bytes())
		res.Filename = archiveName + "/" + name
		out = append(out, res)
	}
	return out, nil
}

func toSlug(filename string) string {
	name := strings.TrimSuffix(filename, filepath.Ext(filename))
	name = strings.ToLower(name)
	
	var sb strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			sb.WriteRune(r)
		} else {
			sb.WriteRune('-')
		}
	}
	
	// Clean up duplicate hyphens and leading/trailing hyphens
	res := sb.String()
	for strings.Contains(res, "--") {
		res = strings.ReplaceAll(res, "--", "-")
	}
	return strings.Trim(res, "-")
}
