package api

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"github.com/codeci/codeci/server/auth"
	"github.com/codeci/codeci/server/config"
	dbpkg "github.com/codeci/codeci/server/db"
	"github.com/codeci/codeci/server/execution"
	"github.com/codeci/codeci/server/pipeline"
	"github.com/codeci/codeci/server/script"
)

// completedLogsCache is a tiny LRU keyed by run ID. Completed runs are
// immutable, so once we've parsed their LogsJSON we hand back the same byte
// slice on subsequent requests instead of re-reading and re-serializing the
// whole blob from Postgres.
const completedLogsCacheSize = 16

type completedLogsEntry struct {
	runID  uint
	logs   []byte
	parsed time.Time
}

type completedLogsCache struct {
	mu      sync.Mutex
	entries []completedLogsEntry
}

func (c *completedLogsCache) get(runID uint) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, e := range c.entries {
		if e.runID == runID {
			// Move to front (most-recently-used).
			c.entries = append(append([]completedLogsEntry{e}, c.entries[:i]...), c.entries[i+1:]...)
			return e.logs, true
		}
	}
	return nil, false
}

func (c *completedLogsCache) put(runID uint, logs []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, e := range c.entries {
		if e.runID == runID {
			c.entries[i].logs = logs
			return
		}
	}
	c.entries = append([]completedLogsEntry{{runID: runID, logs: logs, parsed: time.Now()}}, c.entries...)
	if len(c.entries) > completedLogsCacheSize {
		c.entries = c.entries[:completedLogsCacheSize]
	}
}

type Handler struct {
	db           *gorm.DB
	loader       *pipeline.Loader
	scriptLoader *script.Loader
	cfg          *config.Config
	registry     *execution.RunRegistry
	scheduler    *execution.Scheduler
	logsCache    *completedLogsCache
	version      string
}

func NewHandler(db *gorm.DB, loader *pipeline.Loader, scriptLoader *script.Loader, cfg *config.Config, registry *execution.RunRegistry, scheduler *execution.Scheduler, version string) *Handler {
	return &Handler{
		db:           db,
		loader:       loader,
		scriptLoader: scriptLoader,
		cfg:          cfg,
		registry:     registry,
		scheduler:    scheduler,
		logsCache:    &completedLogsCache{},
		version:      version,
	}
}

// GET /api/pipelines
func (h *Handler) ListPipelines(c echo.Context) error {
	pipelines, err := h.loader.List()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to load pipelines")
	}
	type summary struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Version     string `json:"version"`
		ParamCount  int    `json:"param_count"`
	}
	summaries := make([]summary, len(pipelines))
	for i, p := range pipelines {
		summaries[i] = summary{
			ID:          p.ID,
			Name:        p.Name,
			Description: p.Description,
			Version:     p.Version,
			ParamCount:  len(p.Parameters),
		}
	}
	return c.JSON(http.StatusOK, summaries)
}

// GET /api/pipelines/:id
func (h *Handler) GetPipeline(c echo.Context) error {
	p, err := h.loader.Get(c.Param("id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "pipeline not found")
	}
	return c.JSON(http.StatusOK, p)
}

// GET /api/pipelines/:id/raw
func (h *Handler) GetPipelineRaw(c echo.Context) error {
	raw, err := h.loader.GetRaw(c.Param("id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "pipeline not found")
	}
	return c.JSON(http.StatusOK, echo.Map{"raw": raw})
}

// GET /api/pipelines/export — streams a zip of every pipeline YAML file.
func (h *Handler) ExportPipelines(c echo.Context) error {
	filename := fmt.Sprintf("pipelines-%s.zip", time.Now().UTC().Format("20060102-150405"))
	c.Response().Header().Set(echo.HeaderContentType, "application/zip")
	c.Response().Header().Set(echo.HeaderContentDisposition, fmt.Sprintf(`attachment; filename="%s"`, filename))
	c.Response().WriteHeader(http.StatusOK)
	if err := h.loader.ExportZip(c.Response().Writer); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to build pipelines archive")
	}
	return nil
}

// POST /api/pipelines/import — accepts multipart upload of .yaml/.yml files
// and/or .zip archives. Each file is validated against the pipeline schema
// before being written. Filename collisions are handled by adding a
// -imported-<hex> suffix; nothing on disk is overwritten.
//
// Form field "files" is repeatable. Response is a list of per-entry
// ImportResult objects so the UI can report what landed and what was
// rejected.
func (h *Handler) ImportPipelines(c echo.Context) error {
	form, err := c.MultipartForm()
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "multipart form required")
	}
	files := form.File["files"]
	if len(files) == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "no files uploaded (field name: 'files')")
	}

	const maxFileSize = 5 * 1024 * 1024 // 5 MiB per upload — pipelines are tiny YAML.
	var results []pipeline.ImportResult

	for _, fh := range files {
		name := fh.Filename
		if fh.Size > maxFileSize {
			results = append(results, pipeline.ImportResult{
				Filename: name,
				Status:   "error",
				Error:    fmt.Sprintf("file too large (%d bytes; max %d)", fh.Size, maxFileSize),
			})
			continue
		}
		f, err := fh.Open()
		if err != nil {
			results = append(results, pipeline.ImportResult{Filename: name, Status: "error", Error: err.Error()})
			continue
		}

		lower := strings.ToLower(name)
		switch {
		case strings.HasSuffix(lower, ".zip"):
			buf := make([]byte, fh.Size)
			if _, err := io.ReadFull(f, buf); err != nil {
				f.Close()
				results = append(results, pipeline.ImportResult{Filename: name, Status: "error", Error: err.Error()})
				continue
			}
			f.Close()
			zipResults, err := h.loader.ImportZipReader(name, bytes.NewReader(buf), int64(len(buf)))
			if err != nil {
				results = append(results, pipeline.ImportResult{Filename: name, Status: "error", Error: err.Error()})
				continue
			}
			if len(zipResults) == 0 {
				results = append(results, pipeline.ImportResult{
					Filename: name,
					Status:   "error",
					Error:    "zip contained no .yaml/.yml entries",
				})
				continue
			}
			results = append(results, zipResults...)

		case strings.HasSuffix(lower, ".yaml") || strings.HasSuffix(lower, ".yml"):
			data, err := io.ReadAll(f)
			f.Close()
			if err != nil {
				results = append(results, pipeline.ImportResult{Filename: name, Status: "error", Error: err.Error()})
				continue
			}
			results = append(results, h.loader.ImportYAML(name, data))

		default:
			f.Close()
			results = append(results, pipeline.ImportResult{
				Filename: name,
				Status:   "error",
				Error:    "unsupported file type (expected .yaml, .yml, or .zip)",
			})
		}
	}

	imported, renamed, errored := 0, 0, 0
	for _, r := range results {
		switch r.Status {
		case "imported":
			imported++
		case "renamed":
			renamed++
		case "error":
			errored++
		}
	}

	return c.JSON(http.StatusOK, echo.Map{
		"imported": imported,
		"renamed":  renamed,
		"errors":   errored,
		"results":  results,
	})
}

// POST /api/pipelines
func (h *Handler) CreatePipeline(c echo.Context) error {
	var req struct {
		Name string `json:"name"`
		Raw  string `json:"raw"`
	}
	if err := c.Bind(&req); err != nil || req.Name == "" || req.Raw == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "name and raw content required")
	}

	id, err := h.loader.Create(req.Name, req.Raw)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}

	return c.JSON(http.StatusCreated, echo.Map{"id": id, "message": "pipeline created"})
}

// PUT /api/pipelines/:id
func (h *Handler) UpdatePipeline(c echo.Context) error {
	var req struct {
		Raw string `json:"raw"`
	}
	if err := c.Bind(&req); err != nil || req.Raw == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "raw content required")
	}
	if err := h.loader.Update(c.Param("id"), req.Raw); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	return c.JSON(http.StatusOK, echo.Map{"message": "pipeline updated"})
}

// DELETE /api/pipelines/:id
func (h *Handler) DeletePipeline(c echo.Context) error {
	id := c.Param("id")

	// Check if any active runs (running or queued) for this pipeline
	if h.registry != nil {
		active := h.registry.List()
		for _, run := range active {
			if run.PipelineID == id {
				return echo.NewHTTPError(http.StatusBadRequest, "cannot delete pipeline with active or queued runs")
			}
		}
	}
	var queuedCount int64
	h.db.Model(&dbpkg.ExecutionRun{}).
		Where("pipeline_id = ? AND status IN ?", id, []string{"running", "queued"}).
		Count(&queuedCount)
	if queuedCount > 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "cannot delete pipeline with active or queued runs")
	}

	if err := h.loader.Delete(id); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "pipeline not found")
	}
	return c.JSON(http.StatusOK, echo.Map{"message": "pipeline deleted"})
}

// GET /api/runs — admins see all runs, users see their own.
// Pagination: ?page=1&limit=50. If page is omitted, returns all (legacy, max 500).
//
// LogsJSON is always omitted from list responses — those rows can be megabytes
// each and the listing UIs never read the logs. Per-run logs are fetched on
// demand via GET /api/runs/:id/logs.
func (h *Handler) ListRuns(c echo.Context) error {
	claims := auth.GetClaims(c)

	pageStr := c.QueryParam("page")
	limitStr := c.QueryParam("limit")

	if pageStr == "" {
		// Legacy flat-array mode — kept for back-compat. New polling clients
		// should use /api/runs/active or paginated /api/runs?page=1.
		var runs []dbpkg.ExecutionRun
		legacyQ := h.db.Omit("logs_json").Order("created_at desc").Limit(500)
		if !claims.IsAdmin {
			legacyQ = legacyQ.Where("user_id = ?", claims.UserID)
		}
		legacyQ.Find(&runs)
		return c.JSON(http.StatusOK, runs)
	}

	page := 1
	limit := 50
	if v, err := strconv.Atoi(pageStr); err == nil && v > 0 {
		page = v
	}
	if v, err := strconv.Atoi(limitStr); err == nil && v > 0 && v <= 200 {
		limit = v
	}

	var total int64
	qCount := h.db.Model(&dbpkg.ExecutionRun{})
	if !claims.IsAdmin {
		qCount = qCount.Where("user_id = ?", claims.UserID)
	}
	qCount.Count(&total)

	var runs []dbpkg.ExecutionRun
	offset := (page - 1) * limit
	qData := h.db.Omit("logs_json").Order("created_at desc").Limit(limit).Offset(offset)
	if !claims.IsAdmin {
		qData = qData.Where("user_id = ?", claims.UserID)
	}
	qData.Find(&runs)

	pages := int(total) / limit
	if int(total)%limit != 0 {
		pages++
	}
	return c.JSON(http.StatusOK, echo.Map{
		"runs":  runs,
		"total": total,
		"page":  page,
		"limit": limit,
		"pages": pages,
	})
}

// activeRunSummary is the lean shape returned by ListActiveRuns. The Layout
// sidebar badge and the ActiveRuns page poll this every few seconds, so it
// must be cheap on the wire — we deliberately exclude LogsJSON and
// ParamsJSON.
type activeRunSummary struct {
	ID           uint      `json:"ID"`
	PipelineID   string    `json:"PipelineID"`
	PipelineName string    `json:"PipelineName"`
	UserID       uint      `json:"UserID"`
	UserName     string    `json:"UserName"`
	Status       string    `json:"Status"`
	StartedAt    time.Time `json:"StartedAt"`
	CreatedAt    time.Time `json:"CreatedAt"`
}

// GET /api/runs/active — minimal list of currently active runs (running OR
// queued). Used by the sidebar badge and the Active Runs page polling loops.
// Admins see everyone's runs; users see only their own. Indexed by
// idx_runs_status_created.
func (h *Handler) ListActiveRuns(c echo.Context) error {
	claims := auth.GetClaims(c)

	var runs []activeRunSummary
	q := h.db.Model(&dbpkg.ExecutionRun{}).
		Select("id, pipeline_id, pipeline_name, user_id, user_name, status, started_at, created_at").
		Where("status IN ?", []string{"running", "queued"}).
		Order("created_at desc")
	if !claims.IsAdmin {
		q = q.Where("user_id = ?", claims.UserID)
	}
	q.Find(&runs)
	return c.JSON(http.StatusOK, runs)
}

// GET /api/runs/:id — admins can access any run
func (h *Handler) GetRun(c echo.Context) error {
	claims := auth.GetClaims(c)
	var run dbpkg.ExecutionRun
	q := h.db.Where("id = ?", c.Param("id"))
	if !claims.IsAdmin {
		q = q.Where("user_id = ?", claims.UserID)
	}
	if err := q.First(&run).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "run not found")
	}
	return c.JSON(http.StatusOK, run)
}

// GET /api/runs/:id/logs — admins can access any run's logs
func (h *Handler) GetRunLogs(c echo.Context) error {
	claims := auth.GetClaims(c)

	// For running pipelines, the live in-memory backlog is authoritative;
	// skip the DB query entirely.
	if h.registry != nil {
		runIDStr := c.Param("id")
		if id64, perr := strconv.ParseUint(runIDStr, 10, 64); perr == nil {
			if activeRun, ok := h.registry.Get(uint(id64)); ok {
				// Authorize: load just the user_id column to confirm access.
				var run dbpkg.ExecutionRun
				if err := h.db.Select("id, user_id, status").Where("id = ?", id64).First(&run).Error; err == nil {
					if claims.IsAdmin || run.UserID == claims.UserID {
						return c.JSON(http.StatusOK, activeRun.GetMessages())
					}
				}
			}
		}
	}

	q := h.db.Select("id, user_id, logs_json, status").Where("id = ?", c.Param("id"))
	if !claims.IsAdmin {
		q = q.Where("user_id = ?", claims.UserID)
	}
	var run dbpkg.ExecutionRun
	if err := q.First(&run).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "run not found")
	}

	// Completed run: serve from the LRU cache when warm. Cache is keyed by
	// run ID and only populated once the run is no longer running, so it
	// can never serve a stale snapshot of an in-progress run.
	if run.Status != "running" && run.Status != "queued" {
		if cached, ok := h.logsCache.get(run.ID); ok {
			return c.JSONBlob(http.StatusOK, cached)
		}
	}

	logs := run.LogsJSON
	if logs == "" {
		logs = "[]"
	}
	if run.Status != "running" && run.Status != "queued" {
		h.logsCache.put(run.ID, []byte(logs))
	}
	return c.JSONBlob(http.StatusOK, []byte(logs))
}

// POST /api/runs/:id/cancel — stop an active (running) or queued run.
// Users can cancel their own; admins can cancel any.
func (h *Handler) CancelRun(c echo.Context) error {
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
		if h.scheduler == nil || !h.scheduler.CancelQueued(run.ID) {
			return echo.NewHTTPError(http.StatusBadRequest, "queued run could not be cancelled")
		}
		return c.JSON(http.StatusOK, echo.Map{"message": "queued run cancelled"})
	}

	activeRun, ok := h.registry.Get(run.ID)
	if !ok {
		return echo.NewHTTPError(http.StatusBadRequest, "run is not in active registry")
	}

	activeRun.Cancel()
	return c.JSON(http.StatusOK, echo.Map{"message": "cancellation requested"})
}

// DELETE /api/runs/:id — delete a completed run record; users can only delete their own
func (h *Handler) DeleteRun(c echo.Context) error {
	claims := auth.GetClaims(c)
	q := h.db.Where("id = ? AND status NOT IN ?", c.Param("id"), []string{"running", "queued"})
	if !claims.IsAdmin {
		q = q.Where("user_id = ?", claims.UserID)
	}
	var run dbpkg.ExecutionRun
	if err := q.First(&run).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "run not found or still active")
	}
	h.db.Delete(&run)
	return c.JSON(http.StatusOK, echo.Map{"message": "run deleted"})
}

// DELETE /api/runs — clear all completed run history; admins clear all, users clear their own
func (h *Handler) ClearRuns(c echo.Context) error {
	claims := auth.GetClaims(c)
	q := h.db.Where("status NOT IN ?", []string{"running", "queued"})
	if !claims.IsAdmin {
		q = q.Where("user_id = ?", claims.UserID)
	}
	result := q.Delete(&dbpkg.ExecutionRun{})
	return c.JSON(http.StatusOK, echo.Map{"deleted": result.RowsAffected})
}

// --- Self-management ---

// GET /api/me
func (h *Handler) GetMe(c echo.Context) error {
	claims := auth.GetClaims(c)
	var user dbpkg.User
	if err := h.db.First(&user, claims.UserID).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}
	return c.JSON(http.StatusOK, echo.Map{
		"id":                   user.ID,
		"username":             user.Username,
		"email":                emailString(user.Email),
		"auth_provider":        user.AuthProvider,
		"role":                 user.Role,
		"totp_enabled":         user.TOTPEnabled,
		"must_change_password": user.MustChangePassword,
	})
}

func emailString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func emailPtr(s string) *string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return nil
	}
	return &s
}

// GET /api/config/app — unauthenticated; returns the brand name + build version
// so pre-login pages (and the layout shell) can render them without an extra
// authenticated round trip. Falls back to "Codeci" if the settings row
// somehow can't be read.
func (h *Handler) GetAppConfig(c echo.Context) error {
	name := "Codeci"
	var s dbpkg.AppSettings
	if err := h.db.Select("application_name").First(&s, 1).Error; err == nil && s.ApplicationName != "" {
		name = s.ApplicationName
	}
	return c.JSON(http.StatusOK, echo.Map{
		"name":             name,
		"version":          h.version,
		"terminal_enabled": h.cfg.TerminalEnabled,
		// Used by Settings + trigger UI to render copyable webhook URLs.
		"webhook_base_url": strings.TrimRight(h.cfg.AllowedOrigin, "/"),
	})
}

// GET /api/config/auth — unauthenticated; tells the login page which methods are available.
func (h *Handler) GetAuthConfig(c echo.Context) error {
	var s dbpkg.AppSettings
	if err := h.db.First(&s, 1).Error; err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to load settings")
	}
	var userCount int64
	h.db.Model(&dbpkg.User{}).Count(&userCount)
	return c.JSON(http.StatusOK, echo.Map{
		"entra_enabled":     s.EntraEnabled,
		"registration_open": userCount == 0,
	})
}

// --- Admin user management ---

type userInfo struct {
	ID                 uint      `json:"id"`
	Username           string    `json:"username"`
	Email              string    `json:"email"`
	AuthProvider       string    `json:"auth_provider"`
	Role               string    `json:"role"`
	TOTPEnabled        bool      `json:"totp_enabled"`
	MustChangePassword bool      `json:"must_change_password"`
	CreatedAt          time.Time `json:"created_at"`
}

// GET /api/admin/users
func (h *Handler) ListUsers(c echo.Context) error {
	var users []dbpkg.User
	// Exclude synthetic accounts (e.g. github-webhook) so admins can't
	// accidentally delete them.
	h.db.Where("auth_provider != ?", "system").Order("created_at desc").Find(&users)
	result := make([]userInfo, len(users))
	for i, u := range users {
		result[i] = userInfo{
			ID:                 u.ID,
			Username:           u.Username,
			Email:              emailString(u.Email),
			AuthProvider:       u.AuthProvider,
			Role:               u.Role,
			TOTPEnabled:        u.TOTPEnabled,
			MustChangePassword: u.MustChangePassword,
			CreatedAt:          u.CreatedAt,
		}
	}
	return c.JSON(http.StatusOK, result)
}

// POST /api/admin/users
func (h *Handler) CreateUser(c echo.Context) error {
	var req struct {
		Username     string `json:"username"`
		Password     string `json:"password"`
		Email        string `json:"email"`
		Role         string `json:"role"`
		AuthProvider string `json:"auth_provider"`
	}
	if err := c.Bind(&req); err != nil || req.Username == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "username required")
	}
	if req.Role != "admin" && req.Role != "user" {
		req.Role = "user"
	}
	if req.AuthProvider != "entra" {
		req.AuthProvider = "local"
	}
	emailNorm := strings.ToLower(strings.TrimSpace(req.Email))

	user := dbpkg.User{
		Username:     req.Username,
		Email:        emailPtr(emailNorm),
		AuthProvider: req.AuthProvider,
		Role:         req.Role,
	}

	if req.AuthProvider == "entra" {
		if emailNorm == "" {
			return echo.NewHTTPError(http.StatusBadRequest, "email is required for Entra ID users")
		}
		// No password; Microsoft handles authentication.
		user.MustChangePassword = false
	} else {
		if req.Password == "" {
			return echo.NewHTTPError(http.StatusBadRequest, "password required")
		}
		if len(req.Password) < 8 {
			return echo.NewHTTPError(http.StatusBadRequest, "password must be at least 8 characters")
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "failed to hash password")
		}
		user.PassHash = string(hash)
		user.MustChangePassword = true
	}

	if err := h.db.Create(&user).Error; err != nil {
		return echo.NewHTTPError(http.StatusConflict, "username or email already exists")
	}

	return c.JSON(http.StatusCreated, userInfo{
		ID:                 user.ID,
		Username:           user.Username,
		Email:              emailString(user.Email),
		AuthProvider:       user.AuthProvider,
		Role:               user.Role,
		MustChangePassword: user.MustChangePassword,
		CreatedAt:          user.CreatedAt,
	})
}

// PUT /api/admin/users/:id — update role / email / reset password / disable TOTP.
// auth_provider is intentionally immutable after creation to avoid orphaning
// password hashes or email mappings.
func (h *Handler) UpdateUser(c echo.Context) error {
	claims := auth.GetClaims(c)
	var req struct {
		Role        string `json:"role"`
		Password    string `json:"password"`
		Email       string `json:"email"`
		TOTPDisable bool   `json:"totp_disable"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	var user dbpkg.User
	if err := h.db.First(&user, c.Param("id")).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}

	// Prevent self-demotion
	if user.ID == claims.UserID && req.Role == "user" {
		return echo.NewHTTPError(http.StatusBadRequest, "cannot remove your own admin role")
	}

	updates := map[string]any{}
	if req.Role == "admin" || req.Role == "user" {
		updates["role"] = req.Role
	}
	if req.Email != "" {
		// Stored as nullable; gorm writes a *string transparently.
		updates["email"] = emailPtr(req.Email)
	}
	if req.Password != "" {
		if user.AuthProvider == "entra" {
			return echo.NewHTTPError(http.StatusBadRequest, "Entra-managed accounts have no password")
		}
		if len(req.Password) < 8 {
			return echo.NewHTTPError(http.StatusBadRequest, "password must be at least 8 characters")
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "hash error")
		}
		updates["pass_hash"] = string(hash)
		updates["must_change_password"] = true
	}
	if req.TOTPDisable {
		updates["totp_enabled"] = false
		updates["totp_secret"] = ""
	}

	if len(updates) > 0 {
		if err := h.db.Model(&user).Updates(updates).Error; err != nil {
			return echo.NewHTTPError(http.StatusConflict, "email already in use")
		}
	}

	return c.JSON(http.StatusOK, echo.Map{"message": "user updated"})
}

// GET /api/admin/settings
func (h *Handler) GetSettings(c echo.Context) error {
	var s dbpkg.AppSettings
	if err := h.db.First(&s, 1).Error; err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to load settings")
	}
	return c.JSON(http.StatusOK, echo.Map{
		"application_name":         s.ApplicationName,
		"version":                  h.version,
		"runner_timeout_minutes":   s.RunnerTimeoutMinutes,
		"pipeline_history_limit":   s.PipelineHistoryLimit,
		"entra_enabled":            s.EntraEnabled,
		"entra_client_id":          s.EntraClientID,
		"entra_tenant_id":          s.EntraTenantID,
		"entra_redirect_url":       s.EntraRedirectURL,
		"entra_client_secret_set":  s.EntraClientSecret != "",
		"github_enabled":           s.GitHubEnabled,
		"github_provider":          s.GitHubProvider,
		"github_client_id":         s.GitHubClientID,
		"github_client_secret_set": s.GitHubClientSecret != "",
		"github_webhook_secret_set": s.GitHubWebhookSecret != "",
		"github_connected":         s.GitHubAccessToken != "",
		"github_connected_login":   s.GitHubConnectedLogin,
		"github_connected_at":      s.GitHubConnectedAt,
	})
}

// PUT /api/admin/settings
// EntraClientSecret follows the "Replace" pattern: an empty/missing secret in
// the request body leaves the existing ciphertext untouched. A non-empty secret
// is freshly encrypted with TOTP_ENCRYPTION_KEY and overwrites the stored value.
func (h *Handler) UpdateSettings(c echo.Context) error {
	var req struct {
		ApplicationName      *string `json:"application_name"`
		RunnerTimeoutMinutes *int    `json:"runner_timeout_minutes"`
		PipelineHistoryLimit *int    `json:"pipeline_history_limit"`
		EntraEnabled         *bool   `json:"entra_enabled"`
		EntraClientID        *string `json:"entra_client_id"`
		EntraTenantID        *string `json:"entra_tenant_id"`
		EntraClientSecret    *string `json:"entra_client_secret"`
		EntraRedirectURL     *string `json:"entra_redirect_url"`
		GitHubEnabled        *bool   `json:"github_enabled"`
		GitHubClientID       *string `json:"github_client_id"`
		GitHubClientSecret   *string `json:"github_client_secret"`
		GitHubWebhookSecret  *string `json:"github_webhook_secret"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	updates := map[string]any{}
	if req.ApplicationName != nil {
		name := strings.TrimSpace(*req.ApplicationName)
		if name == "" {
			return echo.NewHTTPError(http.StatusBadRequest, "application name cannot be empty")
		}
		if len(name) > 64 {
			return echo.NewHTTPError(http.StatusBadRequest, "application name must be 64 characters or fewer")
		}
		updates["application_name"] = name
	}
	if req.RunnerTimeoutMinutes != nil {
		v := *req.RunnerTimeoutMinutes
		if v < 1 || v > 1440 {
			return echo.NewHTTPError(http.StatusBadRequest, "timeout must be between 1 and 1440 minutes")
		}
		updates["runner_timeout_minutes"] = v
	}
	if req.PipelineHistoryLimit != nil {
		v := *req.PipelineHistoryLimit
		if v < 1 || v > 10000 {
			return echo.NewHTTPError(http.StatusBadRequest, "history limit must be between 1 and 10000")
		}
		updates["pipeline_history_limit"] = v
	}
	if req.EntraEnabled != nil {
		updates["entra_enabled"] = *req.EntraEnabled
	}
	if req.EntraClientID != nil {
		updates["entra_client_id"] = strings.TrimSpace(*req.EntraClientID)
	}
	if req.EntraTenantID != nil {
		updates["entra_tenant_id"] = strings.TrimSpace(*req.EntraTenantID)
	}
	if req.EntraRedirectURL != nil {
		updates["entra_redirect_url"] = strings.TrimSpace(*req.EntraRedirectURL)
	}
	if req.EntraClientSecret != nil && *req.EntraClientSecret != "" {
		ciphertext, err := auth.EncryptSecret(*req.EntraClientSecret, h.cfg.TOTPEncryptionKey)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "failed to encrypt entra client secret")
		}
		updates["entra_client_secret"] = ciphertext
	}
	if req.GitHubEnabled != nil {
		updates["git_hub_enabled"] = *req.GitHubEnabled
	}
	if req.GitHubClientID != nil {
		updates["git_hub_client_id"] = strings.TrimSpace(*req.GitHubClientID)
	}
	// Replace pattern: only encrypt + overwrite when a non-empty value arrives.
	if req.GitHubClientSecret != nil && *req.GitHubClientSecret != "" {
		ciphertext, err := auth.EncryptSecret(*req.GitHubClientSecret, h.cfg.TOTPEncryptionKey)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "failed to encrypt github client secret")
		}
		updates["git_hub_client_secret"] = ciphertext
	}
	if req.GitHubWebhookSecret != nil && *req.GitHubWebhookSecret != "" {
		ciphertext, err := auth.EncryptSecret(*req.GitHubWebhookSecret, h.cfg.TOTPEncryptionKey)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "failed to encrypt github webhook secret")
		}
		updates["git_hub_webhook_secret"] = ciphertext
	}

	if len(updates) == 0 {
		return c.JSON(http.StatusOK, echo.Map{"message": "no changes"})
	}

	if err := h.db.Model(&dbpkg.AppSettings{}).Where("id = ?", 1).Updates(updates).Error; err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to update settings")
	}
	return c.JSON(http.StatusOK, echo.Map{"message": "settings updated"})
}

// DELETE /api/admin/users/:id
func (h *Handler) DeleteUser(c echo.Context) error {
	claims := auth.GetClaims(c)
	var user dbpkg.User
	if err := h.db.First(&user, c.Param("id")).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}
	if user.ID == claims.UserID {
		return echo.NewHTTPError(http.StatusBadRequest, "cannot delete yourself")
	}
	h.db.Delete(&user)
	return c.JSON(http.StatusOK, echo.Map{"message": "user deleted"})
}

// GET /api/git/branches?repo=<url-or-local-path>
func (h *Handler) GitBranches(c echo.Context) error {
	repo := c.QueryParam("repo")
	if repo == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "repo parameter required")
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 30*time.Second)
	defer cancel()

	injectPAT := func(u string) string {
		if h.cfg.GitPAT == "" {
			return u
		}
		if strings.HasPrefix(u, "https://") && !strings.Contains(u, "@") {
			return strings.Replace(u, "https://", fmt.Sprintf("https://%s@", h.cfg.GitPAT), 1)
		}
		return u
	}

	isURL := strings.HasPrefix(repo, "http://") ||
		strings.HasPrefix(repo, "https://") ||
		strings.HasPrefix(repo, "git@") ||
		strings.HasPrefix(repo, "ssh://") ||
		strings.HasPrefix(repo, "git://")

	var out []byte
	var err error

	if isURL {
		// Always go straight to the remote with a fresh PAT. Don't fall
		// back to any local clone — a shallow ./repo-cache clone would
		// only know about the branches pipeline runs have checked out.
		authedUrl := injectPAT(repo)
		out, err = exec.CommandContext(ctx, "git", "ls-remote", "--heads", "--", authedUrl).Output()
	} else if fi, statErr := os.Stat(repo); statErr == nil && fi.IsDir() {
		out, err = exec.CommandContext(ctx, "git", "ls-remote", "--heads", "--", repo).Output()
		if err != nil || len(out) == 0 {
			out, err = exec.CommandContext(ctx, "git", "-C", repo, "branch", "-a").Output()
		}
	} else {
		// Bare name or unknown — try as-is via ls-remote.
		out, err = exec.CommandContext(ctx, "git", "ls-remote", "--heads", "--", repo).Output()
	}

	if err != nil && len(out) == 0 {
		errMsg := "failed to list branches"
		if err != nil {
			errMsg = fmt.Sprintf("git error: %v", err)
		}
		return echo.NewHTTPError(http.StatusBadGateway, errMsg)
	}

	type BranchOption struct {
		Label string `json:"label"`
		Value string `json:"value"`
	}
	var branches []BranchOption
	seen := make(map[string]bool)

	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var name string
		if strings.Contains(line, "refs/heads/") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				name = strings.TrimPrefix(parts[1], "refs/heads/")
			}
		} else {
			name = strings.TrimPrefix(line, "* ")
			name = strings.TrimSpace(name)
			if strings.HasPrefix(name, "remotes/origin/") {
				name = strings.TrimPrefix(name, "remotes/origin/")
			}
			if strings.Contains(name, "->") {
				continue
			}
		}

		if name != "" && !seen[name] {
			branches = append(branches, BranchOption{Label: name, Value: name})
			seen[name] = true
		}
	}
	return c.JSON(http.StatusOK, branches)
}

// --- User Scripts ---

// GET /api/scripts/export — streams a zip of every user script (.sh).
func (h *Handler) ExportScripts(c echo.Context) error {
	filename := fmt.Sprintf("scripts-%s.zip", time.Now().UTC().Format("20060102-150405"))
	c.Response().Header().Set(echo.HeaderContentType, "application/zip")
	c.Response().Header().Set(echo.HeaderContentDisposition, fmt.Sprintf(`attachment; filename="%s"`, filename))
	c.Response().WriteHeader(http.StatusOK)
	if err := h.scriptLoader.ExportZip(c.Response().Writer); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to build scripts archive")
	}
	return nil
}

// GET /api/scripts
func (h *Handler) ListScripts(c echo.Context) error {
	scripts, err := h.scriptLoader.List()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to load scripts")
	}
	if scripts == nil {
		scripts = []script.Script{}
	}
	return c.JSON(http.StatusOK, scripts)
}

// GET /api/scripts/:id
func (h *Handler) GetScript(c echo.Context) error {
	s, err := h.scriptLoader.Get(c.Param("id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "script not found")
	}
	return c.JSON(http.StatusOK, s)
}

// POST /api/scripts
func (h *Handler) CreateScript(c echo.Context) error {
	var req struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}
	if err := c.Bind(&req); err != nil || req.Name == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "name and content required")
	}

	id, err := h.scriptLoader.Create(req.Name, req.Content)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}

	return c.JSON(http.StatusCreated, echo.Map{"id": id, "message": "script created"})
}

// PUT /api/scripts/:id
func (h *Handler) UpdateScript(c echo.Context) error {
	var req struct {
		Content string `json:"content"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "content required")
	}
	if err := h.scriptLoader.Update(c.Param("id"), req.Content); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	return c.JSON(http.StatusOK, echo.Map{"message": "script updated"})
}

// DELETE /api/scripts/:id
func (h *Handler) DeleteScript(c echo.Context) error {
	if err := h.scriptLoader.Delete(c.Param("id")); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "script not found")
	}
	return c.JSON(http.StatusOK, echo.Map{"message": "script deleted"})
}
