package execution

import (
	"context"
	"log"
	"math/rand"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"gorm.io/gorm"

	"github.com/codeci/codeci/server/auth"
	"github.com/codeci/codeci/server/config"
	"github.com/codeci/codeci/server/pipeline"
	"github.com/codeci/codeci/server/script"
)

type ScriptHandler struct {
	db           *gorm.DB
	scriptLoader *script.Loader
	jwtSecret    string
}

func NewScriptHandler(db *gorm.DB, scriptLoader *script.Loader, cfg *config.Config) *ScriptHandler {
	return &ScriptHandler{
		db:           db,
		scriptLoader: scriptLoader,
		jwtSecret:    cfg.JWTSecret,
	}
}

// GET /ws/scripts/:id?token=<jwt>
// Runs a script in an ephemeral container; no DB history is saved.
func (h *ScriptHandler) Execute(c echo.Context) error {
	token := c.QueryParam("token")
	if token == "" {
		return echo.NewHTTPError(http.StatusUnauthorized, "missing token")
	}
	claims, err := auth.ParseJWT(token, h.jwtSecret)
	if err != nil || !claims.TOTPPassed {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid or incomplete auth")
	}

	scriptID := c.Param("id")

	// Group-based authz: visibility + scripts:run. Admins bypass.
	// Return 404 (not 403) when the script isn't visible so we don't
	// leak script IDs to non-members.
	perms := auth.LoadEffectivePermissions(h.db, claims.UserID, claims.IsAdmin)
	if !perms.IsAdmin {
		if !perms.CanSeeScript(scriptID) {
			return echo.NewHTTPError(http.StatusNotFound, "script not found")
		}
		if !perms.Has(auth.OpScriptsRun) {
			return echo.NewHTTPError(http.StatusForbidden, "missing required permission: "+auth.OpScriptsRun)
		}
	}

	filename, err := h.scriptLoader.GetFilename(scriptID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "script not found")
	}

	conn, wsErr := upgrader.Upgrade(c.Response(), c.Request(), nil)
	if wsErr != nil {
		return wsErr
	}
	defer conn.Close()
	defer wsCleanup(conn)

	stopHeartbeat := startHeartbeat(conn)
	defer close(stopHeartbeat)

	log.Printf("[WS-Script] user=%s script=%s", claims.Username, scriptID)

	send := func(msg WSMessage) {
		if err := wsSend(conn, msg); err != nil {
			log.Printf("[WS-Script] send error: %v", err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	// Scripts live at /app/user-scripts/<filename> inside the runner container
	// (same mount point as the backend container's SCRIPTS_DIR volume).
	containerPath := "/app/user-scripts/" + filename
	steps := []pipeline.Step{{Name: "Execute Script", Run: "bash " + containerPath}}

	// Pseudo-ID for container naming; high range avoids collisions with DB run IDs.
	pseudoID := uint(rand.Uint32()) | 0x80000000

	done := make(chan struct{})
	go func() {
		defer close(done)
		// Scripts only ever use docker; passing nil for the AWS clients is safe
		// because no step has runner: codebuild.
		RunSteps(ctx, nil, send, steps, pseudoID)
	}()

	clientGone := make(chan struct{})
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				close(clientGone)
				return
			}
		}
	}()

	select {
	case <-clientGone:
		cancel()
	case <-done:
	}

	return nil
}
