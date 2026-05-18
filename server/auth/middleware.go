package auth

import (
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
)

type ContextKey string

const ClaimsKey ContextKey = "claims"

// RequireAuth validates the JWT and sets claims in context.
func RequireAuth(jwtSecret string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			token := extractToken(c)
			if token == "" {
				return echo.NewHTTPError(http.StatusUnauthorized, "missing token")
			}
			claims, err := ParseJWT(token, jwtSecret)
			if err != nil {
				return echo.NewHTTPError(http.StatusUnauthorized, "invalid token")
			}
			c.Set(string(ClaimsKey), claims)
			return next(c)
		}
	}
}

// RequireTOTP additionally checks that TOTP was verified this session.
// When disableTOTP is true the check is skipped (for local/dev use only).
func RequireTOTP(jwtSecret string, disableTOTP bool) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			token := extractToken(c)
			if token == "" {
				return echo.NewHTTPError(http.StatusUnauthorized, "missing token")
			}
			claims, err := ParseJWT(token, jwtSecret)
			if err != nil {
				return echo.NewHTTPError(http.StatusUnauthorized, "invalid token")
			}
			if !disableTOTP && !claims.TOTPPassed {
				return echo.NewHTTPError(http.StatusForbidden, "TOTP verification required")
			}
			c.Set(string(ClaimsKey), claims)
			return next(c)
		}
	}
}

// RequireAdmin additionally checks that the authenticated user has the admin role.
// Must be chained after RequireAuth or RequireTOTP (which set the claims).
func RequireAdmin(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		claims := GetClaims(c)
		if claims == nil {
			return echo.NewHTTPError(http.StatusUnauthorized, "unauthorized")
		}
		if !claims.IsAdmin {
			return echo.NewHTTPError(http.StatusForbidden, "admin access required")
		}
		return next(c)
	}
}

func GetClaims(c echo.Context) *Claims {
	v := c.Get(string(ClaimsKey))
	if v == nil {
		return nil
	}
	return v.(*Claims)
}

func extractToken(c echo.Context) string {
	// Authorization: Bearer <token>
	header := c.Request().Header.Get("Authorization")
	if strings.HasPrefix(header, "Bearer ") {
		return strings.TrimPrefix(header, "Bearer ")
	}
	// ?token=<token> for WebSocket
	return c.QueryParam("token")
}
