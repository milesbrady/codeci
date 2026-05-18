package execution

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
	"gorm.io/gorm"

	"github.com/codeci/codeci/server/auth"
	"github.com/codeci/codeci/server/config"
	dbpkg "github.com/codeci/codeci/server/db"
	"github.com/codeci/codeci/server/pipeline"
)

var upgrader = websocket.Upgrader{
	HandshakeTimeout: 10 * time.Second,
	CheckOrigin:      func(r *http.Request) bool { return true },
}

// MaxLogsJSONBytes caps the LogsJSON column to keep Postgres rows from
// ballooning. When a snapshot would exceed this size we drop the oldest
// messages and prepend a synthetic truncation marker before persisting.
const MaxLogsJSONBytes = 5 * 1024 * 1024 // 5 MB

type Handler struct {
	db         *gorm.DB
	loader     *pipeline.Loader
	cfg        *config.Config
	jwtSecret  string
	registry   *RunRegistry
	scheduler  *Scheduler
	awsClients CodeBuildClients
}

func NewHandler(db *gorm.DB, loader *pipeline.Loader, cfg *config.Config, registry *RunRegistry, scheduler *Scheduler, awsClients CodeBuildClients) *Handler {
	return &Handler{
		db:         db,
		loader:     loader,
		cfg:        cfg,
		jwtSecret:  cfg.JWTSecret,
		registry:   registry,
		scheduler:  scheduler,
		awsClients: awsClients,
	}
}

type runRequest struct {
	Params map[string]string `json:"params"`
	RunID  uint              `json:"run_id,omitempty"`
}

// GET /ws/execute/:pipelineId?token=<jwt>
func (h *Handler) Execute(c echo.Context) error {
	token := c.QueryParam("token")
	if token == "" {
		return echo.NewHTTPError(http.StatusUnauthorized, "missing token")
	}
	claims, err := auth.ParseJWT(token, h.jwtSecret)
	if err != nil || !claims.TOTPPassed {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid or incomplete auth")
	}

	pipelineID := c.Param("pipelineId")

	conn, err := upgrader.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	defer wsCleanup(conn)

	// 1. Initial Handshake: Read Request (Params or Re-attach RunID)
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		return nil
	}

	// Switch from handshake deadline to a ping/pong heartbeat. Without this
	// any proxy with an idle timeout (e.g. ALB at 60s) silently kills the
	// socket during long-running steps that produce no output.
	stopHeartbeat := startHeartbeat(conn)
	defer close(stopHeartbeat)

	var req runRequest
	if err := json.Unmarshal(msg, &req); err != nil {
		_ = wsSend(conn, WSMessage{Type: MsgError, Data: "invalid params JSON"})
		return nil
	}

	var activeRun *ActiveRun
	var runID uint

	if req.RunID != 0 {
		// --- RE-ATTACH SCENARIO ---
		runID = req.RunID
		log.Printf("[WS] Re-attach request for Run %d", runID)
		var isNew bool
		activeRun, isNew = h.registry.GetOrCreate(runID, "")
		if isNew {
			log.Printf("[WS] Run %d not found in memory", runID)
			h.registry.Remove(runID)
			var run dbpkg.ExecutionRun
			if err := h.db.First(&run, runID).Error; err != nil || (run.Status != "running" && run.Status != "queued") {
				_ = wsSend(conn, WSMessage{Type: MsgError, Data: "run not found or not active"})
				return nil
			}
			_ = wsSend(conn, WSMessage{Type: MsgError, Data: "run is no longer in memory (server might have restarted)"})
			return nil
		}
		// Re-attach must respect the same authz boundary as a fresh GET:
		// only the run's owner, admins, or someone with runs:read_all may
		// see its live stream.
		var ownRun dbpkg.ExecutionRun
		if err := h.db.Select("id, user_id, status").First(&ownRun, runID).Error; err == nil {
			perms := auth.LoadEffectivePermissions(h.db, claims.UserID, claims.IsAdmin)
			seeAll := perms.IsAdmin || perms.Has(auth.OpRunsReadAll)
			if !seeAll && ownRun.UserID != claims.UserID {
				_ = wsSend(conn, WSMessage{Type: MsgError, Data: "run not found or not active"})
				return nil
			}
		}
		// If the run is queued, surface that to the client before the
		// usual init/backlog so the UI can show a "waiting" banner instead
		// of an empty step tracker.
		var run dbpkg.ExecutionRun
		if err := h.db.Select("id, status, pipeline_id").First(&run, runID).Error; err == nil && run.Status == "queued" {
			pos := 0
			if h.scheduler != nil {
				pos = h.scheduler.QueuePosition(runID)
			}
			_ = wsSend(conn, WSMessage{Type: MsgQueued, RunID: runID, Data: fmt.Sprintf("Queued — position %d", pos)})
		}
		log.Printf("[WS] Successfully re-attached to Run %d (Backlog: %d msgs)", runID, len(activeRun.GetMessages()))
		_ = wsSend(conn, WSMessage{Type: MsgInit, RunID: runID})
		activeRun.Subscribe(conn, true)
	} else {
		// --- NEW RUN SCENARIO ---
		// Visibility + run-permission check. Admins bypass; everyone else
		// needs the pipeline to be visible to one of their groups AND the
		// pipelines:run operation. A failure here pretends the pipeline
		// doesn't exist rather than leaking that it does.
		perms := auth.LoadEffectivePermissions(h.db, claims.UserID, claims.IsAdmin)
		if !perms.IsAdmin {
			if !perms.CanSeePipeline(pipelineID) {
				_ = wsSend(conn, WSMessage{Type: MsgError, Data: "pipeline not found"})
				return nil
			}
			if !perms.Has(auth.OpPipelinesRun) {
				_ = wsSend(conn, WSMessage{Type: MsgError, Data: "missing permission: " + auth.OpPipelinesRun})
				return nil
			}
		}
		p, err := h.loader.Get(pipelineID)
		if err != nil {
			_ = wsSend(conn, WSMessage{Type: MsgError, Data: "pipeline not found"})
			return nil
		}

		newRunID, dispatched, err := h.scheduler.Submit(StartRunOpts{
			Pipeline: *p,
			Params:   req.Params,
			UserID:   claims.UserID,
			Username: claims.Username,
		})
		if err != nil {
			_ = wsSend(conn, WSMessage{Type: MsgError, Data: err.Error()})
			return nil
		}
		runID = newRunID
		// The scheduler always creates the ActiveRun in the registry,
		// whether the run dispatched immediately or was queued.
		ar, ok := h.registry.Get(runID)
		if !ok {
			_ = wsSend(conn, WSMessage{Type: MsgError, Data: "run not found in registry after submit"})
			return nil
		}
		activeRun = ar

		_ = wsSend(conn, WSMessage{Type: MsgInit, RunID: runID})
		if !dispatched {
			pos := h.scheduler.QueuePosition(runID)
			_ = wsSend(conn, WSMessage{Type: MsgQueued, RunID: runID, Data: fmt.Sprintf("Queued — position %d", pos)})
		}

		// Subscribe so the live stream forwards to this WS conn. The
		// scheduler's goroutines (for dispatched runs) may have started
		// before this call, but Broadcast holds ar.mu while delivering, so
		// messages emitted before Subscribe ran are still recoverable from
		// the in-memory ring on re-attach.
		activeRun.Subscribe(conn, false)
	}

	defer activeRun.Unsubscribe(conn)

	// Keep connection alive until run finishes or client disconnects
	done := make(chan struct{})
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				close(done)
				return
			}
		}
	}()

	select {
	case <-done:
		// Client disconnected — background execution continues
	case <-activeRun.Done:
		// Run finished
	}

	return nil
}

// marshalLogsCapped serializes msgs as JSON, dropping the oldest entries if
// needed to stay within MaxLogsJSONBytes. The synthetic truncation marker
// is preserved in front of whatever survives so the UI can show the user
// how many lines were dropped.
func marshalLogsCapped(msgs []WSMessage) string {
	encoded, _ := json.Marshal(msgs)
	if len(encoded) <= MaxLogsJSONBytes {
		return string(encoded)
	}

	dropped := 0
	for len(msgs) > 1 && len(encoded) > MaxLogsJSONBytes {
		// Keep the synthetic marker at index 0 (if present) and drop the
		// next entry, which is the oldest real log line.
		if msgs[0].Type == MsgStdout && len(msgs) >= 2 {
			msgs = append(msgs[:1], msgs[2:]...)
		} else {
			msgs = msgs[1:]
		}
		dropped++
		encoded, _ = json.Marshal(msgs)
	}
	if dropped > 0 {
		marker := WSMessage{Type: MsgStdout, Data: fmt.Sprintf("[truncated %d more log lines to fit DB cap]\n", dropped)}
		msgs = append([]WSMessage{marker}, msgs...)
		encoded, _ = json.Marshal(msgs)
	}
	return string(encoded)
}
