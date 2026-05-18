package auth

import (
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	dbpkg "github.com/codeci/codeci/server/db"
)

type Handler struct {
	db          *gorm.DB
	jwtSecret   string
	encKey      string
	disableTOTP bool
	sessionTTL  time.Duration
}

func NewHandler(db *gorm.DB, jwtSecret, encKey string, disableTOTP bool, sessionTTL time.Duration) *Handler {
	return &Handler{
		db:          db,
		jwtSecret:   jwtSecret,
		encKey:      encKey,
		disableTOTP: disableTOTP,
		sessionTTL:  sessionTTL,
	}
}

// GET /api/auth/setup — returns whether initial registration is still open
func (h *Handler) SetupStatus(c echo.Context) error {
	var count int64
	h.db.Model(&dbpkg.User{}).Count(&count)
	return c.JSON(http.StatusOK, echo.Map{"registration_open": count == 0})
}

// POST /api/auth/register — create initial admin (only if no users exist)
func (h *Handler) Register(c echo.Context) error {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.Bind(&req); err != nil || req.Username == "" || req.Password == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "username and password required")
	}

	var count int64
	h.db.Model(&dbpkg.User{}).Count(&count)
	if count > 0 {
		return echo.NewHTTPError(http.StatusForbidden, "registration is closed")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to hash password")
	}

	user := dbpkg.User{
		Username: req.Username,
		PassHash: string(hash),
		Role:     "admin", // first user is always admin
	}
	if err := h.db.Create(&user).Error; err != nil {
		return echo.NewHTTPError(http.StatusConflict, "user already exists")
	}

	return c.JSON(http.StatusCreated, echo.Map{"message": "user created"})
}

// POST /api/auth/login
func (h *Handler) Login(c echo.Context) error {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.Bind(&req); err != nil || req.Username == "" || req.Password == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "username and password required")
	}

	var user dbpkg.User
	if err := h.db.Where("username = ?", req.Username).First(&user).Error; err != nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid credentials")
	}

	if user.AuthProvider == "entra" {
		return echo.NewHTTPError(http.StatusBadRequest, "this account uses Microsoft sign-in")
	}

	if user.PassHash == "" {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid credentials")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PassHash), []byte(req.Password)); err != nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid credentials")
	}

	isAdmin := user.Role == "admin"

	if user.TOTPEnabled && !h.disableTOTP {
		// Phase-1 token: totpPassed=false, short TTL; TOTP verify upgrades to phase-2
		token, err := SignJWT(user.ID, user.Username, false, isAdmin, h.jwtSecret, 10*time.Minute)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "token error")
		}
		return c.JSON(http.StatusOK, echo.Map{
			"token":               token,
			"totp_enabled":        true,
			"must_change_password": user.MustChangePassword,
		})
	}

	// TOTP not set up → issue phase-2 JWT directly (TOTP is optional)
	token, err := SignJWT(user.ID, user.Username, true, isAdmin, h.jwtSecret, h.sessionTTL)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "token error")
	}
	return c.JSON(http.StatusOK, echo.Map{
		"token":               token,
		"totp_enabled":        false,
		"must_change_password": user.MustChangePassword,
	})
}

// POST /api/auth/totp/setup — generate secret + QR for this user
func (h *Handler) TOTPSetup(c echo.Context) error {
	claims := GetClaims(c)
	if claims == nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "unauthorized")
	}

	var user dbpkg.User
	if err := h.db.First(&user, claims.UserID).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}

	issuer := "Codeci"
	var s dbpkg.AppSettings
	if err := h.db.Select("application_name").First(&s, 1).Error; err == nil && s.ApplicationName != "" {
		issuer = s.ApplicationName
	}

	key, qrB64, err := GenerateTOTP(user.Username, issuer)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "totp generation failed")
	}

	encSecret, err := EncryptSecret(key.Secret(), h.encKey)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "encryption failed")
	}

	user.TOTPSecret = encSecret
	user.TOTPEnabled = false // enabled only after first verify
	if err := h.db.Save(&user).Error; err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "db error")
	}

	return c.JSON(http.StatusOK, echo.Map{
		"qr_image":    qrB64,
		"otpauth_url": key.URL(),
	})
}

// POST /api/auth/totp/verify
func (h *Handler) TOTPVerify(c echo.Context) error {
	claims := GetClaims(c)
	if claims == nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "unauthorized")
	}

	var req struct {
		Code string `json:"code"`
	}
	if err := c.Bind(&req); err != nil || req.Code == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "code required")
	}

	var user dbpkg.User
	if err := h.db.First(&user, claims.UserID).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}

	if user.TOTPSecret == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "TOTP not set up")
	}

	valid, err := ValidateTOTP(req.Code, user.TOTPSecret, h.encKey)
	if err != nil || !valid {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid TOTP code")
	}

	// Mark enabled on first successful verify
	if !user.TOTPEnabled {
		user.TOTPEnabled = true
		h.db.Save(&user)
	}

	// Phase-2 token: totpPassed=true, full TTL
	token, err := SignJWT(user.ID, user.Username, true, user.Role == "admin", h.jwtSecret, h.sessionTTL)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "token error")
	}

	return c.JSON(http.StatusOK, echo.Map{"token": token})
}

// DELETE /api/auth/totp — disable TOTP for current user
func (h *Handler) TOTPDisable(c echo.Context) error {
	claims := GetClaims(c)
	if claims == nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "unauthorized")
	}

	h.db.Model(&dbpkg.User{}).Where("id = ?", claims.UserID).Updates(map[string]any{
		"totp_enabled": false,
		"totp_secret":  "",
	})

	return c.JSON(http.StatusOK, echo.Map{"message": "TOTP disabled"})
}

// PUT /api/auth/password — change own password
func (h *Handler) ChangePassword(c echo.Context) error {
	claims := GetClaims(c)
	if claims == nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "unauthorized")
	}

	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := c.Bind(&req); err != nil || req.CurrentPassword == "" || req.NewPassword == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "current_password and new_password required")
	}
	if len(req.NewPassword) < 8 {
		return echo.NewHTTPError(http.StatusBadRequest, "new password must be at least 8 characters")
	}

	var user dbpkg.User
	if err := h.db.First(&user, claims.UserID).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}

	if user.AuthProvider == "entra" {
		return echo.NewHTTPError(http.StatusBadRequest, "Entra-managed accounts have no password")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PassHash), []byte(req.CurrentPassword)); err != nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "current password is incorrect")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), 12)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to hash password")
	}

	h.db.Model(&user).Updates(map[string]any{
		"pass_hash":            string(hash),
		"must_change_password": false,
	})

	return c.JSON(http.StatusOK, echo.Map{"message": "password changed"})
}
