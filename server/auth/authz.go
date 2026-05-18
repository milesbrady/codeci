package auth

// Group-based authorization. Two pieces:
//
//   1. Operation tokens (the canonical list below) — strings checked at
//      mutating endpoints via RequireOperation middleware.
//   2. Resource visibility — which pipeline / script IDs a user may see.
//      Loaded once per request and cached on echo.Context so handlers can
//      filter list output and reject direct-by-ID reads.
//
// Admins (User.Role == "admin") bypass both: LoadEffectivePermissions
// returns a permissions object with all operations and "all" visibility.

import (
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
	"gorm.io/gorm"

	dbpkg "github.com/codeci/codeci/server/db"
)

const (
	OpPipelinesRead    = "pipelines:read"
	OpPipelinesRun     = "pipelines:run"
	OpPipelinesWrite   = "pipelines:write"
	OpPipelinesDelete  = "pipelines:delete"
	OpScriptsRead      = "scripts:read"
	OpScriptsRun       = "scripts:run"
	OpScriptsWrite     = "scripts:write"
	OpScriptsDelete    = "scripts:delete"
	OpRunsReadAll      = "runs:read_all"
	OpAPIKeysIssueSelf = "apikeys:issue_self"
)

// AllOperations is the canonical, ordered list used by the UI to render
// permission checkboxes. Add new operation tokens here AND wire them at
// the route in main.go.
var AllOperations = []string{
	OpPipelinesRead, OpPipelinesRun, OpPipelinesWrite, OpPipelinesDelete,
	OpScriptsRead, OpScriptsRun, OpScriptsWrite, OpScriptsDelete,
	OpRunsReadAll, OpAPIKeysIssueSelf,
}

// permissionsContextKey caches the per-request permission set so handlers
// chained after a RequireOperation middleware don't re-query the DB.
const permissionsContextKey = "permissions"

// EffectivePermissions is the union of a user's group memberships, plus a
// flag for admin bypass. AllPipelines / AllScripts mean "no filtering" —
// when true, the corresponding ID set is ignored.
type EffectivePermissions struct {
	IsAdmin      bool
	Operations   map[string]bool
	AllPipelines bool
	PipelineIDs  map[string]bool
	AllScripts   bool
	ScriptIDs    map[string]bool
}

// LoadEffectivePermissions computes the user's effective permissions by
// unioning every group they're a member of. Admin role short-circuits to
// a permit-all set. Always returns non-nil.
func LoadEffectivePermissions(database *gorm.DB, userID uint, isAdmin bool) *EffectivePermissions {
	p := &EffectivePermissions{
		IsAdmin:     isAdmin,
		Operations:  map[string]bool{},
		PipelineIDs: map[string]bool{},
		ScriptIDs:   map[string]bool{},
	}
	if isAdmin {
		p.AllPipelines = true
		p.AllScripts = true
		for _, op := range AllOperations {
			p.Operations[op] = true
		}
		return p
	}

	var groups []dbpkg.Group
	database.Joins("JOIN user_groups ON user_groups.group_id = groups.id").
		Where("user_groups.user_id = ?", userID).
		Find(&groups)

	var groupIDs []uint
	for _, g := range groups {
		groupIDs = append(groupIDs, g.ID)
		for _, op := range strings.Split(g.Operations, ",") {
			op = strings.TrimSpace(op)
			if op != "" {
				p.Operations[op] = true
			}
		}
		if g.PipelineMode == "all" {
			p.AllPipelines = true
		}
		if g.ScriptMode == "all" {
			p.AllScripts = true
		}
	}

	if !p.AllPipelines && len(groupIDs) > 0 {
		var rows []dbpkg.GroupPipelineAccess
		database.Where("group_id IN ?", groupIDs).Find(&rows)
		for _, r := range rows {
			p.PipelineIDs[r.PipelineID] = true
		}
	}
	if !p.AllScripts && len(groupIDs) > 0 {
		var rows []dbpkg.GroupScriptAccess
		database.Where("group_id IN ?", groupIDs).Find(&rows)
		for _, r := range rows {
			p.ScriptIDs[r.ScriptID] = true
		}
	}

	return p
}

// Has reports whether the user holds the given operation token. Nil-safe
// so call sites don't need to guard against a missing permissions object.
func (p *EffectivePermissions) Has(op string) bool {
	if p == nil {
		return false
	}
	return p.Operations[op]
}

func (p *EffectivePermissions) CanSeePipeline(id string) bool {
	if p == nil {
		return false
	}
	if p.AllPipelines {
		return true
	}
	return p.PipelineIDs[id]
}

func (p *EffectivePermissions) CanSeeScript(id string) bool {
	if p == nil {
		return false
	}
	if p.AllScripts {
		return true
	}
	return p.ScriptIDs[id]
}

// RequireOperation is middleware that gates a route on a specific operation
// token. Chain it after RequireTOTP. Admins always pass. The computed
// EffectivePermissions is cached on the echo.Context so the handler can
// call GetPermissions without re-hitting the DB.
func RequireOperation(database *gorm.DB, op string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			claims := GetClaims(c)
			if claims == nil {
				return echo.NewHTTPError(http.StatusUnauthorized, "unauthorized")
			}
			p := LoadEffectivePermissions(database, claims.UserID, claims.IsAdmin)
			if !p.Has(op) {
				return echo.NewHTTPError(http.StatusForbidden, "missing required permission: "+op)
			}
			c.Set(permissionsContextKey, p)
			return next(c)
		}
	}
}

// GetPermissions returns the cached EffectivePermissions for this request,
// loading them lazily if no middleware has already done so. Always returns
// non-nil for an authenticated request.
func GetPermissions(c echo.Context, database *gorm.DB) *EffectivePermissions {
	if v := c.Get(permissionsContextKey); v != nil {
		if p, ok := v.(*EffectivePermissions); ok {
			return p
		}
	}
	claims := GetClaims(c)
	if claims == nil {
		return &EffectivePermissions{Operations: map[string]bool{}, PipelineIDs: map[string]bool{}, ScriptIDs: map[string]bool{}}
	}
	p := LoadEffectivePermissions(database, claims.UserID, claims.IsAdmin)
	c.Set(permissionsContextKey, p)
	return p
}
