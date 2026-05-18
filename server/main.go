package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"gorm.io/gorm"

	"github.com/codeci/codeci/server/api"
	"github.com/codeci/codeci/server/auth"
	awspkg "github.com/codeci/codeci/server/aws"
	"github.com/codeci/codeci/server/cmd/admin"
	"github.com/codeci/codeci/server/config"
	"github.com/codeci/codeci/server/db"
	"github.com/codeci/codeci/server/execution"
	gh "github.com/codeci/codeci/server/github"
	"github.com/codeci/codeci/server/pipeline"
	"github.com/codeci/codeci/server/script"
	"github.com/codeci/codeci/server/terminal"
)

func main() {
	cfg := config.Load()

	// CLI dispatch — `./main admin <subcommand>` runs ops tasks against the
	// configured DB and exits without booting the HTTP server. Used via
	// `docker exec <container> ./main admin ...` for recovery operations.
	if len(os.Args) > 1 && os.Args[1] == "admin" {
		os.Exit(admin.Run(os.Args[2:], cfg))
	}

	database, err := db.Init(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db init: %v", err)
	}

	seedAppSettingsFromEnv(database, cfg)

	loader := pipeline.NewLoader(cfg.PipelinesDir)
	scriptLoader := script.NewLoader(cfg.ScriptsDir)

	registry := execution.NewRegistry()
	awsClients := awspkg.New(context.Background())

	// Scheduler owns the per-pipeline concurrency check and the queued-run
	// dispatch loop. RecoverOnStartup marks any rows left in status="running"
	// from a prior crash as failed, then re-dispatches queued rows up to
	// each pipeline's declared limit. Must run before HTTP traffic.
	scheduler := execution.NewScheduler(database, cfg, registry, awsClients, loader)
	scheduler.RecoverOnStartup()

	sessionTTL := time.Duration(cfg.SessionTimeoutHours) * time.Hour

	authHandler := auth.NewHandler(database, cfg.JWTSecret, cfg.TOTPEncryptionKey, cfg.DisableTOTP, sessionTTL)
	entraHandler := auth.NewEntraHandler(database, cfg.JWTSecret, cfg.TOTPEncryptionKey, sessionTTL, cfg.AllowedOrigin)
	apiHandler := api.NewHandler(database, loader, scriptLoader, cfg, registry, scheduler, Version)
	v1Handler := api.NewV1Handler(database, loader, scriptLoader, cfg, registry, scheduler, awsClients, Version)
	wsHandler := execution.NewHandler(database, loader, cfg, registry, scheduler, awsClients)
	scriptWsHandler := execution.NewScriptHandler(database, scriptLoader, cfg)

	githubProvider := gh.NewOAuthAppProvider(database, cfg.TOTPEncryptionKey)
	githubHandler := api.NewGitHubHandler(database, cfg, loader, registry, scheduler, awsClients, githubProvider)
	if err := githubHandler.EnsureSystemUserAtBoot(); err != nil {
		log.Printf("github webhook system user init: %v (will retry on first delivery)", err)
	}

	var terminalHandler *terminal.Handler
	if cfg.TerminalEnabled {
		if err := terminal.EnsureStorageDirs(cfg.TerminalStoragePath); err != nil {
			log.Fatalf("terminal storage init: %v", err)
		}
		terminalRegistry := terminal.NewRegistry()
		terminalHandler = terminal.NewHandler(cfg.JWTSecret, terminalRegistry, cfg.TerminalStoragePath)
	}

	e := echo.New()
	e.HideBanner = true

	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{cfg.AllowedOrigin},
		AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions},
		AllowHeaders: []string{echo.HeaderAuthorization, echo.HeaderContentType},
	}))

	// Rate limiting on auth endpoints
	authLimiter := middleware.RateLimiter(middleware.NewRateLimiterMemoryStore(10))

	// Public probe — login page asks this before rendering "Sign in with Microsoft".
	e.GET("/api/config/auth", apiHandler.GetAuthConfig)
	// Public app metadata (name + version) — needed before login to brand the UI.
	e.GET("/api/config/app", apiHandler.GetAppConfig)

	// Public auth routes
	a := e.Group("/api/auth")
	a.GET("/setup", authHandler.SetupStatus)
	a.POST("/register", authHandler.Register, authLimiter)
	a.POST("/login", authHandler.Login, authLimiter)
	a.POST("/totp/setup", authHandler.TOTPSetup, auth.RequireAuth(cfg.JWTSecret))
	a.POST("/totp/verify", authHandler.TOTPVerify, auth.RequireAuth(cfg.JWTSecret), authLimiter)
	// Self-service auth management (require full auth)
	a.DELETE("/totp", authHandler.TOTPDisable, auth.RequireTOTP(cfg.JWTSecret, cfg.DisableTOTP))
	a.PUT("/password", authHandler.ChangePassword, auth.RequireTOTP(cfg.JWTSecret, cfg.DisableTOTP))
	// Entra ID OIDC flow (rate-limited; both unauthenticated by design)
	a.GET("/entra/login", entraHandler.Login, authLimiter)
	a.GET("/entra/callback", entraHandler.Callback, authLimiter)
	// GitHub OAuth callback — verified by HMAC-signed state cookie set by Connect()
	a.GET("/github/callback", githubHandler.OAuthCallback, authLimiter)

	// Public webhook endpoints — verified by HMAC (github) or bcrypt token (manual).
	// Higher rate-limit than the auth routes because legitimate webhooks may
	// burst (e.g. a force-push triggers many push events back-to-back).
	webhookLimiter := middleware.RateLimiter(middleware.NewRateLimiterMemoryStore(30))
	e.POST("/api/webhooks/github", githubHandler.GitHubWebhook, webhookLimiter)
	e.POST("/api/webhooks/manual/:trigger_id", githubHandler.ManualWebhook, webhookLimiter)

	// Protected API routes (require full auth including TOTP)
	protected := e.Group("/api", auth.RequireTOTP(cfg.JWTSecret, cfg.DisableTOTP))
	protected.GET("/me", apiHandler.GetMe)
	protected.GET("/me/permissions", apiHandler.GetMyPermissions)
	// Visibility + read-op filtering happens inside ListPipelines/GetPipeline.
	// Mutating endpoints are gated by RequireOperation middleware.
	protected.GET("/pipelines", apiHandler.ListPipelines)
	protected.GET("/pipelines/export", apiHandler.ExportPipelines, auth.RequireOperation(database, auth.OpPipelinesWrite))
	protected.POST("/pipelines/import", apiHandler.ImportPipelines, auth.RequireOperation(database, auth.OpPipelinesWrite))
	protected.POST("/pipelines", apiHandler.CreatePipeline, auth.RequireOperation(database, auth.OpPipelinesWrite))
	protected.GET("/pipelines/:id", apiHandler.GetPipeline)
	protected.GET("/pipelines/:id/raw", apiHandler.GetPipelineRaw)
	protected.PUT("/pipelines/:id", apiHandler.UpdatePipeline, auth.RequireOperation(database, auth.OpPipelinesWrite))
	protected.DELETE("/pipelines/:id", apiHandler.DeletePipeline, auth.RequireOperation(database, auth.OpPipelinesDelete))
	protected.GET("/git/branches", apiHandler.GitBranches)
	protected.GET("/scripts", apiHandler.ListScripts)
	protected.GET("/scripts/export", apiHandler.ExportScripts, auth.RequireOperation(database, auth.OpScriptsWrite))
	protected.POST("/scripts", apiHandler.CreateScript, auth.RequireOperation(database, auth.OpScriptsWrite))
	protected.GET("/scripts/:id", apiHandler.GetScript)
	protected.PUT("/scripts/:id", apiHandler.UpdateScript, auth.RequireOperation(database, auth.OpScriptsWrite))
	protected.DELETE("/scripts/:id", apiHandler.DeleteScript, auth.RequireOperation(database, auth.OpScriptsDelete))
	protected.GET("/stats", apiHandler.GetDashboardStats)
	protected.GET("/runs", apiHandler.ListRuns)
	protected.GET("/runs/active", apiHandler.ListActiveRuns)
	protected.DELETE("/runs", apiHandler.ClearRuns)
	protected.GET("/runs/:id", apiHandler.GetRun)
	protected.GET("/runs/:id/logs", apiHandler.GetRunLogs)
	protected.POST("/runs/:id/cancel", apiHandler.CancelRun)
	protected.DELETE("/runs/:id", apiHandler.DeleteRun)
	if cfg.TerminalEnabled {
		protected.GET("/terminal/status", terminalHandler.Status)
	}
	// Self-service API key management (UI-issued via the user's JWT session).
	// Creation is gated by the apikeys:issue_self operation so an admin can
	// disable it for some users without removing their UI access entirely.
	protected.GET("/me/api-keys", apiHandler.ListMyAPIKeys)
	protected.POST("/me/api-keys", apiHandler.CreateMyAPIKey, auth.RequireOperation(database, auth.OpAPIKeysIssueSelf))
	protected.DELETE("/me/api-keys/:id", apiHandler.RevokeMyAPIKey)
	protected.GET("/me/favorites", apiHandler.ListMyFavorites)
	protected.POST("/me/favorites/:pipelineId", apiHandler.AddMyFavorite)
	protected.DELETE("/me/favorites/:pipelineId", apiHandler.RemoveMyFavorite)

	// Admin-only routes (require full auth + admin role)
	adminRoutes := protected.Group("", auth.RequireAdmin)
	adminRoutes.GET("/admin/users", apiHandler.ListUsers)
	adminRoutes.POST("/admin/users", apiHandler.CreateUser)
	adminRoutes.PUT("/admin/users/:id", apiHandler.UpdateUser)
	adminRoutes.DELETE("/admin/users/:id", apiHandler.DeleteUser)
	adminRoutes.GET("/admin/users/:id/groups", apiHandler.GetUserGroups)
	adminRoutes.PUT("/admin/users/:id/groups", apiHandler.SetUserGroups)
	adminRoutes.GET("/admin/groups", apiHandler.ListGroups)
	adminRoutes.POST("/admin/groups", apiHandler.CreateGroup)
	adminRoutes.GET("/admin/groups/:id", apiHandler.GetGroup)
	adminRoutes.PUT("/admin/groups/:id", apiHandler.UpdateGroup)
	adminRoutes.DELETE("/admin/groups/:id", apiHandler.DeleteGroup)
	adminRoutes.GET("/admin/settings", apiHandler.GetSettings)
	adminRoutes.PUT("/admin/settings", apiHandler.UpdateSettings)
	adminRoutes.GET("/admin/api-keys", apiHandler.AdminListAPIKeys)
	adminRoutes.POST("/admin/api-keys", apiHandler.AdminCreateAPIKey)
	adminRoutes.DELETE("/admin/api-keys/:id", apiHandler.AdminRevokeAPIKey)
	adminRoutes.GET("/admin/github/status", githubHandler.Status)
	adminRoutes.POST("/admin/github/connect", githubHandler.Connect)
	adminRoutes.POST("/admin/github/disconnect", githubHandler.Disconnect)
	adminRoutes.GET("/admin/github/repos", githubHandler.ListRepos)
	adminRoutes.GET("/admin/github/branches", githubHandler.ListBranches)
	adminRoutes.GET("/pipelines/:id/trigger", githubHandler.GetTrigger)
	adminRoutes.PUT("/pipelines/:id/trigger", githubHandler.PutTrigger)
	adminRoutes.DELETE("/pipelines/:id/trigger", githubHandler.DeleteTrigger)
	adminRoutes.POST("/pipelines/:id/trigger/test", githubHandler.TestTrigger)

	// ── Programmatic /api/v1 surface for CI systems and LLM agents.
	// Accepts JWT or API key. Unauth probes (health + OpenAPI) are mounted
	// outside the middleware group so agents can read the schema first.
	e.GET("/api/v1/health", v1Handler.Health)
	e.GET("/api/v1/openapi.json", v1Handler.OpenAPI)

	v1 := e.Group("/api/v1", auth.RequireAPIKeyOrJWT(cfg.JWTSecret, cfg.DisableTOTP, database))
	v1.GET("/me", v1Handler.Me)
	v1.GET("/pipelines", v1Handler.ListPipelines)
	v1.GET("/pipelines/:id", v1Handler.GetPipeline)
	v1.POST("/pipelines/:id/runs", v1Handler.TriggerRun)
	v1.GET("/runs", v1Handler.ListRuns)
	v1.GET("/runs/:id", v1Handler.GetRun)
	v1.GET("/runs/:id/logs", v1Handler.GetRunLogs)
	v1.POST("/runs/:id/cancel", v1Handler.CancelRun)
	v1.GET("/scripts", v1Handler.ListScripts)

	// WebSocket execution endpoints (auth via query param)
	e.GET("/ws/execute/:pipelineId", wsHandler.Execute)
	e.GET("/ws/scripts/:id", scriptWsHandler.Execute)
	if cfg.TerminalEnabled {
		e.GET("/ws/terminal", terminalHandler.Attach)
	}

	log.Printf("Server starting on :%s", cfg.Port)
	if err := e.Start(":" + cfg.Port); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
}

// seedAppSettingsFromEnv populates env-seedable settings columns the first time
// the server boots with an unconfigured AppSettings row. Once the DB has any
// value for a given column, the env var is ignored — the settings UI is the
// source of truth from then on. Covers ApplicationName and the four ENTRA_*
// values.
func seedAppSettingsFromEnv(database *gorm.DB, cfg *config.Config) {
	var s db.AppSettings
	if err := database.First(&s, 1).Error; err != nil {
		return
	}

	updates := map[string]any{}
	// ApplicationName seeds from env only when DB is at the default. The default
	// is also "Codeci", so an admin who renames it via Settings won't be
	// silently overridden by an env var on the next boot.
	if s.ApplicationName == "Codeci" && cfg.ApplicationName != "" && cfg.ApplicationName != s.ApplicationName {
		updates["application_name"] = cfg.ApplicationName
	}
	if s.EntraClientID == "" && cfg.EntraClientID != "" {
		updates["entra_client_id"] = cfg.EntraClientID
	}
	if s.EntraTenantID == "" && cfg.EntraTenantID != "" {
		updates["entra_tenant_id"] = cfg.EntraTenantID
	}
	if s.EntraRedirectURL == "" && cfg.EntraRedirectURL != "" {
		updates["entra_redirect_url"] = cfg.EntraRedirectURL
	}
	if s.EntraClientSecret == "" && cfg.EntraClientSecret != "" && cfg.TOTPEncryptionKey != "" {
		ciphertext, err := auth.EncryptSecret(cfg.EntraClientSecret, cfg.TOTPEncryptionKey)
		if err == nil {
			updates["entra_client_secret"] = ciphertext
		}
	}
	if len(updates) > 0 {
		database.Model(&db.AppSettings{}).Where("id = ?", 1).Updates(updates)
	}
}
