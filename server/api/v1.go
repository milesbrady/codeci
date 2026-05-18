package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"gorm.io/gorm"

	"github.com/codeci/codeci/server/auth"
	"github.com/codeci/codeci/server/config"
	dbpkg "github.com/codeci/codeci/server/db"
	"github.com/codeci/codeci/server/execution"
	"github.com/codeci/codeci/server/pipeline"
	"github.com/codeci/codeci/server/script"
)

// V1Handler hosts the /api/v1/* surface designed for programmatic use
// (CI systems, LLM agents). Endpoints return self-describing payloads
// with parameter schemas so agents can discover capabilities, then
// trigger runs and poll status without WebSocket support.
type V1Handler struct {
	db           *gorm.DB
	loader       *pipeline.Loader
	scriptLoader *script.Loader
	cfg          *config.Config
	registry     *execution.RunRegistry
	scheduler    *execution.Scheduler
	awsClients   execution.CodeBuildClients
	version      string
}

func NewV1Handler(
	database *gorm.DB,
	loader *pipeline.Loader,
	scriptLoader *script.Loader,
	cfg *config.Config,
	registry *execution.RunRegistry,
	scheduler *execution.Scheduler,
	awsClients execution.CodeBuildClients,
	version string,
) *V1Handler {
	return &V1Handler{
		db:           database,
		loader:       loader,
		scriptLoader: scriptLoader,
		cfg:          cfg,
		registry:     registry,
		scheduler:    scheduler,
		awsClients:   awsClients,
		version:      version,
	}
}

// --- Discovery ---

// GET /api/v1/health — unauthenticated probe used by load balancers
// and agents that want to verify base URL + version before authenticating.
func (h *V1Handler) Health(c echo.Context) error {
	return c.JSON(http.StatusOK, echo.Map{
		"status":  "ok",
		"version": h.version,
		"time":    time.Now().UTC().Format(time.RFC3339),
	})
}

// GET /api/v1/me — confirms the API key is valid and shows which user
// it belongs to. Helpful for agents to verify scope (admin vs user).
func (h *V1Handler) Me(c echo.Context) error {
	claims := auth.GetClaims(c)
	return c.JSON(http.StatusOK, echo.Map{
		"user_id":  claims.UserID,
		"username": claims.Username,
		"is_admin": claims.IsAdmin,
	})
}

// --- Pipelines ---

type v1PipelineSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version"`
	ParamCount  int    `json:"param_count"`
}

// GET /api/v1/pipelines — terse list for discovery. LLM agent reads
// this first to find the pipeline of interest, then calls
// GET /api/v1/pipelines/:id for full parameter schema before triggering.
func (h *V1Handler) ListPipelines(c echo.Context) error {
	pipelines, err := h.loader.List()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to load pipelines")
	}
	out := make([]v1PipelineSummary, len(pipelines))
	for i, p := range pipelines {
		out[i] = v1PipelineSummary{
			ID:          p.ID,
			Name:        p.Name,
			Description: p.Description,
			Version:     p.Version,
			ParamCount:  len(p.Parameters),
		}
	}
	return c.JSON(http.StatusOK, echo.Map{"pipelines": out})
}

// GET /api/v1/pipelines/:id — full pipeline detail with parameter
// schema, including which params are required, their types, and
// default values. This is the agent's "tool schema" for the pipeline.
func (h *V1Handler) GetPipeline(c echo.Context) error {
	p, err := h.loader.Get(c.Param("id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "pipeline not found")
	}
	return c.JSON(http.StatusOK, echo.Map{
		"id":          p.ID,
		"name":        p.Name,
		"description": p.Description,
		"version":     p.Version,
		"parameters":  p.Parameters,
		"step_count":  len(p.Steps),
	})
}

// --- Runs ---

type v1RunRequest struct {
	Params map[string]string `json:"params"`
}

type v1RunResponse struct {
	RunID        uint      `json:"run_id"`
	PipelineID   string    `json:"pipeline_id"`
	PipelineName string    `json:"pipeline_name"`
	Status       string    `json:"status"`
	StartedAt    time.Time `json:"started_at"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
	DurationMS   int64     `json:"duration_ms"`
	ExitCode     *int      `json:"exit_code,omitempty"`
	FailedStep   string    `json:"failed_step,omitempty"`
	FailureReason string   `json:"failure_reason,omitempty"`
	LogsURL      string    `json:"logs_url"`
	StatusURL    string    `json:"status_url"`
	CancelURL    string    `json:"cancel_url,omitempty"`
}

// POST /api/v1/pipelines/:id/runs — trigger a new run. Returns
// immediately with the run_id and follow-up URLs the agent should poll.
// If ?wait=true is passed, blocks (up to timeout_seconds, default 300)
// until the run finishes, then returns the terminal state inline.
func (h *V1Handler) TriggerRun(c echo.Context) error {
	claims := auth.GetClaims(c)
	pipelineID := c.Param("id")

	p, err := h.loader.Get(pipelineID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "pipeline not found")
	}

	var req v1RunRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if req.Params == nil {
		req.Params = map[string]string{}
	}

	// Validate required parameters early so the agent gets a clear 400
	// instead of a successful-looking run that immediately fails.
	for _, param := range p.Parameters {
		if param.Required {
			if v, ok := req.Params[param.ID]; !ok || strings.TrimSpace(v) == "" {
				return echo.NewHTTPError(http.StatusBadRequest, fmt.Sprintf("missing required parameter %q", param.ID))
			}
		}
	}

	runID, _, err := h.scheduler.Submit(execution.StartRunOpts{
		Pipeline: *p,
		Params:   req.Params,
		UserID:   claims.UserID,
		Username: claims.Username,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}

	wait := strings.EqualFold(c.QueryParam("wait"), "true")
	timeoutSeconds := 300
	if v := c.QueryParam("timeout_seconds"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 3600 {
			timeoutSeconds = n
		}
	}

	if wait {
		// Wait on the ActiveRun's Done channel. For queued runs the channel
		// is reused across promotion, so waiting also handles the queue
		// transparently.
		if activeRun, ok := h.registry.Get(runID); ok {
			select {
			case <-activeRun.Done:
			case <-time.After(time.Duration(timeoutSeconds) * time.Second):
			case <-c.Request().Context().Done():
			}
		}
	}

	return c.JSON(http.StatusAccepted, h.runResponseFromID(c, runID))
}

func (h *V1Handler) runResponseFromID(c echo.Context, runID uint) v1RunResponse {
	var run dbpkg.ExecutionRun
	_ = h.db.First(&run, runID).Error
	return h.runResponse(c, run)
}

func (h *V1Handler) runResponse(c echo.Context, run dbpkg.ExecutionRun) v1RunResponse {
	base := fmt.Sprintf("/api/v1/runs/%d", run.ID)
	resp := v1RunResponse{
		RunID:        run.ID,
		PipelineID:   run.PipelineID,
		PipelineName: run.PipelineName,
		Status:       run.Status,
		StartedAt:    run.StartedAt,
		FinishedAt:   run.FinishedAt,
		LogsURL:      base + "/logs",
		StatusURL:    base,
	}
	if run.Status == "running" || run.Status == "queued" {
		resp.CancelURL = base + "/cancel"
	}
	if run.FinishedAt != nil {
		resp.DurationMS = run.FinishedAt.Sub(run.StartedAt).Milliseconds()
	} else {
		resp.DurationMS = time.Since(run.StartedAt).Milliseconds()
	}
	// Surface exit_code, failed step, and reason from the persisted log JSON.
	// Cheap to parse once on completion; running / queued runs return no
	// exit data.
	if run.Status != "running" && run.Status != "queued" && run.LogsJSON != "" {
		var msgs []execution.WSMessage
		if err := json.Unmarshal([]byte(run.LogsJSON), &msgs); err == nil {
			for i := len(msgs) - 1; i >= 0; i-- {
				if msgs[i].Type == execution.MsgExit {
					if msgs[i].Code != nil {
						resp.ExitCode = msgs[i].Code
					}
					if msgs[i].ExitInfo != nil {
						resp.FailedStep = msgs[i].ExitInfo.FailedStep
						resp.FailureReason = msgs[i].ExitInfo.Reason
					}
					break
				}
			}
		}
	}
	return resp
}

// GET /api/v1/runs — paginated list of the caller's runs (admins see all).
// Query params: page, limit (default 50, max 200), status (optional filter),
// pipeline_id (optional filter).
func (h *V1Handler) ListRuns(c echo.Context) error {
	claims := auth.GetClaims(c)

	page, _ := strconv.Atoi(c.QueryParam("page"))
	if page < 1 {
		page = 1
	}
	limit, _ := strconv.Atoi(c.QueryParam("limit"))
	if limit < 1 || limit > 200 {
		limit = 50
	}

	q := h.db.Model(&dbpkg.ExecutionRun{})
	if !claims.IsAdmin {
		q = q.Where("user_id = ?", claims.UserID)
	}
	if status := c.QueryParam("status"); status != "" {
		q = q.Where("status = ?", status)
	}
	if pipelineID := c.QueryParam("pipeline_id"); pipelineID != "" {
		q = q.Where("pipeline_id = ?", pipelineID)
	}

	var total int64
	q.Count(&total)

	var runs []dbpkg.ExecutionRun
	offset := (page - 1) * limit
	q.Order("created_at desc").Limit(limit).Offset(offset).Find(&runs)

	items := make([]v1RunResponse, len(runs))
	for i, r := range runs {
		items[i] = h.runResponse(c, r)
	}

	pages := int(total) / limit
	if int(total)%limit != 0 {
		pages++
	}
	return c.JSON(http.StatusOK, echo.Map{
		"runs":  items,
		"total": total,
		"page":  page,
		"limit": limit,
		"pages": pages,
	})
}

// GET /api/v1/runs/:id — current state of a run. Agents poll this to
// detect completion. Non-admin users can only access their own runs.
func (h *V1Handler) GetRun(c echo.Context) error {
	claims := auth.GetClaims(c)
	var run dbpkg.ExecutionRun
	q := h.db.Where("id = ?", c.Param("id"))
	if !claims.IsAdmin {
		q = q.Where("user_id = ?", claims.UserID)
	}
	if err := q.First(&run).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "run not found")
	}
	return c.JSON(http.StatusOK, h.runResponse(c, run))
}

// GET /api/v1/runs/:id/logs — full logs for a run.
// ?format=text returns a plain-text concatenation suitable for piping
// into an LLM prompt; ?format=json (default) returns the structured
// message stream. ?since_seq=N filters JSON results to messages after
// that sequence number — useful for polling.
//
// ?tail=N (text mode only) returns the last N lines; ?include_stdout=false
// suppresses stdout (handy when an agent only wants step + stderr context).
func (h *V1Handler) GetRunLogs(c echo.Context) error {
	claims := auth.GetClaims(c)

	runIDStr := c.Param("id")
	id64, err := strconv.ParseUint(runIDStr, 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid run id")
	}

	// Authorize against the DB even when serving from the in-memory ring.
	var run dbpkg.ExecutionRun
	q := h.db.Select("id, user_id, status").Where("id = ?", id64)
	if !claims.IsAdmin {
		q = q.Where("user_id = ?", claims.UserID)
	}
	if err := q.First(&run).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "run not found")
	}

	var msgs []execution.WSMessage
	if activeRun, ok := h.registry.Get(uint(id64)); ok {
		msgs = activeRun.GetMessages()
	} else {
		var stored dbpkg.ExecutionRun
		if err := h.db.Select("logs_json").Where("id = ?", id64).First(&stored).Error; err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "failed to load logs")
		}
		if stored.LogsJSON != "" {
			_ = json.Unmarshal([]byte(stored.LogsJSON), &msgs)
		}
	}

	// since_seq filter applies to both formats.
	if sinceStr := c.QueryParam("since_seq"); sinceStr != "" {
		if since, err := strconv.ParseInt(sinceStr, 10, 64); err == nil {
			filtered := msgs[:0:0]
			for _, m := range msgs {
				if m.Seq > since {
					filtered = append(filtered, m)
				}
			}
			msgs = filtered
		}
	}

	format := c.QueryParam("format")
	if format == "text" {
		includeStdout := !strings.EqualFold(c.QueryParam("include_stdout"), "false")
		var b strings.Builder
		for _, m := range msgs {
			switch m.Type {
			case execution.MsgStep:
				b.WriteString(fmt.Sprintf("\n--- step: %s ---\n", m.Data))
			case execution.MsgStdout:
				if includeStdout {
					b.WriteString(m.Data)
				}
			case execution.MsgStderr:
				b.WriteString(m.Data)
			case execution.MsgError:
				b.WriteString("[error] " + m.Data + "\n")
			case execution.MsgExit:
				code := 0
				if m.Code != nil {
					code = *m.Code
				}
				b.WriteString(fmt.Sprintf("\n[exit code=%d]\n", code))
				if m.ExitInfo != nil && m.ExitInfo.Reason != "" {
					b.WriteString("[reason] " + m.ExitInfo.Reason + "\n")
				}
			}
		}
		out := b.String()
		if tailStr := c.QueryParam("tail"); tailStr != "" {
			if n, err := strconv.Atoi(tailStr); err == nil && n > 0 {
				lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
				if n < len(lines) {
					out = strings.Join(lines[len(lines)-n:], "\n") + "\n"
				}
			}
		}
		return c.String(http.StatusOK, out)
	}

	// Compute a forward cursor so the agent can keep polling efficiently.
	var maxSeq int64
	for _, m := range msgs {
		if m.Seq > maxSeq {
			maxSeq = m.Seq
		}
	}
	return c.JSON(http.StatusOK, echo.Map{
		"run_id":     id64,
		"status":     run.Status,
		"messages":   msgs,
		"next_since": maxSeq,
	})
}

// POST /api/v1/runs/:id/cancel — cancel an active or queued run.
func (h *V1Handler) CancelRun(c echo.Context) error {
	claims := auth.GetClaims(c)
	q := h.db.Where("id = ? AND status IN ?", c.Param("id"), []string{"running", "queued"})
	if !claims.IsAdmin {
		q = q.Where("user_id = ?", claims.UserID)
	}
	var run dbpkg.ExecutionRun
	if err := q.First(&run).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "active run not found")
	}
	if run.Status == "queued" {
		if !h.scheduler.CancelQueued(run.ID) {
			return echo.NewHTTPError(http.StatusBadRequest, "queued run could not be cancelled")
		}
		return c.JSON(http.StatusOK, echo.Map{"run_id": run.ID, "status": "cancelled"})
	}
	activeRun, ok := h.registry.Get(run.ID)
	if !ok {
		return echo.NewHTTPError(http.StatusBadRequest, "run is not in active registry")
	}
	activeRun.Cancel()
	return c.JSON(http.StatusOK, echo.Map{"run_id": run.ID, "status": "cancellation_requested"})
}

// --- Scripts (read-only on v1; trigger isn't exposed yet) ---

// GET /api/v1/scripts — list user scripts so agents can discover their IDs.
func (h *V1Handler) ListScripts(c echo.Context) error {
	scripts, err := h.scriptLoader.List()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to load scripts")
	}
	if scripts == nil {
		scripts = []script.Script{}
	}
	return c.JSON(http.StatusOK, echo.Map{"scripts": scripts})
}

// --- OpenAPI spec ---

// GET /api/v1/openapi.json — served unauthenticated so agents can read
// the schema before they have credentials. Static; generated by hand in
// docs.go (no runtime data interpolated).
func (h *V1Handler) OpenAPI(c echo.Context) error {
	return c.JSONBlob(http.StatusOK, openAPISpec(h.version))
}

