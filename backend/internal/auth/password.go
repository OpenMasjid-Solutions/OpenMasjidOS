// Package auth handles the single-admin account: password hashing (argon2id),
// credential storage, and session management. See docs/ARCHITECTURE.md §7.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// ErrInvalidHash is returned when a stored hash string is malformed.
var ErrInvalidHash = errors.New("invalid password hash format")

// argonParams holds the argon2id cost parameters. Defaults follow the OWASP
// Password Storage Cheat Sheet (64 MB memory, 3 iterations, 2 lanes).
type argonParams struct {
	memory  uint32 // KiB
	time    uint32 // iterations
	threads uint8  // parallelism
	keyLen  uint32 // output length in bytes
	saltLen uint32 // salt length in bytes
}

var defaultParams = argonParams{
	memory:  64 * 1024,
	time:    3,
	threads: 2,
	keyLen:  32,
	saltLen: 16,
}

// HashPassword hashes a plaintext password with argon2id and returns a PHC
// formatted string that encodes the version, parameters, salt, and digest:
//
//	$argon2id$v=19$m=65536,t=3,p=2$<b64-salt>$<b64-hash>
func HashPassword(password string) (string, error) {
	salt := make([]byte, defaultParams.saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generating salt: %w", err)
	}

	hash := argon2.IDKey(
		[]byte(password), salt,
		defaultParams.time, defaultParams.memory, defaultParams.threads, defaultParams.keyLen,
	)

	encoded := fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, defaultParams.memory, defaultParams.time, defaultParams.threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash),
	)
	return encoded, nil
}

// VerifyPassword reports whether password matches the given PHC-encoded hash.
// The comparison is constant-time. Parameters are read from the encoded string
// so hashes created with different costs still verify.
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	// Expected: ["", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash]
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrInvalidHash
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false, ErrInvalidHash
	}
	if version != argon2.Version {
		return false, ErrInvalidHash
	}

	var p argonParams
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.memory, &p.time, &p.threads); err != nil {
		return false, ErrInvalidHash
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, ErrInvalidHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, ErrInvalidHash
	}
	p.keyLen = uint32(len(want))

	got := argon2.IDKey([]byte(password), salt, p.time, p.memory, p.threads, p.keyLen)
	if subtle.ConstantTimeCompare(got, want) == 1 {
		return true, nil
	}
	return false, nil
}
