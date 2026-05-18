package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/codeci/codeci/server/auth"
	dbpkg "github.com/codeci/codeci/server/db"
)

// apiKeyInfo is the redacted form of an APIKey. The plaintext value is
// only ever included in the response of the create endpoint — once.
type apiKeyInfo struct {
	ID         uint       `json:"id"`
	UserID     uint       `json:"user_id"`
	Username   string     `json:"username"`
	Name       string     `json:"name"`
	PrefixHint string     `json:"prefix_hint"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
}

func (h *Handler) apiKeyToInfo(k dbpkg.APIKey) apiKeyInfo {
	info := apiKeyInfo{
		ID:         k.ID,
		UserID:     k.UserID,
		Name:       k.Name,
		PrefixHint: k.PrefixHint,
		CreatedAt:  k.CreatedAt,
		LastUsedAt: k.LastUsedAt,
		RevokedAt:  k.RevokedAt,
		ExpiresAt:  k.ExpiresAt,
	}
	var u dbpkg.User
	if err := h.db.Select("username").First(&u, k.UserID).Error; err == nil {
		info.Username = u.Username
	}
	return info
}

// --- Self-service: /api/me/api-keys ---

// GET /api/me/api-keys — list the caller's own API keys.
func (h *Handler) ListMyAPIKeys(c echo.Context) error {
	claims := auth.GetClaims(c)
	var keys []dbpkg.APIKey
	h.db.Where("user_id = ?", claims.UserID).Order("created_at desc").Find(&keys)
	out := make([]apiKeyInfo, len(keys))
	for i, k := range keys {
		out[i] = h.apiKeyToInfo(k)
	}
	return c.JSON(http.StatusOK, out)
}

// POST /api/me/api-keys — create a new key for the caller. The plaintext
// is returned in the 201 response; it is never recoverable afterward.
func (h *Handler) CreateMyAPIKey(c echo.Context) error {
	claims := auth.GetClaims(c)
	var req struct {
		Name           string `json:"name"`
		ExpiresInHours int    `json:"expires_in_hours"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "name is required")
	}
	if len(req.Name) > 64 {
		return echo.NewHTTPError(http.StatusBadRequest, "name must be 64 chars or fewer")
	}

	plaintext, hash, prefix, err := auth.GenerateAPIKey()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to generate key")
	}
	key := dbpkg.APIKey{
		UserID:     claims.UserID,
		Name:       req.Name,
		KeyHash:    hash,
		PrefixHint: prefix,
	}
	if req.ExpiresInHours > 0 {
		exp := time.Now().Add(time.Duration(req.ExpiresInHours) * time.Hour)
		key.ExpiresAt = &exp
	}
	if err := h.db.Create(&key).Error; err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to save key")
	}

	resp := h.apiKeyToInfo(key)
	return c.JSON(http.StatusCreated, echo.Map{
		"key":       resp,
		"plaintext": plaintext,
		"warning":   "Store this value now — it cannot be retrieved later.",
	})
}

// DELETE /api/me/api-keys/:id — revoke one of the caller's keys.
func (h *Handler) RevokeMyAPIKey(c echo.Context) error {
	claims := auth.GetClaims(c)
	var key dbpkg.APIKey
	q := h.db.Where("id = ? AND user_id = ?", c.Param("id"), claims.UserID)
	if err := q.First(&key).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "key not found")
	}
	if key.RevokedAt != nil {
		return c.JSON(http.StatusOK, echo.Map{"message": "already revoked"})
	}
	now := time.Now()
	h.db.Model(&key).Update("revoked_at", &now)
	return c.JSON(http.StatusOK, echo.Map{"message": "revoked"})
}

// --- Admin: /api/admin/api-keys (all users' keys) ---

// GET /api/admin/api-keys — list every API key. Optional ?user_id=<n>.
func (h *Handler) AdminListAPIKeys(c echo.Context) error {
	q := h.db.Model(&dbpkg.APIKey{})
	if uid := c.QueryParam("user_id"); uid != "" {
		q = q.Where("user_id = ?", uid)
	}
	var keys []dbpkg.APIKey
	q.Order("created_at desc").Find(&keys)
	out := make([]apiKeyInfo, len(keys))
	for i, k := range keys {
		out[i] = h.apiKeyToInfo(k)
	}
	return c.JSON(http.StatusOK, out)
}

// POST /api/admin/api-keys — mint a key on behalf of any user.
// Body: { user_id, name, expires_in_hours? }. Returns plaintext once.
func (h *Handler) AdminCreateAPIKey(c echo.Context) error {
	var req struct {
		UserID         uint   `json:"user_id"`
		Name           string `json:"name"`
		ExpiresInHours int    `json:"expires_in_hours"`
	}
	if err := c.Bind(&req); err != nil || req.UserID == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "user_id and name are required")
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "name is required")
	}
	if len(req.Name) > 64 {
		return echo.NewHTTPError(http.StatusBadRequest, "name must be 64 chars or fewer")
	}

	var user dbpkg.User
	if err := h.db.First(&user, req.UserID).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}

	plaintext, hash, prefix, err := auth.GenerateAPIKey()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to generate key")
	}
	key := dbpkg.APIKey{
		UserID:     user.ID,
		Name:       req.Name,
		KeyHash:    hash,
		PrefixHint: prefix,
	}
	if req.ExpiresInHours > 0 {
		exp := time.Now().Add(time.Duration(req.ExpiresInHours) * time.Hour)
		key.ExpiresAt = &exp
	}
	if err := h.db.Create(&key).Error; err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to save key")
	}
	return c.JSON(http.StatusCreated, echo.Map{
		"key":       h.apiKeyToInfo(key),
		"plaintext": plaintext,
		"warning":   "Store this value now — it cannot be retrieved later.",
	})
}

// DELETE /api/admin/api-keys/:id — revoke any key.
func (h *Handler) AdminRevokeAPIKey(c echo.Context) error {
	var key dbpkg.APIKey
	if err := h.db.First(&key, c.Param("id")).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "key not found")
	}
	if key.RevokedAt != nil {
		return c.JSON(http.StatusOK, echo.Map{"message": "already revoked"})
	}
	now := time.Now()
	h.db.Model(&key).Update("revoked_at", &now)
	return c.JSON(http.StatusOK, echo.Map{"message": "revoked"})
}
