package db

import (
	"time"

	"gorm.io/gorm"
)

type User struct {
	gorm.Model
	Username           string `gorm:"uniqueIndex;not null"`
	PassHash           string `gorm:"default:''"`
	Email              *string `gorm:"uniqueIndex"`
	AuthProvider       string `gorm:"not null;default:'local'"` // local | entra
	TOTPSecret         string `gorm:"not null;default:''"`
	TOTPEnabled        bool   `gorm:"not null;default:false"`
	Role               string `gorm:"not null;default:'user'"` // admin | user
	MustChangePassword bool   `gorm:"not null;default:false"`
}

type ExecutionRun struct {
	// Fields from gorm.Model are unrolled so we can attach a compound-index
	// tag to CreatedAt. idx_runs_status_created backs the ListRuns,
	// ActiveRuns, and RunHistory paths, which all filter by status and
	// order by created_at DESC.
	ID        uint `gorm:"primaryKey"`
	CreatedAt time.Time `gorm:"index:idx_runs_status_created,priority:3"`
	UpdatedAt time.Time
	DeletedAt gorm.DeletedAt `gorm:"index"`

	PipelineID   string `gorm:"not null;index"`
	PipelineName string `gorm:"not null"`
	UserID       uint   `gorm:"not null;index;index:idx_runs_user_status,priority:1"`
	UserName     string `gorm:"not null;default:''"`
	ParamsJSON   string `gorm:"type:text;not null;default:'{}'"`
	LogsJSON     string `gorm:"type:text;not null;default:'[]'"`
	Status       string `gorm:"not null;default:'running';index:idx_runs_status_created,priority:1;index:idx_runs_user_status,priority:2"`
	StartedAt    time.Time `gorm:"not null"`
	FinishedAt   *time.Time
}

// APIKey is a long-lived bearer token issued to a user for programmatic
// access by external systems (CI, LLM agents). The plaintext value is
// returned only at creation; the DB stores its SHA-256 hex digest so a
// stolen DB snapshot cannot be used to authenticate. PrefixHint is the
// first 12 chars of the plaintext, kept for UI display ("idk_a1b2c3d4…")
// so users can recognize which key is which without revealing the secret.
type APIKey struct {
	ID          uint   `gorm:"primaryKey"`
	UserID      uint   `gorm:"not null;index"`
	Name        string `gorm:"not null"` // user-supplied label
	KeyHash     string `gorm:"not null;uniqueIndex"`
	PrefixHint  string `gorm:"not null"` // first 12 plaintext chars, for display
	CreatedAt   time.Time
	LastUsedAt  *time.Time
	RevokedAt   *time.Time
	ExpiresAt   *time.Time // nullable — null means never expires
}

// UserFavorite pins a pipeline to the top of a user's pipeline list.
// The (user_id, pipeline_id) pair is unique so POSTs are idempotent.
type UserFavorite struct {
	ID         uint   `gorm:"primaryKey"`
	UserID     uint   `gorm:"not null;uniqueIndex:idx_user_fav_unique,priority:1;index"`
	PipelineID string `gorm:"not null;uniqueIndex:idx_user_fav_unique,priority:2"`
	CreatedAt  time.Time
}

type AppSettings struct {
	ID                   uint   `gorm:"primaryKey"`
	ApplicationName      string `gorm:"not null;default:'Codeci'"`
	RunnerTimeoutMinutes int    `gorm:"not null;default:60"`
	PipelineHistoryLimit int    `gorm:"not null;default:50"`
	EntraEnabled         bool   `gorm:"not null;default:false"`
	EntraClientID        string `gorm:"not null;default:''"`
	EntraTenantID        string `gorm:"not null;default:''"`
	EntraClientSecret    string `gorm:"not null;default:''"` // AES-256-GCM ciphertext
	EntraRedirectURL     string `gorm:"not null;default:''"`

	// GitHub central connection. Provider selects the implementation:
	// "oauth_app" is the only one shipped today; "github_app" is reserved.
	// ClientSecret / WebhookSecret / AccessToken are AES-256-GCM ciphertext.
	GitHubEnabled        bool       `gorm:"not null;default:false"`
	GitHubProvider       string     `gorm:"not null;default:'oauth_app'"`
	GitHubClientID       string     `gorm:"not null;default:''"`
	GitHubClientSecret   string     `gorm:"not null;default:''"`
	GitHubWebhookSecret  string     `gorm:"not null;default:''"`
	GitHubAccessToken    string     `gorm:"not null;default:''"`
	GitHubConnectedLogin string     `gorm:"not null;default:''"`
	GitHubConnectedAt    *time.Time
}

// PipelineTrigger maps an external event source (GitHub push/PR/release, or a
// generic signed HTTP POST) to a pipeline that should run when the event
// fires. DefaultParamsJSON is the locked-in parameter set used for every
// run kicked off by this trigger — webhook payloads do not supply params.
//
// The (provider, repo_owner, repo_name) composite is the lookup key the
// webhook handler uses to find matching rows; for "manual" provider the
// row is matched directly by primary key in the URL.
type PipelineTrigger struct {
	ID                uint   `gorm:"primaryKey"`
	PipelineID        string `gorm:"not null;index:idx_trigger_pipeline"`
	Provider          string `gorm:"not null;default:'github';index:idx_trigger_match,priority:1"` // github | manual
	RepoOwner         string `gorm:"not null;default:'';index:idx_trigger_match,priority:2"`
	RepoName          string `gorm:"not null;default:'';index:idx_trigger_match,priority:3"`
	Branch            string `gorm:"not null;default:''"`           // exact ref (e.g. "main"); empty = any
	Events            string `gorm:"not null;default:'push'"`       // comma list: push,pull_request,release
	GitHubHookID      *int64                                          // numeric id returned by GitHub when codeci registered the hook
	ManualSecretHash  string `gorm:"not null;default:''"`           // bcrypt hash of the per-trigger plaintext token (manual only)
	ManualSecretHint  string `gorm:"not null;default:''"`           // first 8 plaintext chars for UI recognition
	DefaultParamsJSON string `gorm:"type:text;not null;default:'{}'"`
	Active            bool   `gorm:"not null;default:true"`
	CreatedByUserID   uint   `gorm:"not null"`
	LastFiredAt       *time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}
