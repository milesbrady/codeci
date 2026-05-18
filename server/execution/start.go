// start.go — shared run-lifecycle types and helpers.
//
// The actual "start a run" logic lives on the Scheduler (scheduler.go) so
// that the per-pipeline concurrency check cannot be bypassed by any caller.
// This file keeps the cross-transport input shape (StartRunOpts) and the
// completed-run pruning helper that the dispatch goroutine invokes.
package execution

import (
	"gorm.io/gorm"

	dbpkg "github.com/codeci/codeci/server/db"
	"github.com/codeci/codeci/server/pipeline"
)

// StartRunOpts is the cross-transport input for kicking off a pipeline.
// All callers (WebSocket, REST trigger, webhook, /api/v1) marshal their
// request into this shape and hand it to Scheduler.Submit so lifecycle
// rules (concurrency check, queue/dispatch, log flushing, completion
// bookkeeping) live in exactly one place.
type StartRunOpts struct {
	Pipeline pipeline.Pipeline
	Params   map[string]string
	UserID   uint
	Username string
}

// pruneUserHistory enforces the AppSettings.PipelineHistoryLimit retention
// policy for a single user. After a run completes we keep at most N
// non-active runs for that user (by created_at desc) and hard-delete the
// rest. Running and queued rows are never touched. Best-effort: any DB
// error is logged-and-swallowed because pruning failures must not affect
// the user-visible run completion path.
func pruneUserHistory(database *gorm.DB, userID uint) {
	var settings dbpkg.AppSettings
	if err := database.First(&settings, 1).Error; err != nil {
		return
	}
	limit := settings.PipelineHistoryLimit
	if limit <= 0 {
		return
	}

	activeStatuses := []string{"running", "queued"}

	var keepIDs []uint
	if err := database.Model(&dbpkg.ExecutionRun{}).
		Where("user_id = ? AND status NOT IN ?", userID, activeStatuses).
		Order("created_at desc").
		Limit(limit).
		Pluck("id", &keepIDs).Error; err != nil {
		return
	}
	if len(keepIDs) < limit {
		return
	}

	database.Unscoped().
		Where("user_id = ? AND status NOT IN ? AND id NOT IN ?", userID, activeStatuses, keepIDs).
		Delete(&dbpkg.ExecutionRun{})
}
