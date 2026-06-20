// Package settings stores platform-level toggles that must be enforced on the
// server (not just hidden in the UI) — in particular the web-terminal switches,
// which gate access to a powerful, dangerous capability. Persisted to
// <dataDir>/config/settings.json.
package settings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// Settings holds the server-enforced platform flags. Defaults are the safe
// (off) values.
type Settings struct {
	// WebTerminal enables the per-app web terminal (docker exec into a container).
	WebTerminal bool `json:"web_terminal"`
	// RootTerminal enables the root web terminal (a shell inside the core container).
	RootTerminal bool `json:"root_terminal"`
}

// Store persists and guards Settings. Safe for concurrent use.
type Store struct {
	path string
	mu   sync.RWMutex
	cur  Settings
}

// NewStore loads settings from <dataDir>/config/settings.json (missing file =
// defaults).
func NewStore(dataDir string) (*Store, error) {
	dir := filepath.Join(dataDir, "config")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "settings.json")}
	s.load()
	return s, nil
}

func (s *Store) load() {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) || err != nil {
		return // defaults
	}
	var cur Settings
	if json.Unmarshal(data, &cur) == nil {
		s.cur = cur
	}
}

// Get returns a copy of the current settings.
func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur
}

// Set replaces the settings and persists them atomically.
func (s *Store) Set(next Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	s.cur = next
	return nil
}
