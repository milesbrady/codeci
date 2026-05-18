// github_handler.go — admin-only GitHub connection management + the
// public webhook ingestion endpoints. The OAuth flow follows the same
// HMAC-signed state cookie pattern used by auth/entra.go.
package api

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"github.com/codeci/codeci/server/auth"
	awspkg "github.com/codeci/codeci/server/aws"
	"github.com/codeci/codeci/server/config"
	dbpkg "github.com/codeci/codeci/server/db"
	"github.com/codeci/codeci/server/execution"
	gh "github.com/codeci/codeci/server/github"
	"github.com/codeci/codeci/server/pipeline"
)

const (
	githubStateCookie    = "github_oauth_state"
	githubStateTTL       = 10 * time.Minute
	systemWebhookUser    = "github-webhook"
	systemAuthProvider   = "system"
	webhookCallbackPath  = "/api/auth/github/callback"
	webhookGitHubPath    = "/api/webhooks/github"
	webhookManualPathFmt = "/api/webhooks/manual/%d"
)

// GitHubHandler holds dependencies for the GitHub integration.
type GitHubHandler struct {
	db         *gorm.DB
	cfg        *config.Config
	loader     *pipeline.Loader
	registry   *execution.RunRegistry
	scheduler  *execution.Scheduler
	awsClients *awspkg.Clients
	provider   *gh.OAuthAppProvider

	// systemUserOnce caches the lookup-or-create of the github-webhook
	// system user the first time a webhook delivery arrives.
	systemUserOnce sync.Once
	systemUserID   uint
	systemUserErr  error
}

func NewGitHubHandler(
	db *gorm.DB,
	cfg *config.Config,
	loader *pipeline.Loader,
	registry *execution.RunRegistry,
	scheduler *execution.Scheduler,
	awsClients *awspkg.Clients,
	provider *gh.OAuthAppProvider,
) *GitHubHandler {
	return &GitHubHandler{
		db:         db,
		cfg:        cfg,
		loader:     loader,
		registry:   registry,
		scheduler:  scheduler,
		awsClients: awsClients,
		provider:   provider,
	}
}

// callbackURL is the absolute redirect_uri codeci registers with GitHub.
// Derived from cfg.AllowedOrigin so the same value works in dev/test/prod.
func (h *GitHubHandler) callbackURL() string {
	return strings.TrimRight(h.cfg.AllowedOrigin, "/") + webhookCallbackPath
}

func (h *GitHubHandler) webhookURL() string {
	return strings.TrimRight(h.cfg.AllowedOrigin, "/") + webhookGitHubPath
}

// loadSettings is shorthand for the singleton AppSettings row.
func (h *GitHubHandler) loadSettings() (*dbpkg.AppSettings, error) {
	var s dbpkg.AppSettings
	if err := h.db.First(&s, 1).Error; err != nil {
		return nil, err
	}
	return &s, nil
}

// ── Status / Connect / Disconnect ───────────────────────────────────────

// GET /api/admin/github/status
func (h *GitHubHandler) Status(c echo.Context) error {
	s, err := h.loadSettings()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "load settings")
	}
	resp := echo.Map{
		"enabled":          s.GitHubEnabled,
		"provider":         s.GitHubProvider,
		"client_id":        s.GitHubClientID,
		"client_secret_set":  s.GitHubClientSecret != "",
		"webhook_secret_set": s.GitHubWebhookSecret != "",
		"connected":        s.GitHubAccessToken != "",
		"connected_login":  s.GitHubConnectedLogin,
		"connected_at":     s.GitHubConnectedAt,
		"callback_url":     h.callbackURL(),
		"webhook_url":      h.webhookURL(),
	}
	return c.JSON(http.StatusOK, resp)
}

// POST /api/admin/github/connect — returns the GitHub authorize URL.
// The browser navigates there; GitHub redirects back to our callback.
func (h *GitHubHandler) Connect(c echo.Context) error {
	s, err := h.loadSettings()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "load settings")
	}
	if !s.GitHubEnabled {
		return echo.NewHTTPError(http.StatusBadRequest, "github integration is disabled")
	}
	if s.GitHubClientID == "" || s.GitHubClientSecret == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "github client id/secret not configured")
	}

	nonce, err := randomNonceB64()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "nonce error")
	}
	state := signHMAC(nonce, h.cfg.JWTSecret)
	h.setStateCookie(c, state)
	url := gh.BuildAuthorizeURL(s.GitHubClientID, h.callbackURL(), state)
	return c.JSON(http.StatusOK, echo.Map{"authorize_url": url})
}

// GET /api/auth/github/callback — unauthenticated; the signed state
// cookie is what tells us this redirect was initiated by an admin in
// this session. The cookie is HttpOnly + SameSite=Lax + 10-minute TTL.
func (h *GitHubHandler) OAuthCallback(c echo.Context) error {
	defer h.clearStateCookie(c)

	queryState := c.QueryParam("state")
	cookie, err := c.Cookie(githubStateCookie)
	if err != nil || cookie.Value == "" || cookie.Value != queryState {
		return h.redirectToSettings(c, "state_mismatch")
	}
	if _, ok := verifyHMAC(queryState, h.cfg.JWTSecret); !ok {
		return h.redirectToSettings(c, "state_invalid")
	}
	if errCode := c.QueryParam("error"); errCode != "" {
		return h.redirectToSettings(c, "provider_error")
	}
	code := c.QueryParam("code")
	if code == "" {
		return h.redirectToSettings(c, "missing_code")
	}

	clientID, clientSecret, err := h.provider.LoadClientCreds()
	if err != nil {
		return h.redirectToSettings(c, "config_error")
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 15*time.Second)
	defer cancel()

	token, err := gh.ExchangeCode(ctx, clientID, clientSecret, code, h.callbackURL())
	if err != nil {
		return h.redirectToSettings(c, "token_exchange_failed")
	}
	login, err := gh.LookupLogin(ctx, token)
	if err != nil {
		return h.redirectToSettings(c, "lookup_login_failed")
	}

	ciphertext, err := auth.EncryptSecret(token, h.cfg.TOTPEncryptionKey)
	if err != nil {
		return h.redirectToSettings(c, "encrypt_failed")
	}
	now := time.Now()
	if err := h.db.Model(&dbpkg.AppSettings{}).Where("id = ?", 1).Updates(map[string]any{
		"git_hub_access_token":    ciphertext,
		"git_hub_connected_login": login,
		"git_hub_connected_at":    &now,
	}).Error; err != nil {
		return h.redirectToSettings(c, "persist_failed")
	}
	return h.redirectToSettings(c, "connected")
}

// POST /api/admin/github/disconnect — wipes the stored token. Best-effort
// removes every webhook codeci registered on GitHub so the credentials
// cannot be reused after rotation.
func (h *GitHubHandler) Disconnect(c echo.Context) error {
	client, _, err := h.provider.Client(c.Request().Context())
	if err == nil {
		ctx, cancel := context.WithTimeout(c.Request().Context(), 20*time.Second)
		defer cancel()
		var triggers []dbpkg.PipelineTrigger
		h.db.Where("provider = ? AND git_hub_hook_id IS NOT NULL", "github").Find(&triggers)
		for _, t := range triggers {
			if t.GitHubHookID != nil && t.RepoOwner != "" && t.RepoName != "" {
				_ = client.DeleteHook(ctx, t.RepoOwner, t.RepoName, *t.GitHubHookID)
			}
		}
	}
	if err := h.db.Model(&dbpkg.AppSettings{}).Where("id = ?", 1).Updates(map[string]any{
		"git_hub_access_token":    "",
		"git_hub_connected_login": "",
		"git_hub_connected_at":    nil,
	}).Error; err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to clear connection")
	}
	// Clear stored hook ids so a future reconnect won't try to update strangers' hooks.
	h.db.Model(&dbpkg.PipelineTrigger{}).Where("provider = ?", "github").Update("git_hub_hook_id", nil)
	return c.JSON(http.StatusOK, echo.Map{"message": "disconnected"})
}

// ── Repos / Branches ───────────────────────────────────────────────────

// GET /api/admin/github/repos?q=&page=
func (h *GitHubHandler) ListRepos(c echo.Context) error {
	client, _, err := h.provider.Client(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	page, _ := strconv.Atoi(c.QueryParam("page"))
	repos, err := client.ListRepos(c.Request().Context(), page)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	q := strings.ToLower(strings.TrimSpace(c.QueryParam("q")))
	if q != "" {
		filtered := repos[:0]
		for _, r := range repos {
			if strings.Contains(strings.ToLower(r.FullName), q) {
				filtered = append(filtered, r)
			}
		}
		repos = filtered
	}
	return c.JSON(http.StatusOK, repos)
}

// GET /api/admin/github/branches?owner=&repo=
func (h *GitHubHandler) ListBranches(c echo.Context) error {
	owner := c.QueryParam("owner")
	repo := c.QueryParam("repo")
	if owner == "" || repo == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "owner and repo required")
	}
	client, _, err := h.provider.Client(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	branches, err := client.ListBranches(c.Request().Context(), owner, repo)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	return c.JSON(http.StatusOK, branches)
}

// ── Trigger CRUD ───────────────────────────────────────────────────────

type triggerView struct {
	ID               uint              `json:"id"`
	PipelineID       string            `json:"pipeline_id"`
	Provider         string            `json:"provider"`
	RepoOwner        string            `json:"repo_owner"`
	RepoName         string            `json:"repo_name"`
	Branch           string            `json:"branch"`
	Events           []string          `json:"events"`
	Active           bool              `json:"active"`
	DefaultParams    map[string]string `json:"default_params"`
	GitHubHookID     *int64            `json:"github_hook_id,omitempty"`
	ManualSecretHint string            `json:"manual_secret_hint,omitempty"`
	ManualURL        string            `json:"manual_url,omitempty"`
	LastFiredAt      *time.Time        `json:"last_fired_at,omitempty"`
	CreatedAt        time.Time         `json:"created_at"`
}

type triggerInput struct {
	Provider      string            `json:"provider"` // "github" | "manual"
	RepoOwner     string            `json:"repo_owner"`
	RepoName      string            `json:"repo_name"`
	Branch        string            `json:"branch"`
	Events        []string          `json:"events"`
	Active        *bool             `json:"active"`
	DefaultParams map[string]string `json:"default_params"`
	RegenerateSecret bool           `json:"regenerate_secret"`
}

// GET /api/pipelines/:id/trigger
func (h *GitHubHandler) GetTrigger(c echo.Context) error {
	pipelineID := c.Param("id")
	var t dbpkg.PipelineTrigger
	if err := h.db.Where("pipeline_id = ?", pipelineID).First(&t).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return c.JSON(http.StatusOK, nil)
		}
		return echo.NewHTTPError(http.StatusInternalServerError, "load trigger")
	}
	return c.JSON(http.StatusOK, h.toView(t, ""))
}

// PUT /api/pipelines/:id/trigger — create or replace.
// Validates the default params cover every Required parameter on the
// pipeline; webhook runs are non-interactive so missing values would
// break the run silently.
func (h *GitHubHandler) PutTrigger(c echo.Context) error {
	claims := auth.GetClaims(c)
	pipelineID := c.Param("id")

	pl, err := h.loader.Get(pipelineID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "pipeline not found")
	}

	var req triggerInput
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}
	if req.Provider != "github" && req.Provider != "manual" {
		return echo.NewHTTPError(http.StatusBadRequest, "provider must be 'github' or 'manual'")
	}
	if req.Provider == "github" {
		if req.RepoOwner == "" || req.RepoName == "" {
			return echo.NewHTTPError(http.StatusBadRequest, "repo_owner and repo_name required")
		}
		if len(req.Events) == 0 {
			req.Events = []string{"push"}
		}
		for _, ev := range req.Events {
			switch ev {
			case "push", "pull_request", "release":
			default:
				return echo.NewHTTPError(http.StatusBadRequest, "unknown event: "+ev)
			}
		}
	}

	if missing := missingRequiredParams(pl, req.DefaultParams); len(missing) > 0 {
		return echo.NewHTTPError(http.StatusBadRequest,
			"default values required for: "+strings.Join(missing, ", "))
	}

	paramsJSON, _ := json.Marshal(req.DefaultParams)

	// Upsert: one trigger per pipeline (MVP keeps a 1:1 mapping; multiple
	// triggers per pipeline would multiply runs without obvious benefit).
	var existing dbpkg.PipelineTrigger
	found := h.db.Where("pipeline_id = ?", pipelineID).First(&existing).Error == nil

	row := dbpkg.PipelineTrigger{
		PipelineID:        pipelineID,
		Provider:          req.Provider,
		RepoOwner:         req.RepoOwner,
		RepoName:          req.RepoName,
		Branch:            strings.TrimSpace(req.Branch),
		Events:            strings.Join(req.Events, ","),
		DefaultParamsJSON: string(paramsJSON),
		Active:            true,
		CreatedByUserID:   claims.UserID,
	}
	if req.Active != nil {
		row.Active = *req.Active
	}
	if found {
		row.ID = existing.ID
		row.CreatedAt = existing.CreatedAt
		row.GitHubHookID = existing.GitHubHookID
		row.ManualSecretHash = existing.ManualSecretHash
		row.ManualSecretHint = existing.ManualSecretHint
	}

	// Manual provider: generate a new secret on creation OR when explicitly asked.
	var plaintextSecret string
	if req.Provider == "manual" && (!found || row.ManualSecretHash == "" || req.RegenerateSecret) {
		plaintextSecret, err = randomToken(32)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "secret gen")
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(plaintextSecret), 12)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "hash secret")
		}
		row.ManualSecretHash = string(hash)
		if len(plaintextSecret) > 8 {
			row.ManualSecretHint = plaintextSecret[:8]
		} else {
			row.ManualSecretHint = plaintextSecret
		}
	}

	// Register/update the webhook on GitHub.
	if req.Provider == "github" && row.Active {
		if err := h.syncGitHubHook(c.Request().Context(), &row); err != nil {
			return echo.NewHTTPError(http.StatusBadGateway, "github: "+err.Error())
		}
	}

	if found {
		if err := h.db.Save(&row).Error; err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "save trigger")
		}
	} else {
		if err := h.db.Create(&row).Error; err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "create trigger")
		}
	}

	return c.JSON(http.StatusOK, h.toView(row, plaintextSecret))
}

// DELETE /api/pipelines/:id/trigger
func (h *GitHubHandler) DeleteTrigger(c echo.Context) error {
	pipelineID := c.Param("id")
	var t dbpkg.PipelineTrigger
	if err := h.db.Where("pipeline_id = ?", pipelineID).First(&t).Error; err != nil {
		return c.JSON(http.StatusOK, echo.Map{"message": "no trigger"})
	}
	// Best-effort cleanup on GitHub.
	if t.Provider == "github" && t.GitHubHookID != nil {
		client, _, err := h.provider.Client(c.Request().Context())
		if err == nil {
			ctx, cancel := context.WithTimeout(c.Request().Context(), 15*time.Second)
			defer cancel()
			_ = client.DeleteHook(ctx, t.RepoOwner, t.RepoName, *t.GitHubHookID)
		}
	}
	if err := h.db.Delete(&t).Error; err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "delete failed")
	}
	return c.JSON(http.StatusOK, echo.Map{"message": "deleted"})
}

// POST /api/pipelines/:id/trigger/test — fires the trigger immediately
// using the stored default params. Useful for verifying the pipeline
// works before the next real push event arrives.
func (h *GitHubHandler) TestTrigger(c echo.Context) error {
	pipelineID := c.Param("id")
	var t dbpkg.PipelineTrigger
	if err := h.db.Where("pipeline_id = ?", pipelineID).First(&t).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "trigger not configured")
	}
	runID, dispatched, err := h.fireTrigger(c.Request().Context(), t, "test")
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	status := "running"
	if !dispatched {
		status = "queued"
	}
	return c.JSON(http.StatusAccepted, echo.Map{"run_id": runID, "status": status})
}

// ── Webhook ingestion ──────────────────────────────────────────────────

// POST /api/webhooks/github — verified by X-Hub-Signature-256. Looks up
// matching PipelineTrigger rows and fires runs. Returns 202 immediately;
// the actual pipelines run in background goroutines (see StartRun).
func (h *GitHubHandler) GitHubWebhook(c echo.Context) error {
	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "read body")
	}

	secret, err := h.provider.LoadWebhookSecret()
	if err != nil || secret == "" {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "webhook not configured")
	}
	sigHeader := c.Request().Header.Get("X-Hub-Signature-256")
	if !gh.VerifySignature(body, sigHeader, secret) {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid signature")
	}

	event := c.Request().Header.Get("X-GitHub-Event")
	if event == "ping" {
		return c.JSON(http.StatusOK, echo.Map{"message": "pong"})
	}

	owner, repo, ref, action, ok := parseGitHubEvent(event, body)
	if !ok {
		return c.JSON(http.StatusAccepted, echo.Map{"message": "event ignored"})
	}

	// pull_request: only the "opened" and "synchronize" sub-actions fire a run.
	if event == "pull_request" && action != "opened" && action != "synchronize" {
		return c.JSON(http.StatusAccepted, echo.Map{"message": "pr action ignored: " + action})
	}
	// release: only "published".
	if event == "release" && action != "published" {
		return c.JSON(http.StatusAccepted, echo.Map{"message": "release action ignored: " + action})
	}

	var matches []dbpkg.PipelineTrigger
	h.db.Where("provider = ? AND repo_owner = ? AND repo_name = ? AND active = ?", "github", owner, repo, true).
		Find(&matches)

	started, queued := 0, 0
	for _, t := range matches {
		if !triggerWantsEvent(t.Events, event) {
			continue
		}
		// Branch filter only applies to push and pull_request; release events
		// don't carry a branch ref in the same form (they fire on tags).
		if t.Branch != "" && (event == "push" || event == "pull_request") && ref != "" && t.Branch != ref {
			continue
		}
		_, dispatched, err := h.fireTrigger(c.Request().Context(), t, event)
		if err != nil {
			continue
		}
		if dispatched {
			started++
		} else {
			queued++
		}
	}
	return c.JSON(http.StatusAccepted, echo.Map{"runs_started": started, "runs_queued": queued})
}

// POST /api/webhooks/manual/:trigger_id — verified by a per-trigger
// bcrypt-hashed token in X-Codeci-Token. No GitHub involved.
func (h *GitHubHandler) ManualWebhook(c echo.Context) error {
	idStr := c.Param("trigger_id")
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "bad trigger id")
	}
	var t dbpkg.PipelineTrigger
	if err := h.db.First(&t, uint(id)).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "trigger not found")
	}
	if t.Provider != "manual" || !t.Active {
		return echo.NewHTTPError(http.StatusBadRequest, "trigger is not active or not manual")
	}
	tok := strings.TrimSpace(c.Request().Header.Get("X-Codeci-Token"))
	if tok == "" {
		return echo.NewHTTPError(http.StatusUnauthorized, "missing token")
	}
	if bcrypt.CompareHashAndPassword([]byte(t.ManualSecretHash), []byte(tok)) != nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid token")
	}
	runID, dispatched, err := h.fireTrigger(c.Request().Context(), t, "manual")
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	status := "running"
	if !dispatched {
		status = "queued"
	}
	return c.JSON(http.StatusAccepted, echo.Map{"run_id": runID, "status": status})
}

// ── Trigger firing + system user ───────────────────────────────────────

func (h *GitHubHandler) fireTrigger(ctx context.Context, t dbpkg.PipelineTrigger, source string) (uint, bool, error) {
	pl, err := h.loader.Get(t.PipelineID)
	if err != nil {
		return 0, false, errors.New("pipeline not found: " + t.PipelineID)
	}
	var params map[string]string
	_ = json.Unmarshal([]byte(t.DefaultParamsJSON), &params)
	if params == nil {
		params = map[string]string{}
	}

	uid, err := h.ensureSystemUser()
	if err != nil {
		return 0, false, err
	}
	username := systemWebhookUser
	if source != "" {
		username = systemWebhookUser + " (" + source + ")"
	}

	runID, dispatched, err := h.scheduler.Submit(execution.StartRunOpts{
		Pipeline: *pl,
		Params:   params,
		UserID:   uid,
		Username: username,
	})
	if err != nil {
		return 0, false, err
	}

	now := time.Now()
	h.db.Model(&dbpkg.PipelineTrigger{}).Where("id = ?", t.ID).Update("last_fired_at", &now)
	return runID, dispatched, nil
}

// ensureSystemUser lazily creates the `github-webhook` system user.
// Synthetic accounts use auth_provider = "system" so they cannot log in
// via either the local or Entra paths.
func (h *GitHubHandler) ensureSystemUser() (uint, error) {
	h.systemUserOnce.Do(func() {
		var u dbpkg.User
		err := h.db.Where("username = ? AND auth_provider = ?", systemWebhookUser, systemAuthProvider).First(&u).Error
		if err == nil {
			h.systemUserID = u.ID
			return
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			h.systemUserErr = err
			return
		}
		newUser := dbpkg.User{
			Username:     systemWebhookUser,
			AuthProvider: systemAuthProvider,
			Role:         "user",
		}
		if err := h.db.Create(&newUser).Error; err != nil {
			h.systemUserErr = err
			return
		}
		h.systemUserID = newUser.ID
	})
	return h.systemUserID, h.systemUserErr
}

// EnsureSystemUserAtBoot is invoked from main.go so the row exists
// before the first webhook arrives. It's a thin wrapper around the
// lazy path; the underlying sync.Once still guarantees a single insert.
func (h *GitHubHandler) EnsureSystemUserAtBoot() error {
	_, err := h.ensureSystemUser()
	return err
}

// ── Helpers ────────────────────────────────────────────────────────────

func (h *GitHubHandler) toView(t dbpkg.PipelineTrigger, plaintextSecret string) triggerView {
	var params map[string]string
	_ = json.Unmarshal([]byte(t.DefaultParamsJSON), &params)
	events := []string{}
	for _, ev := range strings.Split(t.Events, ",") {
		ev = strings.TrimSpace(ev)
		if ev != "" {
			events = append(events, ev)
		}
	}
	view := triggerView{
		ID:               t.ID,
		PipelineID:       t.PipelineID,
		Provider:         t.Provider,
		RepoOwner:        t.RepoOwner,
		RepoName:         t.RepoName,
		Branch:           t.Branch,
		Events:           events,
		Active:           t.Active,
		DefaultParams:    params,
		GitHubHookID:     t.GitHubHookID,
		ManualSecretHint: t.ManualSecretHint,
		LastFiredAt:      t.LastFiredAt,
		CreatedAt:        t.CreatedAt,
	}
	if t.Provider == "manual" && t.ID > 0 {
		view.ManualURL = strings.TrimRight(h.cfg.AllowedOrigin, "/") + "/api/webhooks/manual/" + strconv.FormatUint(uint64(t.ID), 10)
	}
	// plaintextSecret is only returned once: at creation / regeneration.
	if plaintextSecret != "" {
		view.ManualSecretHint = plaintextSecret
	}
	return view
}

// syncGitHubHook creates a webhook on GitHub or updates the existing
// one if the trigger already has a hook id. Webhook secret is read from
// the central AppSettings.
func (h *GitHubHandler) syncGitHubHook(ctx context.Context, row *dbpkg.PipelineTrigger) error {
	secret, err := h.provider.LoadWebhookSecret()
	if err != nil || secret == "" {
		return errors.New("webhook secret not configured")
	}
	client, _, err := h.provider.Client(ctx)
	if err != nil {
		return err
	}
	events := strings.Split(row.Events, ",")
	opts := gh.CreateHookOpts{
		URL:    h.webhookURL(),
		Secret: secret,
		Events: events,
		Active: true,
	}
	if row.GitHubHookID != nil {
		if err := client.UpdateHook(ctx, row.RepoOwner, row.RepoName, *row.GitHubHookID, opts); err == nil {
			return nil
		}
		// Fall through to create — the hook may have been deleted on GitHub side.
	}
	id, err := client.CreateHook(ctx, row.RepoOwner, row.RepoName, opts)
	if err != nil {
		return err
	}
	row.GitHubHookID = &id
	return nil
}

func missingRequiredParams(pl *pipeline.Pipeline, defaults map[string]string) []string {
	var missing []string
	for _, p := range pl.Parameters {
		if !p.Required {
			continue
		}
		// `readonly` params (auto-injected git_repo) already have a default
		// baked into the schema — Expand() sets it from `repository:`.
		if p.Readonly {
			if _, ok := defaults[p.ID]; ok {
				continue
			}
			if p.Default != nil {
				continue
			}
		}
		if v, ok := defaults[p.ID]; !ok || strings.TrimSpace(v) == "" {
			missing = append(missing, p.ID)
		}
	}
	return missing
}

func triggerWantsEvent(stored string, event string) bool {
	for _, ev := range strings.Split(stored, ",") {
		if strings.TrimSpace(ev) == event {
			return true
		}
	}
	return false
}

// parseGitHubEvent extracts the (owner, repo, ref, action) tuple from a
// push / pull_request / release payload. Returns ok=false for events we
// don't care about, which the handler turns into a 202 no-op.
func parseGitHubEvent(event string, body []byte) (owner, repo, ref, action string, ok bool) {
	switch event {
	case "push":
		var p struct {
			Ref        string `json:"ref"`
			Repository struct {
				Name  string `json:"name"`
				Owner struct {
					Login string `json:"login"`
					Name  string `json:"name"`
				} `json:"owner"`
			} `json:"repository"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return "", "", "", "", false
		}
		owner = p.Repository.Owner.Login
		if owner == "" {
			owner = p.Repository.Owner.Name
		}
		// "refs/heads/main" → "main"; non-branch refs (tags) are skipped
		// for push events to keep the semantics predictable.
		if !strings.HasPrefix(p.Ref, "refs/heads/") {
			return "", "", "", "", false
		}
		ref = strings.TrimPrefix(p.Ref, "refs/heads/")
		return owner, p.Repository.Name, ref, "", true

	case "pull_request":
		var p struct {
			Action      string `json:"action"`
			PullRequest struct {
				Head struct {
					Ref string `json:"ref"`
				} `json:"head"`
			} `json:"pull_request"`
			Repository struct {
				Name  string `json:"name"`
				Owner struct {
					Login string `json:"login"`
				} `json:"owner"`
			} `json:"repository"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return "", "", "", "", false
		}
		return p.Repository.Owner.Login, p.Repository.Name, p.PullRequest.Head.Ref, p.Action, true

	case "release":
		var p struct {
			Action     string `json:"action"`
			Repository struct {
				Name  string `json:"name"`
				Owner struct {
					Login string `json:"login"`
				} `json:"owner"`
			} `json:"repository"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return "", "", "", "", false
		}
		return p.Repository.Owner.Login, p.Repository.Name, "", p.Action, true
	}
	return "", "", "", "", false
}

// ── State cookie helpers (shared shape with auth/entra.go) ─────────────

func (h *GitHubHandler) setStateCookie(c echo.Context, value string) {
	http.SetCookie(c.Response(), &http.Cookie{
		Name:     githubStateCookie,
		Value:    value,
		Path:     "/api",
		MaxAge:   int(githubStateTTL.Seconds()),
		HttpOnly: true,
		Secure:   c.Request().TLS != nil,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *GitHubHandler) clearStateCookie(c echo.Context) {
	http.SetCookie(c.Response(), &http.Cookie{
		Name:     githubStateCookie,
		Value:    "",
		Path:     "/api",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   c.Request().TLS != nil,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *GitHubHandler) redirectToSettings(c echo.Context, status string) error {
	target := strings.TrimRight(h.cfg.AllowedOrigin, "/") + "/settings?github=" + url.QueryEscape(status)
	return c.Redirect(http.StatusFound, target)
}

func signHMAC(nonce, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(nonce))
	return nonce + "." + hex.EncodeToString(mac.Sum(nil))
}

func verifyHMAC(signed, secret string) (string, bool) {
	parts := strings.SplitN(signed, ".", 2)
	if len(parts) != 2 {
		return "", false
	}
	expected := signHMAC(parts[0], secret)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(signed)) != 1 {
		return "", false
	}
	return parts[0], true
}

func randomNonceB64() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
