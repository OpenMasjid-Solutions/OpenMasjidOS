package auth

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// ErrAlreadySetup is returned when Setup is called but an admin already exists.
var ErrAlreadySetup = errors.New("admin account already exists")

// credentials is the on-disk shape of auth.json. The password is stored only
// as an argon2id hash — plaintext never touches disk.
type credentials struct {
	Username string `json:"username"`
	Hash     string `json:"hash"`
}

// Store persists and guards the single admin credential set. It is safe for
// concurrent use.
type Store struct {
	path  string
	mu    sync.RWMutex
	creds *credentials
}

// NewStore opens (or prepares) the credential store under <dataDir>/config/auth.json.
// The config directory is created with 0700 if missing. A missing auth.json is
// not an error — it simply means setup has not happened yet.
func NewStore(dataDir string) (*Store, error) {
	dir := filepath.Join(dataDir, "config")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating config dir: %w", err)
	}
	s := &Store{path: filepath.Join(dir, "auth.json")}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil // not set up yet
	}
	if err != nil {
		return fmt.Errorf("reading auth.json: %w", err)
	}
	var c credentials
	if err := json.Unmarshal(data, &c); err != nil {
		return fmt.Errorf("parsing auth.json: %w", err)
	}
	s.creds = &c
	return nil
}

// IsSetup reports whether an admin account exists.
func (s *Store) IsSetup() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.creds != nil && s.creds.Username != "" && s.creds.Hash != ""
}

// Username returns the admin username, or "" if not set up.
func (s *Store) Username() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.creds == nil {
		return ""
	}
	return s.creds.Username
}

// Setup creates the admin account. It fails with ErrAlreadySetup if one exists,
// so the first-run endpoint can never be used to overwrite credentials.
func (s *Store) Setup(username, password string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.creds != nil {
		return ErrAlreadySetup
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	c := &credentials{Username: username, Hash: hash}
	if err := s.save(c); err != nil {
		return err
	}
	s.creds = c
	return nil
}

// save writes auth.json atomically (temp file + rename) with 0600 perms.
func (s *Store) save(c *credentials) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("writing auth.json: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("saving auth.json: %w", err)
	}
	return nil
}

// Verify reports whether the given username + password match the stored admin.
// The username comparison is constant-time and the password check always runs
// the argon2 verification path when a hash exists, limiting timing oracles.
func (s *Store) Verify(username, password string) bool {
	s.mu.RLock()
	creds := s.creds
	s.mu.RUnlock()
	if creds == nil {
		return false
	}
	userMatch := subtle.ConstantTimeCompare([]byte(username), []byte(creds.Username)) == 1
	ok, err := VerifyPassword(password, creds.Hash)
	if err != nil {
		return false
	}
	return ok && userMatch
}
