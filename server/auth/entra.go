package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/labstack/echo/v4"
	"golang.org/x/oauth2"
	"gorm.io/gorm"

	dbpkg "github.com/codeci/codeci/server/db"
)

const (
	entraStateCookie = "entra_state"
	entraStateTTL    = 10 * time.Minute
)

// EntraConfig holds the effective Entra ID OIDC configuration.
// Populated from AppSettings (DB) at request time. The DB ciphertext for the
// client secret is decrypted using TOTPEncryptionKey.
type EntraConfig struct {
	Enabled      bool
	ClientID     string
	TenantID     string
	ClientSecret string
	RedirectURL  string
}

// LoadEntraConfig reads Entra settings from the DB. Returns (cfg, enabled, err).
// When EntraEnabled is false, returns (zero, false, nil) — callers should 404/503.
func LoadEntraConfig(db *gorm.DB, encKey string) (*EntraConfig, error) {
	var s dbpkg.AppSettings
	if err := db.First(&s, 1).Error; err != nil {
		return nil, err
	}
	if !s.EntraEnabled {
		return &EntraConfig{Enabled: false}, nil
	}
	if s.EntraClientID == "" || s.EntraTenantID == "" || s.EntraClientSecret == "" || s.EntraRedirectURL == "" {
		return nil, errors.New("entra is enabled but configuration is incomplete")
	}
	secret, err := DecryptSecret(s.EntraClientSecret, encKey)
	if err != nil {
		return nil, fmt.Errorf("decrypt entra client secret: %w", err)
	}
	return &EntraConfig{
		Enabled:      true,
		ClientID:     s.EntraClientID,
		TenantID:     s.EntraTenantID,
		ClientSecret: secret,
		RedirectURL:  s.EntraRedirectURL,
	}, nil
}

// EntraHandler holds dependencies for the OIDC HTTP handlers.
type EntraHandler struct {
	db            *gorm.DB
	jwtSecret     string
	encKey        string
	sessionTTL    time.Duration
	frontendOrigin string
}

func NewEntraHandler(db *gorm.DB, jwtSecret, encKey string, sessionTTL time.Duration, frontendOrigin string) *EntraHandler {
	return &EntraHandler{
		db:             db,
		jwtSecret:      jwtSecret,
		encKey:         encKey,
		sessionTTL:     sessionTTL,
		frontendOrigin: strings.TrimRight(frontendOrigin, "/"),
	}
}

// signState returns a value of the form "<nonce>.<hmac>" so the callback
// can confirm the state nonce was issued by us without server-side storage.
func signState(nonce, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(nonce))
	return nonce + "." + hex.EncodeToString(mac.Sum(nil))
}

func verifyState(signed, secret string) (string, bool) {
	parts := strings.SplitN(signed, ".", 2)
	if len(parts) != 2 {
		return "", false
	}
	expected := signState(parts[0], secret)
	if !hmac.Equal([]byte(expected), []byte(signed)) {
		return "", false
	}
	return parts[0], true
}

func randomNonce() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (h *EntraHandler) setStateCookie(c echo.Context, value string) {
	cookie := &http.Cookie{
		Name:     entraStateCookie,
		Value:    value,
		Path:     "/api/auth/entra",
		MaxAge:   int(entraStateTTL.Seconds()),
		HttpOnly: true,
		Secure:   c.Request().TLS != nil,
		SameSite: http.SameSiteLaxMode,
	}
	http.SetCookie(c.Response(), cookie)
}

func (h *EntraHandler) clearStateCookie(c echo.Context) {
	cookie := &http.Cookie{
		Name:     entraStateCookie,
		Value:    "",
		Path:     "/api/auth/entra",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   c.Request().TLS != nil,
		SameSite: http.SameSiteLaxMode,
	}
	http.SetCookie(c.Response(), cookie)
}

// GET /api/auth/entra/login — kicks off the OIDC authorization-code flow.
func (h *EntraHandler) Login(c echo.Context) error {
	cfg, err := LoadEntraConfig(h.db, h.encKey)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "entra config error")
	}
	if !cfg.Enabled {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "entra sign-in is disabled")
	}

	nonce, err := randomNonce()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "nonce error")
	}
	state := signState(nonce, h.jwtSecret)
	h.setStateCookie(c, state)

	authURL := fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/authorize", cfg.TenantID)
	q := url.Values{}
	q.Set("client_id", cfg.ClientID)
	q.Set("response_type", "code")
	q.Set("redirect_uri", cfg.RedirectURL)
	q.Set("response_mode", "query")
	q.Set("scope", "openid profile email")
	q.Set("state", state)

	return c.Redirect(http.StatusFound, authURL+"?"+q.Encode())
}

// GET /api/auth/entra/callback — Microsoft redirects here with ?code=...&state=...
func (h *EntraHandler) Callback(c echo.Context) error {
	defer h.clearStateCookie(c)

	cfg, err := LoadEntraConfig(h.db, h.encKey)
	if err != nil || !cfg.Enabled {
		return h.redirectToLogin(c, "config_error")
	}

	queryState := c.QueryParam("state")
	cookie, err := c.Cookie(entraStateCookie)
	if err != nil || cookie.Value == "" || cookie.Value != queryState {
		return h.redirectToLogin(c, "state_mismatch")
	}
	if _, ok := verifyState(queryState, h.jwtSecret); !ok {
		return h.redirectToLogin(c, "state_invalid")
	}

	if errCode := c.QueryParam("error"); errCode != "" {
		return h.redirectToLogin(c, "provider_error")
	}
	code := c.QueryParam("code")
	if code == "" {
		return h.redirectToLogin(c, "missing_code")
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 15*time.Second)
	defer cancel()

	issuerURL := fmt.Sprintf("https://login.microsoftonline.com/%s/v2.0", cfg.TenantID)
	provider, err := oidc.NewProvider(ctx, issuerURL)
	if err != nil {
		return h.redirectToLogin(c, "provider_unreachable")
	}

	oauthCfg := &oauth2.Config{
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		Endpoint:     provider.Endpoint(),
		RedirectURL:  cfg.RedirectURL,
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}

	tok, err := oauthCfg.Exchange(ctx, code)
	if err != nil {
		return h.redirectToLogin(c, "token_exchange_failed")
	}

	rawIDToken, ok := tok.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return h.redirectToLogin(c, "missing_id_token")
	}

	verifier := provider.Verifier(&oidc.Config{ClientID: cfg.ClientID})
	idToken, err := verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return h.redirectToLogin(c, "id_token_invalid")
	}

	var claims struct {
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
		TenantID          string `json:"tid"`
		ObjectID          string `json:"oid"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return h.redirectToLogin(c, "claims_parse_failed")
	}

	if claims.TenantID != cfg.TenantID {
		return h.redirectToLogin(c, "wrong_tenant")
	}

	email := strings.ToLower(strings.TrimSpace(claims.Email))
	if email == "" {
		// Some Entra tenants only ship `preferred_username` in the ID token.
		email = strings.ToLower(strings.TrimSpace(claims.PreferredUsername))
	}
	if email == "" {
		return h.redirectToLogin(c, "no_email_claim")
	}

	var user dbpkg.User
	if err := h.db.Where("LOWER(email) = ? AND auth_provider = ?", email, "entra").First(&user).Error; err != nil {
		return h.redirectToLogin(c, "not_registered")
	}

	jwtToken, err := SignJWT(user.ID, user.Username, true, user.Role == "admin", h.jwtSecret, h.sessionTTL)
	if err != nil {
		return h.redirectToLogin(c, "token_sign_failed")
	}

	// Deliver via URL fragment — fragments aren't sent in Referer headers and
	// don't appear in server logs. The frontend page reads window.location.hash.
	target := h.frontendOrigin + "/auth/entra/callback#token=" + url.QueryEscape(jwtToken) +
		"&user=" + url.QueryEscape(user.Username) +
		"&exp=" + strconv.FormatInt(time.Now().Add(h.sessionTTL).Unix(), 10)
	return c.Redirect(http.StatusFound, target)
}

func (h *EntraHandler) redirectToLogin(c echo.Context, reason string) error {
	target := h.frontendOrigin + "/login?error=" + url.QueryEscape(reason)
	return c.Redirect(http.StatusFound, target)
}
