// scheduler.go — per-pipeline concurrency control.
//
// Pipelines declare an optional max_concurrent_runs cap in their YAML
// (default 1). The Scheduler is the single entry point for kicking off runs:
// Submit() either dispatches immediately (DB row with status="running" +
// goroutines spawned) or persists a queued row (status="queued") that gets
// promoted FIFO when a slot frees up.
//
// All callers — WS handler, REST trigger, webhooks, /api/v1 — go through
// Submit. The legacy free function StartRun was removed in favour of this
// scheduler so the concurrency check can't be bypassed.
package execution

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"gorm.io/gorm"

	"github.com/codeci/codeci/server/config"
	dbpkg "github.com/codeci/codeci/server/db"
	"github.com/codeci/codeci/server/pipeline"
)

// Scheduler tracks per-pipeline in-flight counts and drives the queue.
// All public methods are safe to call concurrently; the dispatch path is
// serialised by `mu` so the count-check + DB-insert + registry-register
// sequence is atomic from any submitter's perspective.
type Scheduler struct {
	db         *gorm.DB
	cfg        *config.Config
	registry   *RunRegistry
	awsClients CodeBuildClients
	loader     *pipeline.Loader

	mu      sync.Mutex
	running map[string]int // pipelineID -> count of currently executing runs
}

func NewScheduler(database *gorm.DB, cfg *config.Config, registry *RunRegistry, aws CodeBuildClients, loader *pipeline.Loader) *Scheduler {
	return &Scheduler{
		db:         database,
		cfg:        cfg,
		registry:   registry,
		awsClients: aws,
		loader:     loader,
		running:    make(map[string]int),
	}
}

// Submit is the single public entry point for kicking off a pipeline run.
// Returns (runID, dispatched, error). dispatched=false means the run was
// persisted with status="queued" and will be promoted automatically when
// a concurrency slot opens for this pipeline.
func (s *Scheduler) Submit(opts StartRunOpts) (uint, bool, error) {
	// Pre-validate interpolation so callers get a clean 400 immediately,
	// independent of whether the run dispatches or queues.
	if _, err := pipeline.InterpolateSteps(opts.Pipeline.Steps, opts.Params, s.cfg.GitPAT); err != nil {
		return 0, false, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	limit := pipelineConcurrencyLimit(opts.Pipeline)
	if s.running[opts.Pipeline.ID] < limit {
		runID, _, err := s.dispatchLocked(opts, 0)
		return runID, true, err
	}

	return s.enqueueLocked(opts)
}

// enqueueLocked persists a queued ExecutionRun and pre-creates the registry
// ActiveRun so WS clients can subscribe and receive the promotion broadcast
// when the run is eventually dispatched. When the pipeline declares
// queue_strategy: replace, any pre-existing queued runs for the same
// pipeline are marked "superseded" so only the newest submission stays in
// the queue. Caller must hold s.mu.
func (s *Scheduler) enqueueLocked(opts StartRunOpts) (uint, bool, error) {
	paramsJSON, _ := json.Marshal(opts.Params)
	run := dbpkg.ExecutionRun{
		PipelineID:   opts.Pipeline.ID,
		PipelineName: opts.Pipeline.Name,
		UserID:       opts.UserID,
		UserName:     opts.Username,
		ParamsJSON:   string(paramsJSON),
		Status:       "queued",
		StartedAt:    time.Now(),
	}
	if err := s.db.Create(&run).Error; err != nil {
		return 0, false, fmt.Errorf("create queued run: %w", err)
	}

	// "replace" coalesces the queue: only the most-recent submission stays
	// queued; older queued rows are marked superseded so users see that the
	// system intentionally skipped them (as opposed to a manual cancel).
	if opts.Pipeline.QueueStrategy == pipeline.QueueStrategyReplace {
		s.supersedeOtherQueuedLocked(opts.Pipeline.ID, run.ID)
	}

	s.registry.GetOrCreate(run.ID, opts.Pipeline.ID)
	return run.ID, false, nil
}

// supersedeOtherQueuedLocked marks every queued ExecutionRun for the given
// pipeline as "superseded", except the row identified by keepRunID. Any
// websocket subscribers attached to the superseded runs are notified and
// the registry slot is released so they don't leak. Caller must hold s.mu.
func (s *Scheduler) supersedeOtherQueuedLocked(pipelineID string, keepRunID uint) {
	var stale []dbpkg.ExecutionRun
	s.db.Where("pipeline_id = ? AND status = ? AND id <> ?", pipelineID, "queued", keepRunID).
		Find(&stale)
	if len(stale) == 0 {
		return
	}
	now := time.Now()
	for _, r := range stale {
		notice := fmt.Sprintf("Superseded by newer submission (run #%d) — queue_strategy: replace.", keepRunID)
		var msgs []WSMessage
		_ = json.Unmarshal([]byte(r.LogsJSON), &msgs)
		msgs = append(msgs, WSMessage{Type: MsgError, Data: notice})
		logsJSON := marshalLogsCapped(msgs)

		s.db.Model(&dbpkg.ExecutionRun{}).Where("id = ?", r.ID).Updates(map[string]any{
			"status":      "superseded",
			"finished_at": &now,
			"logs_json":   logsJSON,
		})

		// Notify any attached WS clients and release the registry slot so
		// the queued ActiveRun doesn't outlive its row.
		if ar, ok := s.registry.Get(r.ID); ok {
			ar.Broadcast(WSMessage{Type: MsgError, Data: notice})
			select {
			case <-ar.Done:
			default:
				close(ar.Done)
			}
			s.registry.Remove(r.ID)
		}
	}
}

// dispatchLocked starts a run immediately. If existingRunID is non-zero the
// existing queued row is promoted to status="running"; otherwise a new row
// is created. Caller must hold s.mu.
func (s *Scheduler) dispatchLocked(opts StartRunOpts, existingRunID uint) (uint, *ActiveRun, error) {
	interpolatedSteps, err := pipeline.InterpolateSteps(opts.Pipeline.Steps, opts.Params, s.cfg.GitPAT)
	if err != nil {
		return existingRunID, nil, err
	}

	now := time.Now()
	var runID uint

	if existingRunID == 0 {
		paramsJSON, _ := json.Marshal(opts.Params)
		run := dbpkg.ExecutionRun{
			PipelineID:   opts.Pipeline.ID,
			PipelineName: opts.Pipeline.Name,
			UserID:       opts.UserID,
			UserName:     opts.Username,
			ParamsJSON:   string(paramsJSON),
			Status:       "running",
			StartedAt:    now,
		}
		if err := s.db.Create(&run).Error; err != nil {
			return 0, nil, fmt.Errorf("create run: %w", err)
		}
		runID = run.ID
	} else {
		runID = existingRunID
		if err := s.db.Model(&dbpkg.ExecutionRun{}).Where("id = ?", runID).Updates(map[string]any{
			"status":     "running",
			"started_at": now,
		}).Error; err != nil {
			return runID, nil, fmt.Errorf("promote queued run: %w", err)
		}
	}

	activeRun, _ := s.registry.GetOrCreate(runID, opts.Pipeline.ID)
	s.running[opts.Pipeline.ID]++

	timeoutMinutes := 60
	var appSettings dbpkg.AppSettings
	if err := s.db.First(&appSettings, 1).Error; err == nil {
		timeoutMinutes = appSettings.RunnerTimeoutMinutes
	}
	ctx, cancelCtx := context.WithTimeout(context.Background(), time.Duration(timeoutMinutes)*time.Minute)
	activeRun.SetCancel(cancelCtx)

	pipelineID := opts.Pipeline.ID
	userID := opts.UserID

	// Notify any subscribers that the run has been promoted out of the queue.
	if existingRunID != 0 {
		activeRun.Broadcast(WSMessage{
			Type: MsgStep,
			Data: "Dispatched from queue — starting run",
		})
	}

	// 5s log flush goroutine — mirrors the in-memory backlog into LogsJSON
	// so REST consumers polling /logs see fresh data while the run is alive.
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				logsJSON := marshalLogsCapped(activeRun.GetMessages())
				s.db.Model(&dbpkg.ExecutionRun{}).Where("id = ?", runID).
					Update("logs_json", logsJSON)
			case <-activeRun.Done:
				return
			}
		}
	}()

	go func() {
		defer cancelCtx()

		broadcast := func(m WSMessage) {
			activeRun.Broadcast(m)
		}

		exitCode := RunSteps(ctx, s.awsClients, broadcast, interpolatedSteps, runID)

		status := "success"
		if exitCode != 0 {
			switch ctx.Err() {
			case context.DeadlineExceeded:
				status = "timed_out"
			case context.Canceled:
				status = "cancelled"
			default:
				status = "failed"
			}
		}
		finishedAt := time.Now()
		logsJSON := marshalLogsCapped(activeRun.GetMessages())

		s.db.Model(&dbpkg.ExecutionRun{}).Where("id = ?", runID).Updates(map[string]any{
			"Status":     status,
			"FinishedAt": &finishedAt,
			"LogsJSON":   logsJSON,
		})

		pruneUserHistory(s.db, userID)

		s.registry.Remove(runID)
		close(activeRun.Done)

		s.OnRunDone(pipelineID)
	}()

	return runID, activeRun, nil
}

// OnRunDone is invoked from the run completion goroutine after the run is
// removed from the registry. It decrements the in-flight counter and
// promotes the oldest queued run for this pipeline if room is available.
func (s *Scheduler) OnRunDone(pipelineID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running[pipelineID] > 0 {
		s.running[pipelineID]--
	}
	s.tryDispatchLocked(pipelineID)
}

// tryDispatchLocked promotes queued runs for pipelineID up to its limit.
// Caller must hold s.mu.
func (s *Scheduler) tryDispatchLocked(pipelineID string) {
	p, err := s.loader.Get(pipelineID)
	if err != nil {
		// Pipeline YAML was deleted while runs were queued. Mark all queued
		// rows for this pipeline as failed so they don't sit forever.
		now := time.Now()
		s.db.Model(&dbpkg.ExecutionRun{}).
			Where("pipeline_id = ? AND status = ?", pipelineID, "queued").
			Updates(map[string]any{
				"status":      "failed",
				"finished_at": &now,
				"logs_json":   fmt.Sprintf(`[{"type":"error","data":"pipeline %q no longer exists; queued run abandoned"}]`, pipelineID),
			})
		return
	}
	limit := pipelineConcurrencyLimit(*p)

	for s.running[pipelineID] < limit {
		var queued dbpkg.ExecutionRun
		err := s.db.Where("pipeline_id = ? AND status = ?", pipelineID, "queued").
			Order("created_at asc").First(&queued).Error
		if err != nil {
			return // no more queued rows
		}

		var params map[string]string
		_ = json.Unmarshal([]byte(queued.ParamsJSON), &params)
		if params == nil {
			params = map[string]string{}
		}

		opts := StartRunOpts{
			Pipeline: *p,
			Params:   params,
			UserID:   queued.UserID,
			Username: queued.UserName,
		}
		if _, _, err := s.dispatchLocked(opts, queued.ID); err != nil {
			now := time.Now()
			s.db.Model(&dbpkg.ExecutionRun{}).Where("id = ?", queued.ID).Updates(map[string]any{
				"status":      "failed",
				"finished_at": &now,
				"logs_json":   fmt.Sprintf(`[{"type":"error","data":%q}]`, err.Error()),
			})
			log.Printf("[scheduler] failed to dispatch queued run %d: %v", queued.ID, err)
			// Loop continues — try the next queued row.
		}
	}
}

// RecoverOnStartup must be called before the HTTP server begins serving
// traffic. It performs two sweeps:
//  1. Every status="running" row is marked failed — those goroutines died
//     when the server stopped. A synthetic error log line is appended so
//     users see what happened.
//  2. Every distinct pipeline with queued rows gets dispatched up to its
//     declared limit. This drains backlogs that accumulated while the
//     server was down.
func (s *Scheduler) RecoverOnStartup() {
	s.mu.Lock()
	defer s.mu.Unlock()

	var orphans []dbpkg.ExecutionRun
	s.db.Where("status = ?", "running").Find(&orphans)
	if len(orphans) > 0 {
		now := time.Now()
		for _, r := range orphans {
			var msgs []WSMessage
			_ = json.Unmarshal([]byte(r.LogsJSON), &msgs)
			msgs = append(msgs, WSMessage{
				Type: MsgError,
				Data: "Server restarted during this run; pipeline was abandoned.",
			})
			logsJSON := marshalLogsCapped(msgs)
			s.db.Model(&dbpkg.ExecutionRun{}).Where("id = ?", r.ID).Updates(map[string]any{
				"status":      "failed",
				"finished_at": &now,
				"logs_json":   logsJSON,
			})
		}
		log.Printf("[scheduler] marked %d abandoned running run(s) as failed on startup", len(orphans))
	}

	var pipelineIDs []string
	s.db.Model(&dbpkg.ExecutionRun{}).
		Where("status = ?", "queued").
		Distinct("pipeline_id").
		Pluck("pipeline_id", &pipelineIDs)
	for _, pid := range pipelineIDs {
		s.tryDispatchLocked(pid)
	}
}

// QueuePosition returns the 1-based position of a queued run in its
// pipeline's queue, or 0 if the run is not currently queued.
func (s *Scheduler) QueuePosition(runID uint) int {
	var run dbpkg.ExecutionRun
	if err := s.db.Select("id, pipeline_id, status, created_at").First(&run, runID).Error; err != nil {
		return 0
	}
	if run.Status != "queued" {
		return 0
	}
	var ahead int64
	s.db.Model(&dbpkg.ExecutionRun{}).
		Where("pipeline_id = ? AND status = ? AND created_at < ?", run.PipelineID, "queued", run.CreatedAt).
		Count(&ahead)
	return int(ahead) + 1
}

// CancelQueued marks a queued run as cancelled without touching any
// container. Returns true if the run was queued and has been cancelled.
func (s *Scheduler) CancelQueued(runID uint) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	res := s.db.Model(&dbpkg.ExecutionRun{}).
		Where("id = ? AND status = ?", runID, "queued").
		Updates(map[string]any{
			"status":      "cancelled",
			"finished_at": &now,
		})
	if res.RowsAffected == 0 {
		return false
	}
	if ar, ok := s.registry.Get(runID); ok {
		// Wake any WS subscribers so they stop blocking on Done.
		select {
		case <-ar.Done:
			// already closed
		default:
			close(ar.Done)
		}
		s.registry.Remove(runID)
	}
	return true
}

func pipelineConcurrencyLimit(p pipeline.Pipeline) int {
	if p.MaxConcurrentRuns < 1 {
		return 1
	}
	return p.MaxConcurrentRuns
}
