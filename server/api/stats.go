package api

import (
	"net/http"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/codeci/codeci/server/auth"
	dbpkg "github.com/codeci/codeci/server/db"
)

type DailyBucket struct {
	Date    string `json:"date"`
	Total   int    `json:"total"`
	Success int    `json:"success"`
	Failed  int    `json:"failed"`
}

type TopPipeline struct {
	PipelineID   string `json:"pipeline_id"`
	PipelineName string `json:"pipeline_name"`
	Count        int    `json:"count"`
}

type DashboardStats struct {
	TotalPipelines int                   `json:"total_pipelines"`
	TotalRuns      int64                 `json:"total_runs"`
	SuccessCount   int64                 `json:"success_count"`
	FailedCount    int64                 `json:"failed_count"`
	CancelledCount int64                 `json:"cancelled_count"`
	RunningCount   int64                 `json:"running_count"`
	QueuedCount    int64                 `json:"queued_count"`
	SuccessRate    float64               `json:"success_rate"`
	AvgDurationSec float64               `json:"avg_duration_seconds"`
	Runs7Days      []DailyBucket         `json:"runs_7_days"`
	TopPipelines   []TopPipeline         `json:"top_pipelines"`
	RecentRuns     []dbpkg.ExecutionRun  `json:"recent_runs"`
}

// GET /api/stats — dashboard summary. Admins see global figures; non-admins
// see only their own runs (matches the access pattern used by ListRuns and
// ListActiveRuns).
func (h *Handler) GetDashboardStats(c echo.Context) error {
	claims := auth.GetClaims(c)

	stats := DashboardStats{
		Runs7Days:    make([]DailyBucket, 0, 7),
		TopPipelines: []TopPipeline{},
		RecentRuns:   []dbpkg.ExecutionRun{},
	}

	// Total pipelines on disk (cached on mtime; cheap).
	if pipes, err := h.loader.List(); err == nil {
		stats.TotalPipelines = len(pipes)
	}

	// Status counts — one grouped query covers total/success/failed/cancelled/running.
	type statusRow struct {
		Status string
		Count  int64
	}
	var statusRows []statusRow
	q := h.db.Model(&dbpkg.ExecutionRun{}).
		Select("status, COUNT(*) as count").
		Group("status")
	if !claims.IsAdmin {
		q = q.Where("user_id = ?", claims.UserID)
	}
	q.Scan(&statusRows)
	for _, r := range statusRows {
		stats.TotalRuns += r.Count
		switch r.Status {
		case "success":
			stats.SuccessCount = r.Count
		case "failed":
			stats.FailedCount = r.Count
		case "cancelled":
			stats.CancelledCount = r.Count
		case "running":
			stats.RunningCount = r.Count
		case "queued":
			stats.QueuedCount = r.Count
		}
	}

	// Success rate + average duration over last 30 days, completed runs only.
	type aggRow struct {
		AvgSec  *float64
		SuccessPct *float64
	}
	var agg aggRow
	aq := h.db.Model(&dbpkg.ExecutionRun{}).
		Select("EXTRACT(EPOCH FROM AVG(finished_at - started_at)) AS avg_sec, " +
			"SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS success_pct").
		Where("status IN ?", []string{"success", "failed", "cancelled"}).
		Where("finished_at IS NOT NULL").
		Where("started_at >= ?", time.Now().AddDate(0, 0, -30))
	if !claims.IsAdmin {
		aq = aq.Where("user_id = ?", claims.UserID)
	}
	aq.Scan(&agg)
	if agg.AvgSec != nil {
		stats.AvgDurationSec = *agg.AvgSec
	}
	if agg.SuccessPct != nil {
		stats.SuccessRate = *agg.SuccessPct
	}

	// Daily buckets for the last 7 days.
	type dailyRow struct {
		Day     time.Time
		Status  string
		Count   int
	}
	var dailyRows []dailyRow
	dq := h.db.Model(&dbpkg.ExecutionRun{}).
		Select("DATE(started_at) AS day, status, COUNT(*) AS count").
		Where("started_at >= ?", time.Now().AddDate(0, 0, -6).Truncate(24*time.Hour)).
		Group("day, status")
	if !claims.IsAdmin {
		dq = dq.Where("user_id = ?", claims.UserID)
	}
	dq.Scan(&dailyRows)

	// Build 7-element slice ending today, in chronological order.
	today := time.Now().UTC().Truncate(24 * time.Hour)
	buckets := make(map[string]*DailyBucket, 7)
	for i := 6; i >= 0; i-- {
		day := today.AddDate(0, 0, -i)
		key := day.Format("2006-01-02")
		bucket := &DailyBucket{Date: key}
		buckets[key] = bucket
		stats.Runs7Days = append(stats.Runs7Days, DailyBucket{Date: key})
	}
	for _, r := range dailyRows {
		key := r.Day.UTC().Format("2006-01-02")
		b, ok := buckets[key]
		if !ok {
			continue
		}
		b.Total += r.Count
		if r.Status == "success" {
			b.Success += r.Count
		} else if r.Status == "failed" {
			b.Failed += r.Count
		}
	}
	// Re-emit in order with aggregated totals (the slice was created in order
	// above; map writes need to be flushed back).
	for i := range stats.Runs7Days {
		key := stats.Runs7Days[i].Date
		if b, ok := buckets[key]; ok {
			stats.Runs7Days[i] = *b
		}
	}

	// Top 5 pipelines by run count over last 30 days.
	type topRow struct {
		PipelineID   string
		PipelineName string
		Count        int
	}
	var topRows []topRow
	tq := h.db.Model(&dbpkg.ExecutionRun{}).
		Select("pipeline_id, pipeline_name, COUNT(*) AS count").
		Where("started_at >= ?", time.Now().AddDate(0, 0, -30)).
		Group("pipeline_id, pipeline_name").
		Order("count DESC").
		Limit(5)
	if !claims.IsAdmin {
		tq = tq.Where("user_id = ?", claims.UserID)
	}
	tq.Scan(&topRows)
	stats.TopPipelines = make([]TopPipeline, len(topRows))
	for i, r := range topRows {
		stats.TopPipelines[i] = TopPipeline{
			PipelineID:   r.PipelineID,
			PipelineName: r.PipelineName,
			Count:        r.Count,
		}
	}

	// Recent activity — last 8 runs. Heavy columns dropped on the wire.
	var recent []dbpkg.ExecutionRun
	rq := h.db.Omit("logs_json", "params_json").
		Order("created_at desc").
		Limit(8)
	if !claims.IsAdmin {
		rq = rq.Where("user_id = ?", claims.UserID)
	}
	rq.Find(&recent)
	stats.RecentRuns = recent

	return c.JSON(http.StatusOK, stats)
}
