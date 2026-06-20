// Package files is a small, sandboxed file manager. EVERY operation is confined
// to a single root directory (the data dir). User-supplied paths are cleaned and
// containment-checked, and symlinks that resolve outside the root are rejected,
// so a request can never read or write outside the sandbox.
package files

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var (
	// ErrOutsideRoot is returned when a path would escape the sandbox.
	ErrOutsideRoot = errors.New("that location is outside the allowed area")
	// ErrNotFound is returned for a missing path.
	ErrNotFound = errors.New("not found")
	// ErrIsDir is returned when a file operation targets a directory.
	ErrIsDir = errors.New("that is a folder, not a file")
)

// Entry is a single directory listing item.
type Entry struct {
	Name     string `json:"name"`
	IsDir    bool   `json:"is_dir"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
}

// Manager sandboxes all file operations under a single root.
type Manager struct {
	root string
}

// NewManager roots the manager at the given directory (created if missing).
func NewManager(root string) (*Manager, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	return &Manager{root: abs}, nil
}

// resolve cleans a user-supplied relative path and guarantees the result stays
// inside the root — both lexically and after resolving symlinks.
func (m *Manager) resolve(rel string) (string, error) {
	// Treat rel as absolute so Clean collapses any "../" before we join — this
	// is the key defence against path-traversal.
	clean := filepath.Clean("/" + strings.ReplaceAll(rel, "\\", "/"))
	full := filepath.Join(m.root, clean)

	if !within(m.root, full) {
		return "", ErrOutsideRoot
	}
	// If the path (or its nearest existing ancestor) resolves through a symlink
	// to somewhere outside the root, reject it too.
	if real, err := filepath.EvalSymlinks(full); err == nil && !within(m.root, real) {
		return "", ErrOutsideRoot
	}
	return full, nil
}

func within(root, p string) bool {
	return p == root || strings.HasPrefix(p, root+string(os.PathSeparator))
}

// List returns the entries of a directory (folders first, then alphabetical).
func (m *Manager) List(rel string) ([]Entry, error) {
	full, err := m.resolve(rel)
	if err != nil {
		return nil, err
	}
	des, err := os.ReadDir(full)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	entries := make([]Entry, 0, len(des))
	for _, de := range des {
		info, ierr := de.Info()
		if ierr != nil {
			continue
		}
		entries = append(entries, Entry{
			Name:     de.Name(),
			IsDir:    de.IsDir(),
			Size:     info.Size(),
			Modified: info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, nil
}

// OpenFile opens a file for download. The caller closes the returned file.
func (m *Manager) OpenFile(rel string) (*os.File, os.FileInfo, error) {
	full, err := m.resolve(rel)
	if err != nil {
		return nil, nil, err
	}
	info, err := os.Stat(full)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	if info.IsDir() {
		return nil, nil, ErrIsDir
	}
	f, err := os.Open(full)
	if err != nil {
		return nil, nil, err
	}
	return f, info, nil
}

// Save writes an uploaded file into relDir under the given name.
func (m *Manager) Save(relDir, name string, r io.Reader) error {
	name = filepath.Base(name) // strip any directory components from the name
	if name == "" || name == "." || name == ".." {
		return ErrOutsideRoot
	}
	full, err := m.resolve(filepath.Join(relDir, name))
	if err != nil {
		return err
	}
	f, err := os.OpenFile(full, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, r)
	return err
}

// Mkdir creates a new folder named `name` inside relDir.
func (m *Manager) Mkdir(relDir, name string) error {
	name = filepath.Base(name)
	if name == "" || name == "." || name == ".." {
		return ErrOutsideRoot
	}
	full, err := m.resolve(filepath.Join(relDir, name))
	if err != nil {
		return err
	}
	return os.Mkdir(full, 0o755)
}

// Rename renames the item at rel to newName, within the same folder.
func (m *Manager) Rename(rel, newName string) error {
	newName = filepath.Base(newName)
	if newName == "" || newName == "." || newName == ".." {
		return ErrOutsideRoot
	}
	full, err := m.resolve(rel)
	if err != nil {
		return err
	}
	dst := filepath.Join(filepath.Dir(full), newName)
	if !within(m.root, dst) {
		return ErrOutsideRoot
	}
	return os.Rename(full, dst)
}

// Delete removes a file or folder (folders recursively). The root itself can
// never be deleted.
func (m *Manager) Delete(rel string) error {
	full, err := m.resolve(rel)
	if err != nil {
		return err
	}
	if full == m.root {
		return ErrOutsideRoot
	}
	if _, err := os.Stat(full); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	return os.RemoveAll(full)
}

// Root returns the sandbox root (for display/diagnostics).
func (m *Manager) Root() string { return m.root }
