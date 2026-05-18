package execution

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
	"github.com/aws/aws-sdk-go-v2/service/codebuild"
	cbtypes "github.com/aws/aws-sdk-go-v2/service/codebuild/types"

	"github.com/codeci/codeci/server/pipeline"
)

const (
	codebuildPollInterval  = 4 * time.Second
	cloudwatchPollInterval = 1500 * time.Millisecond
	// liveTailWindow is how many recent log lines we surface to the UI as a
	// rolling tail. Anything before that is dropped — full logs live in
	// CloudWatch and the user can click through to the AWS console.
	liveTailWindow = 10
	// failureExcerptWindow is how many of the most recent lines we forward
	// as stderr when the build fails, so the failure summary captures the
	// actual error context without dragging the whole log into our DB.
	failureExcerptWindow = 30
	// ringCap bounds the in-runner rolling buffer used for tail computation
	// and the failure excerpt.
	ringCap = 64
)

// stringRing is a small fixed-cap FIFO used to retain the most recent log
// lines from CloudWatch for tail rendering and failure excerpts.
type stringRing struct {
	items []string
	cap   int
}

func newStringRing(capacity int) *stringRing {
	return &stringRing{items: make([]string, 0, capacity), cap: capacity}
}

func (r *stringRing) push(s string) {
	if len(r.items) < r.cap {
		r.items = append(r.items, s)
		return
	}
	// Shift left and overwrite the slot at the end.
	copy(r.items, r.items[1:])
	r.items[r.cap-1] = s
}

func (r *stringRing) lastN(n int) []string {
	if n > len(r.items) {
		n = len(r.items)
	}
	out := make([]string, n)
	copy(out, r.items[len(r.items)-n:])
	return out
}

// runCodeBuildStep starts the CodeBuild project for the step, surfaces a
// rolling tail of CloudWatch logs as transient meta frames, and returns a
// stepResult once the build reaches a terminal status. On success we keep
// just the "build SUCCEEDED" line; on failure we forward the last several
// log lines as stderr so the user can see what went wrong.
func runCodeBuildStep(ctx context.Context, cb CodeBuildClients, step pipeline.Step, send func(WSMessage)) stepResult {
	if cb == nil || cb.CodeBuild == nil {
		send(WSMessage{Type: MsgError, Data: "AWS clients not configured", Step: step.Name})
		return stepResult{Code: 1, Reason: "AWS clients not configured"}
	}
	cfg := step.CodeBuild
	if cfg == nil || strings.TrimSpace(cfg.Project) == "" {
		send(WSMessage{Type: MsgError, Data: "codebuild project not specified", Step: step.Name})
		return stepResult{Code: 1, Reason: "codebuild project not specified"}
	}

	envOverride := make([]cbtypes.EnvironmentVariable, 0, len(cfg.Env))
	for k, v := range cfg.Env {
		envOverride = append(envOverride, cbtypes.EnvironmentVariable{
			Name:  aws.String(k),
			Value: aws.String(v),
			Type:  cbtypes.EnvironmentVariableTypePlaintext,
		})
	}

	in := &codebuild.StartBuildInput{
		ProjectName:                  aws.String(cfg.Project),
		EnvironmentVariablesOverride: envOverride,
	}
	if cfg.SourceVersion != "" {
		in.SourceVersion = aws.String(cfg.SourceVersion)
	}
	if cfg.BuildspecOverride != "" {
		in.BuildspecOverride = aws.String(cfg.BuildspecOverride)
	}
	if cfg.TimeoutMinutes > 0 {
		in.TimeoutInMinutesOverride = aws.Int32(int32(cfg.TimeoutMinutes))
	}

	startOut, err := cb.CodeBuild.StartBuild(ctx, in)
	if err != nil {
		send(WSMessage{Type: MsgError, Data: fmt.Sprintf("StartBuild: %v", err), Step: step.Name})
		return stepResult{Code: 1, Reason: fmt.Sprintf("StartBuild failed: %v", err)}
	}
	build := startOut.Build
	buildID := aws.ToString(build.Id)
	buildArn := aws.ToString(build.Arn)

	send(WSMessage{
		Type: MsgMeta,
		Step: step.Name,
		Meta: map[string]string{
			"runner":      "codebuild",
			"project":     cfg.Project,
			"build_id":    buildID,
			"build_arn":   buildArn,
			"console_url": codebuildConsoleURL(cb.Region, buildID),
		},
	})
	send(WSMessage{Type: MsgStdout, Data: fmt.Sprintf("[CodeBuild] started build %s\n", buildID), Step: step.Name})

	stopOnce := sync.OnceFunc(func() {
		send(WSMessage{
			Type: MsgStdout,
			Data: fmt.Sprintf("[CodeBuild] cancellation requested — stopping build %s\n", buildID),
			Step: step.Name,
		})
		// Use Background so the stop request itself isn't cut off by the
		// already-cancelled parent ctx. AWS treats StopBuild as a no-op for
		// builds that have already reached a terminal state, so this is
		// safe to call from the defer fallback as well.
		if _, err := cb.CodeBuild.StopBuild(context.Background(), &codebuild.StopBuildInput{Id: aws.String(buildID)}); err != nil {
			send(WSMessage{
				Type: MsgStderr,
				Data: fmt.Sprintf("[CodeBuild] StopBuild failed for %s: %v\n", buildID, err),
				Step: step.Name,
			})
		}
	})
	defer func() {
		if ctx.Err() != nil {
			stopOnce()
		}
	}()

	logsCtx, cancelLogs := context.WithCancel(ctx)
	defer cancelLogs()

	// The log tailer runs concurrently and returns its retained ring of
	// recent lines so we can use them in the failure summary.
	tailDone := make(chan []string, 1)
	go func() {
		tailDone <- streamCodeBuildLogs(logsCtx, cb, *build, step.Name, send)
	}()

	clearTail := func() {
		send(WSMessage{
			Type:      MsgMeta,
			Step:      step.Name,
			Meta:      map[string]string{"live_tail": ""},
			Transient: true,
		})
	}

	// Poll BatchGetBuilds until terminal.
	var lastPhase string
	pollTicker := time.NewTicker(codebuildPollInterval)
	defer pollTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			stopOnce()
			cancelLogs()
			tail := <-tailDone
			clearTail()
			reason := "step cancelled"
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				reason = "step timed out"
			}
			emitFailureExcerpt(send, step.Name, tail, current(buildID, cb, ctx), reason)
			return stepResult{Code: 1, Reason: reason, LastStderr: tail}
		case <-pollTicker.C:
		}

		got, err := cb.CodeBuild.BatchGetBuilds(ctx, &codebuild.BatchGetBuildsInput{
			Ids: []string{buildID},
		})
		if err != nil {
			// Transient — keep polling rather than aborting on a single hiccup.
			continue
		}
		if len(got.Builds) == 0 {
			continue
		}
		curr := got.Builds[0]
		if phase := aws.ToString(curr.CurrentPhase); phase != "" && phase != lastPhase {
			send(WSMessage{
				Type: MsgMeta,
				Step: step.Name,
				Meta: map[string]string{"phase": phase},
			})
			lastPhase = phase
		}

		if curr.BuildStatus == cbtypes.StatusTypeInProgress {
			continue
		}

		// Terminal status: stop the log tailer and drain the retained ring.
		cancelLogs()
		tail := <-tailDone
		clearTail()

		switch curr.BuildStatus {
		case cbtypes.StatusTypeSucceeded:
			send(WSMessage{Type: MsgStdout, Data: "[CodeBuild] build SUCCEEDED\n", Step: step.Name})
			return stepResult{Code: 0}
		default:
			reason := codeBuildFailureReason(curr)
			emitFailureExcerpt(send, step.Name, tail, &curr, reason)
			return stepResult{
				Code:       1,
				Reason:     fmt.Sprintf("CodeBuild %s: %s", curr.BuildStatus, reason),
				LastStderr: tail,
			}
		}
	}
}

// streamCodeBuildLogs tails the build's CloudWatch log group/stream and
// emits a transient meta frame whenever the rolling tail content changes.
// It does NOT emit per-line stdout messages — full logs live in CloudWatch.
// Returns the ring's contents at exit so the caller can render a failure
// excerpt.
func streamCodeBuildLogs(ctx context.Context, cb CodeBuildClients, build cbtypes.Build, stepName string, send func(WSMessage)) []string {
	if cb.CloudWatch == nil || build.Logs == nil {
		return nil
	}
	logsInfo := build.Logs
	if aws.ToString(logsInfo.GroupName) == "" || aws.ToString(logsInfo.StreamName) == "" {
		return nil
	}

	groupName := aws.ToString(logsInfo.GroupName)
	streamName := aws.ToString(logsInfo.StreamName)

	ring := newStringRing(ringCap)
	var nextToken *string
	var lastEmitted string

	emitTail := func() {
		joined := strings.Join(ring.lastN(liveTailWindow), "\n")
		if joined == lastEmitted {
			return
		}
		lastEmitted = joined
		send(WSMessage{
			Type:      MsgMeta,
			Step:      stepName,
			Meta:      map[string]string{"live_tail": joined},
			Transient: true,
		})
	}

	ticker := time.NewTicker(cloudwatchPollInterval)
	defer ticker.Stop()

	for {
		out, err := cb.CloudWatch.GetLogEvents(ctx, &cloudwatchlogs.GetLogEventsInput{
			LogGroupName:  aws.String(groupName),
			LogStreamName: aws.String(streamName),
			NextToken:     nextToken,
			StartFromHead: aws.Bool(true),
		})
		if err == nil {
			for _, event := range out.Events {
				line := strings.TrimRight(aws.ToString(event.Message), "\n")
				ring.push(line)
			}
			if out.NextForwardToken != nil {
				nextToken = out.NextForwardToken
			}
			emitTail()
		}
		// On error (e.g., ResourceNotFoundException while the build is still
		// provisioning its log stream), just retry on the next tick.

		select {
		case <-ctx.Done():
			// Drain any final batch before returning.
			final, derr := cb.CloudWatch.GetLogEvents(context.Background(), &cloudwatchlogs.GetLogEventsInput{
				LogGroupName:  aws.String(groupName),
				LogStreamName: aws.String(streamName),
				NextToken:     nextToken,
				StartFromHead: aws.Bool(true),
			})
			if derr == nil {
				for _, event := range final.Events {
					line := strings.TrimRight(aws.ToString(event.Message), "\n")
					ring.push(line)
				}
			}
			return ring.lastN(failureExcerptWindow)
		case <-ticker.C:
		}
	}
}

// emitFailureExcerpt sends the last several log lines as stderr frames so
// they land both in the failure-summary banner and the per-step log pane.
// Each line goes out as its own MsgStderr to preserve coloring and the
// existing isErrorLine heuristics.
func emitFailureExcerpt(send func(WSMessage), stepName string, tail []string, curr *cbtypes.Build, reason string) {
	if len(tail) > failureExcerptWindow {
		tail = tail[len(tail)-failureExcerptWindow:]
	}
	if len(tail) > 0 {
		send(WSMessage{
			Type: MsgStderr,
			Data: fmt.Sprintf("[CodeBuild] last %d log lines (full logs in CloudWatch):\n", len(tail)),
			Step: stepName,
		})
		for _, line := range tail {
			send(WSMessage{Type: MsgStderr, Data: line + "\n", Step: stepName})
		}
	}
	status := "ENDED"
	if curr != nil {
		status = string(curr.BuildStatus)
	}
	send(WSMessage{
		Type: MsgStderr,
		Data: fmt.Sprintf("[CodeBuild] build %s: %s\n", status, reason),
		Step: stepName,
	})
}

// current is a best-effort fetch used in the cancellation path to attach a
// status to the failure excerpt; it deliberately ignores errors because the
// surrounding code already has a fall-through reason.
func current(buildID string, cb CodeBuildClients, ctx context.Context) *cbtypes.Build {
	if cb == nil || cb.CodeBuild == nil {
		return nil
	}
	got, err := cb.CodeBuild.BatchGetBuilds(ctx, &codebuild.BatchGetBuildsInput{Ids: []string{buildID}})
	if err != nil || len(got.Builds) == 0 {
		return nil
	}
	return &got.Builds[0]
}

func codeBuildFailureReason(b cbtypes.Build) string {
	for i := len(b.Phases) - 1; i >= 0; i-- {
		ph := b.Phases[i]
		if ph.PhaseStatus == cbtypes.StatusTypeFailed || ph.PhaseStatus == cbtypes.StatusTypeFault || ph.PhaseStatus == cbtypes.StatusTypeTimedOut || ph.PhaseStatus == cbtypes.StatusTypeStopped {
			parts := make([]string, 0, len(ph.Contexts)+1)
			parts = append(parts, fmt.Sprintf("phase=%s status=%s", ph.PhaseType, ph.PhaseStatus))
			for _, ctxItem := range ph.Contexts {
				if msg := aws.ToString(ctxItem.Message); msg != "" {
					parts = append(parts, msg)
				}
			}
			return strings.Join(parts, "; ")
		}
	}
	return string(b.BuildStatus)
}

func codebuildConsoleURL(region, buildID string) string {
	if region == "" {
		region = "us-east-1"
	}
	encoded := strings.ReplaceAll(buildID, ":", "%3A")
	return fmt.Sprintf("https://%s.console.aws.amazon.com/codesuite/codebuild/projects/%s/build/%s/?region=%s",
		region,
		strings.SplitN(buildID, ":", 2)[0],
		encoded,
		region,
	)
}
