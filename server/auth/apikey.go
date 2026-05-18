package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"gorm.io/gorm"

	dbpkg "github.com/codeci/codeci/server/db"
)

// APIKeyPrefix marks tokens this server has issued. Auth code splits on
// the prefix to distinguish API keys from JWTs; clients see it in their
// keys (idk_<32 random bytes>) so accidental disclosure is recognizable.
const APIKeyPrefix = "idk_"

// GenerateAPIKey returns a freshly-minted bearer token plus its SHA-256
// hash (for storage) and the 12-char prefix hint (for display).
func GenerateAPIKey() (plaintext, hash, prefixHint string, err error) {
	buf := make([]byte, 32)
	if _, err = rand.Read(buf); err != nil {
		return "", "", "", err
	}
	plaintext = APIKeyPrefix + hex.EncodeToString(buf)
	hash = hashAPIKey(plaintext)
	if len(plaintext) > 12 {
		prefixHint = plaintext[:12]
	} else {
		prefixHint = plaintext
	}
	return plaintext, hash, prefixHint, nil
}

func hashAPIKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// extractBearer pulls a bearer token from the Authorization header or
// from the X-API-Key header (which some HTTP clients reach for first).
func extractBearer(c echo.Context) string {
	if h := c.Request().Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	if h := c.Request().Header.Get("X-API-Key"); h != "" {
		return h
	}
	return c.QueryParam("token")
}

// RequireAPIKeyOrJWT accepts either a JWT (TOTP-passed) or an API key.
// API-key auth bypasses TOTP — the key is already a long-lived secret,
// and the user opted in by minting it. On success, sets ClaimsKey in the
// echo context so handlers using auth.GetClaims() keep working unchanged.
func RequireAPIKeyOrJWT(jwtSecret string, disableTOTP bool, database *gorm.DB) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			token := extractBearer(c)
			if token == "" {
				return echo.NewHTTPError(http.StatusUnauthorized, "missing token")
			}

			if strings.HasPrefix(token, APIKeyPrefix) {
				claims, err := authenticateAPIKey(token, database)
				if err != nil {
					return echo.NewHTTPError(http.StatusUnauthorized, err.Error())
				}
				c.Set(string(ClaimsKey), claims)
				c.Set("auth_method", "api_key")
				return next(c)
			}

			claims, err := ParseJWT(token, jwtSecret)
			if err != nil {
				return echo.NewHTTPError(http.StatusUnauthorized, "invalid token")
			}
			if !disableTOTP && !claims.TOTPPassed {
				return echo.NewHTTPError(http.StatusForbidden, "TOTP verification required")
			}
			c.Set(string(ClaimsKey), claims)
			c.Set("auth_method", "jwt")
			return next(c)
		}
	}
}

func authenticateAPIKey(token string, database *gorm.DB) (*Claims, error) {
	hash := hashAPIKey(token)
	var key dbpkg.APIKey
	if err := database.Where("key_hash = ?", hash).First(&key).Error; err != nil {
		return nil, errInvalidAPIKey
	}
	if key.RevokedAt != nil {
		return nil, errRevokedAPIKey
	}
	if key.ExpiresAt != nil && time.Now().After(*key.ExpiresAt) {
		return nil, errExpiredAPIKey
	}

	var user dbpkg.User
	if err := database.First(&user, key.UserID).Error; err != nil {
		return nil, errInvalidAPIKey
	}

	// Touch last_used_at asynchronously — the request shouldn't wait on this.
	go func(id uint) {
		now := time.Now()
		database.Model(&dbpkg.APIKey{}).Where("id = ?", id).Update("last_used_at", &now)
	}(key.ID)

	return &Claims{
		UserID:     user.ID,
		Username:   user.Username,
		TOTPPassed: true, // API keys are post-TOTP by design
		IsAdmin:    user.Role == "admin",
	}, nil
}

var (
	errInvalidAPIKey = echo.NewHTTPError(http.StatusUnauthorized, "invalid api key")
	errRevokedAPIKey = echo.NewHTTPError(http.StatusUnauthorized, "api key has been revoked")
	errExpiredAPIKey = echo.NewHTTPError(http.StatusUnauthorized, "api key has expired")
)
