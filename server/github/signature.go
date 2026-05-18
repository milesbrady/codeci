package github

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// VerifySignature checks the GitHub `X-Hub-Signature-256` header against
// an HMAC-SHA256 of the raw request body using the shared webhook secret.
// Returns false for empty / malformed inputs so the caller can simply 401
// on a false return.
//
// The header format is "sha256=<hex-digest>".
func VerifySignature(payload []byte, header, secret string) bool {
	if secret == "" || header == "" {
		return false
	}
	parts := strings.SplitN(header, "=", 2)
	if len(parts) != 2 || parts[0] != "sha256" {
		return false
	}
	want, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	return hmac.Equal(mac.Sum(nil), want)
}
