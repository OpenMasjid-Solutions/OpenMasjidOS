package auth

import (
	"crypto/rand"
	"encoding/base64"
	"sync"
	"time"
)

// Sessions is an in-memory session store (single admin, so a token→expiry map
// is sufficient). It is safe for concurrent use. Sessions use a sliding expiry:
// every successful validation extends the lifetime by the TTL.
//
// Sessions are intentionally NOT persisted across restarts in v1 — a restart
// simply requires the admin to log in again, which is acceptable for a
// single-host appliance and avoids writing session tokens to disk.
type Sessions struct {
	mu     sync.Mutex
	tokens map[string]time.Time // token -> expiry
	ttl    time.Duration
}

// NewSessions creates a session store with the given inactivity TTL.
func NewSessions(ttl time.Duration) *Sessions {
	return &Sessions{
		tokens: make(map[string]time.Time),
		ttl:    ttl,
	}
}

// Create generates a cryptographically random session token and stores it.
func (s *Sessions) Create() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(b)

	s.mu.Lock()
	s.tokens[token] = time.Now().Add(s.ttl)
	s.mu.Unlock()
	return token, nil
}

// Valid reports whether the token is a live session. Expired tokens are purged
// and treated as invalid. A valid token has its expiry extended (sliding TTL).
func (s *Sessions) Valid(token string) bool {
	if token == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	exp, ok := s.tokens[token]
	if !ok {
		return false
	}
	if time.Now().After(exp) {
		delete(s.tokens, token)
		return false
	}
	s.tokens[token] = time.Now().Add(s.ttl)
	return true
}

// Destroy removes a session token (logout).
func (s *Sessions) Destroy(token string) {
	if token == "" {
		return
	}
	s.mu.Lock()
	delete(s.tokens, token)
	s.mu.Unlock()
}
