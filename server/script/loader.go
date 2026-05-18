package script

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type Script struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ScriptDetail struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Content string `json:"content"`
}

type Loader struct {
	dir string
}

func NewLoader(dir string) *Loader {
	return &Loader{dir: dir}
}

func (l *Loader) List() ([]Script, error) {
	entries, err := os.ReadDir(l.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Script{}, nil
		}
		return nil, fmt.Errorf("reading scripts dir: %w", err)
	}

	type entry struct {
		s       Script
		modTime time.Time
	}
	var items []entry
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sh") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		id := toSlug(e.Name())
		items = append(items, entry{
			s:       Script{ID: id, Name: idToName(id)},
			modTime: info.ModTime(),
		})
	}
	// Newest first by file modification time.
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].modTime.After(items[j].modTime)
	})
	scripts := make([]Script, len(items))
	for i, it := range items {
		scripts[i] = it.s
	}
	return scripts, nil
}

func (l *Loader) Get(id string) (*ScriptDetail, error) {
	filename, err := l.findFile(id)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(filepath.Join(l.dir, filename))
	if err != nil {
		return nil, err
	}

	return &ScriptDetail{
		ID:      id,
		Name:    idToName(id),
		Content: string(data),
	}, nil
}

// GetFilename returns the bare filename (no directory) for a script ID.
// The container path is /app/user-scripts/<filename>.
func (l *Loader) GetFilename(id string) (string, error) {
	return l.findFile(id)
}

// ExportZip writes a zip archive of every .sh script in the directory to w.
// Each entry preserves its original filename and modification time. A missing
// scripts directory is treated as empty rather than an error.
func (l *Loader) ExportZip(w io.Writer) error {
	entries, err := os.ReadDir(l.dir)
	if err != nil {
		if os.IsNotExist(err) {
			zw := zip.NewWriter(w)
			return zw.Close()
		}
		return fmt.Errorf("reading scripts dir: %w", err)
	}

	zw := zip.NewWriter(w)
	defer zw.Close()

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sh") {
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
		slug = "script"
	}

	filename := slug + ".sh"
	if _, err := os.Stat(filepath.Join(l.dir, filename)); err == nil {
		filename = fmt.Sprintf("%s-%x.sh", slug, time.Now().Unix()%0xFFF)
	}

	if err := os.MkdirAll(l.dir, 0755); err != nil {
		return "", fmt.Errorf("creating scripts dir: %w", err)
	}

	path := filepath.Join(l.dir, filename)
	if err := os.WriteFile(path, []byte(content), 0755); err != nil {
		return "", err
	}

	return toSlug(filename), nil
}

func (l *Loader) Update(id string, content string) error {
	filename, err := l.findFile(id)
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(l.dir, filename), []byte(content), 0755)
}

func (l *Loader) Delete(id string) error {
	filename, err := l.findFile(id)
	if err != nil {
		return err
	}
	return os.Remove(filepath.Join(l.dir, filename))
}

func (l *Loader) findFile(id string) (string, error) {
	if strings.Contains(id, "/") || strings.Contains(id, "..") {
		return "", fmt.Errorf("invalid script id")
	}

	entries, err := os.ReadDir(l.dir)
	if err != nil {
		return "", fmt.Errorf("script not found: %s", id)
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sh") && toSlug(e.Name()) == id {
			return e.Name(), nil
		}
	}
	return "", fmt.Errorf("script not found: %s", id)
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

	res := sb.String()
	for strings.Contains(res, "--") {
		res = strings.ReplaceAll(res, "--", "-")
	}
	return strings.Trim(res, "-")
}

func idToName(id string) string {
	words := strings.Split(id, "-")
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}
