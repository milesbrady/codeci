package api

// Admin-only CRUD for groups, plus the per-user group-membership endpoint
// and a "me/permissions" endpoint the frontend uses to gate nav items and
// route components. Mutations validate operation tokens against the
// canonical list in auth.AllOperations so unknown strings can't sneak into
// the DB and silently fail to enforce anything.

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/codeci/codeci/server/auth"
	dbpkg "github.com/codeci/codeci/server/db"
)

type groupInfo struct {
	ID           uint      `json:"id"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	IsSystem     bool      `json:"is_system"`
	PipelineMode string    `json:"pipeline_mode"`
	ScriptMode   string    `json:"script_mode"`
	Operations   []string  `json:"operations"`
	PipelineIDs  []string  `json:"pipeline_ids"`
	ScriptIDs    []string  `json:"script_ids"`
	MemberCount  int       `json:"member_count"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func splitOps(s string) []string {
	if s == "" {
		return []string{}
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// normalizeOperations drops empty strings + unknown tokens and de-dupes.
// Returns the cleaned slice plus any rejected tokens (for an explicit
// 400 — silently dropping would hide typos).
func normalizeOperations(ops []string) (clean []string, unknown []string) {
	allowed := map[string]bool{}
	for _, op := range auth.AllOperations {
		allowed[op] = true
	}
	seen := map[string]bool{}
	for _, op := range ops {
		op = strings.TrimSpace(op)
		if op == "" || seen[op] {
			continue
		}
		seen[op] = true
		if !allowed[op] {
			unknown = append(unknown, op)
			continue
		}
		clean = append(clean, op)
	}
	sort.Strings(clean)
	return clean, unknown
}

func normalizeMode(m string) string {
	if m == "selected" {
		return "selected"
	}
	return "all"
}

// loadGroupInfo hydrates a single Group + its access rows + member count
// into the wire format. Pulled out so list + get + create + update can
// return identical shapes.
func (h *Handler) loadGroupInfo(g *dbpkg.Group) groupInfo {
	var pipelineIDs []string
	var scriptIDs []string
	if g.PipelineMode == "selected" {
		var rows []dbpkg.GroupPipelineAccess
		h.db.Where("group_id = ?", g.ID).Find(&rows)
		for _, r := range rows {
			pipelineIDs = append(pipelineIDs, r.PipelineID)
		}
	}
	if g.ScriptMode == "selected" {
		var rows []dbpkg.GroupScriptAccess
		h.db.Where("group_id = ?", g.ID).Find(&rows)
		for _, r := range rows {
			scriptIDs = append(scriptIDs, r.ScriptID)
		}
	}
	sort.Strings(pipelineIDs)
	sort.Strings(scriptIDs)

	var count int64
	h.db.Model(&dbpkg.UserGroup{}).Where("group_id = ?", g.ID).Count(&count)

	ops := splitOps(g.Operations)
	sort.Strings(ops)
	if pipelineIDs == nil {
		pipelineIDs = []string{}
	}
	if scriptIDs == nil {
		scriptIDs = []string{}
	}
	return groupInfo{
		ID:           g.ID,
		Name:         g.Name,
		Description:  g.Description,
		IsSystem:     g.IsSystem,
		PipelineMode: g.PipelineMode,
		ScriptMode:   g.ScriptMode,
		Operations:   ops,
		PipelineIDs:  pipelineIDs,
		ScriptIDs:    scriptIDs,
		MemberCount:  int(count),
		CreatedAt:    g.CreatedAt,
		UpdatedAt:    g.UpdatedAt,
	}
}

// GET /api/admin/groups
func (h *Handler) ListGroups(c echo.Context) error {
	var groups []dbpkg.Group
	h.db.Order("is_system desc, name asc").Find(&groups)
	out := make([]groupInfo, 0, len(groups))
	for i := range groups {
		out = append(out, h.loadGroupInfo(&groups[i]))
	}
	return c.JSON(http.StatusOK, out)
}

// GET /api/admin/groups/:id
func (h *Handler) GetGroup(c echo.Context) error {
	var g dbpkg.Group
	if err := h.db.First(&g, c.Param("id")).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "group not found")
	}
	// Include members so the edit drawer can show / remove them in one fetch.
	type member struct {
		ID       uint   `json:"id"`
		Username string `json:"username"`
		Email    string `json:"email"`
		Role     string `json:"role"`
	}
	var rows []struct {
		ID       uint
		Username string
		Email    *string
		Role     string
	}
	h.db.Table("users").
		Select("users.id, users.username, users.email, users.role").
		Joins("JOIN user_groups ON user_groups.user_id = users.id").
		Where("user_groups.group_id = ?", g.ID).
		Order("users.username asc").
		Find(&rows)
	members := make([]member, 0, len(rows))
	for _, r := range rows {
		email := ""
		if r.Email != nil {
			email = *r.Email
		}
		members = append(members, member{ID: r.ID, Username: r.Username, Email: email, Role: r.Role})
	}
	info := h.loadGroupInfo(&g)
	return c.JSON(http.StatusOK, echo.Map{
		"group":   info,
		"members": members,
	})
}

type groupWriteReq struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	PipelineMode string   `json:"pipeline_mode"`
	ScriptMode   string   `json:"script_mode"`
	Operations   []string `json:"operations"`
	PipelineIDs  []string `json:"pipeline_ids"`
	ScriptIDs    []string `json:"script_ids"`
}

// POST /api/admin/groups
func (h *Handler) CreateGroup(c echo.Context) error {
	var req groupWriteReq
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "name required")
	}
	if len(name) > 64 {
		return echo.NewHTTPError(http.StatusBadRequest, "name must be 64 characters or fewer")
	}
	ops, unknown := normalizeOperations(req.Operations)
	if len(unknown) > 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "unknown operation(s): "+strings.Join(unknown, ", "))
	}
	g := dbpkg.Group{
		Name:         name,
		Description:  strings.TrimSpace(req.Description),
		PipelineMode: normalizeMode(req.PipelineMode),
		ScriptMode:   normalizeMode(req.ScriptMode),
		Operations:   strings.Join(ops, ","),
	}
	if err := h.db.Create(&g).Error; err != nil {
		return echo.NewHTTPError(http.StatusConflict, "group name already exists")
	}
	h.writeGroupAccess(g.ID, g.PipelineMode, g.ScriptMode, req.PipelineIDs, req.ScriptIDs)
	return c.JSON(http.StatusCreated, h.loadGroupInfo(&g))
}

// PUT /api/admin/groups/:id
func (h *Handler) UpdateGroup(c echo.Context) error {
	var g dbpkg.Group
	if err := h.db.First(&g, c.Param("id")).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "group not found")
	}
	var req groupWriteReq
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "name required")
	}
	if len(name) > 64 {
		return echo.NewHTTPError(http.StatusBadRequest, "name must be 64 characters or fewer")
	}
	ops, unknown := normalizeOperations(req.Operations)
	if len(unknown) > 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "unknown operation(s): "+strings.Join(unknown, ", "))
	}

	// System groups: name + IsSystem are immutable. Everything else
	// (operations, pipeline/script scope, description) is editable so an
	// admin can tighten the default group without recreating it.
	updates := map[string]any{
		"description":   strings.TrimSpace(req.Description),
		"pipeline_mode": normalizeMode(req.PipelineMode),
		"script_mode":   normalizeMode(req.ScriptMode),
		"operations":    strings.Join(ops, ","),
	}
	if !g.IsSystem {
		updates["name"] = name
	}
	if err := h.db.Model(&g).Updates(updates).Error; err != nil {
		return echo.NewHTTPError(http.StatusConflict, "name conflict")
	}
	// Refresh local copy so writeGroupAccess sees the new modes.
	h.db.First(&g, g.ID)
	h.writeGroupAccess(g.ID, g.PipelineMode, g.ScriptMode, req.PipelineIDs, req.ScriptIDs)
	return c.JSON(http.StatusOK, h.loadGroupInfo(&g))
}

// DELETE /api/admin/groups/:id
func (h *Handler) DeleteGroup(c echo.Context) error {
	var g dbpkg.Group
	if err := h.db.First(&g, c.Param("id")).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "group not found")
	}
	if g.IsSystem {
		return echo.NewHTTPError(http.StatusBadRequest, "system group cannot be deleted")
	}
	h.db.Where("group_id = ?", g.ID).Delete(&dbpkg.UserGroup{})
	h.db.Where("group_id = ?", g.ID).Delete(&dbpkg.GroupPipelineAccess{})
	h.db.Where("group_id = ?", g.ID).Delete(&dbpkg.GroupScriptAccess{})
	h.db.Delete(&g)
	return c.JSON(http.StatusOK, echo.Map{"message": "group deleted"})
}

// writeGroupAccess replaces the GroupPipelineAccess / GroupScriptAccess rows
// for a group. Called from Create + Update. When the mode is "all" we wipe
// any selected-IDs (otherwise switching back to "selected" later would leak
// the stale set).
func (h *Handler) writeGroupAccess(groupID uint, pipelineMode, scriptMode string, pipelineIDs, scriptIDs []string) {
	h.db.Where("group_id = ?", groupID).Delete(&dbpkg.GroupPipelineAccess{})
	if pipelineMode == "selected" {
		seen := map[string]bool{}
		for _, id := range pipelineIDs {
			id = strings.TrimSpace(id)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			h.db.Create(&dbpkg.GroupPipelineAccess{GroupID: groupID, PipelineID: id})
		}
	}
	h.db.Where("group_id = ?", groupID).Delete(&dbpkg.GroupScriptAccess{})
	if scriptMode == "selected" {
		seen := map[string]bool{}
		for _, id := range scriptIDs {
			id = strings.TrimSpace(id)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			h.db.Create(&dbpkg.GroupScriptAccess{GroupID: groupID, ScriptID: id})
		}
	}
}

// --- Per-user group membership ---

// GET /api/admin/users/:id/groups — returns the group IDs the user belongs to.
func (h *Handler) GetUserGroups(c echo.Context) error {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid user id")
	}
	var rows []dbpkg.UserGroup
	h.db.Where("user_id = ?", id).Find(&rows)
	out := make([]uint, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.GroupID)
	}
	return c.JSON(http.StatusOK, echo.Map{"group_ids": out})
}

// PUT /api/admin/users/:id/groups — sets the user's group memberships to
// the given list (replaces, not merges).
func (h *Handler) SetUserGroups(c echo.Context) error {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid user id")
	}
	var user dbpkg.User
	if err := h.db.First(&user, id).Error; err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}
	var req struct {
		GroupIDs []uint `json:"group_ids"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	// Validate every ID exists before any mutation so a typo doesn't
	// leave the user with a partial set.
	if len(req.GroupIDs) > 0 {
		var count int64
		h.db.Model(&dbpkg.Group{}).Where("id IN ?", req.GroupIDs).Count(&count)
		if int(count) != len(uniqueUints(req.GroupIDs)) {
			return echo.NewHTTPError(http.StatusBadRequest, "one or more group_ids do not exist")
		}
	}

	h.db.Where("user_id = ?", user.ID).Delete(&dbpkg.UserGroup{})
	seen := map[uint]bool{}
	for _, gid := range req.GroupIDs {
		if seen[gid] {
			continue
		}
		seen[gid] = true
		h.db.Create(&dbpkg.UserGroup{UserID: user.ID, GroupID: gid})
	}
	return c.JSON(http.StatusOK, echo.Map{"message": "groups updated", "count": len(seen)})
}

func uniqueUints(in []uint) []uint {
	seen := map[uint]bool{}
	out := make([]uint, 0, len(in))
	for _, v := range in {
		if seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// GET /api/me/permissions — the frontend calls this after login to gate
// nav items + route guards. Returns the effective operation set and the
// allowed pipeline/script IDs (or `all_*: true` when unfiltered). Always
// returns "all" everything for admins.
func (h *Handler) GetMyPermissions(c echo.Context) error {
	claims := auth.GetClaims(c)
	if claims == nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "unauthorized")
	}
	p := auth.LoadEffectivePermissions(h.db, claims.UserID, claims.IsAdmin)

	ops := make([]string, 0, len(p.Operations))
	for op := range p.Operations {
		ops = append(ops, op)
	}
	sort.Strings(ops)
	pipelineIDs := make([]string, 0, len(p.PipelineIDs))
	for id := range p.PipelineIDs {
		pipelineIDs = append(pipelineIDs, id)
	}
	sort.Strings(pipelineIDs)
	scriptIDs := make([]string, 0, len(p.ScriptIDs))
	for id := range p.ScriptIDs {
		scriptIDs = append(scriptIDs, id)
	}
	sort.Strings(scriptIDs)

	return c.JSON(http.StatusOK, echo.Map{
		"is_admin":        p.IsAdmin,
		"operations":      ops,
		"all_operations":  auth.AllOperations,
		"all_pipelines":   p.AllPipelines,
		"pipeline_ids":    pipelineIDs,
		"all_scripts":     p.AllScripts,
		"script_ids":      scriptIDs,
	})
}
