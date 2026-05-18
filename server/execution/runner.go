package execution

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	awspkg "github.com/codeci/codeci/server/aws"
	"github.com/codeci/codeci/server/pipeline"
)

// CodeBuildClients is an alias so call sites in main.go and ws_handler.go
// can reference a name local to the execution package without depending on
// the aws package directly.
type CodeBuildClients = *awspkg.Clients

type MsgType string

const (
	MsgInit        MsgType = "init"
	MsgQueued      MsgType = "queued" // run accepted but waiting for a free concurrency slot
	MsgStep        MsgType = "step"
	MsgStdout      MsgType = "stdout"
	MsgStderr      MsgType = "stderr"
	MsgExit        MsgType = "exit"
	MsgError       MsgType = "error"
	MsgMeta        MsgType = "meta"         // step-scoped metadata (e.g. codebuild build_id, console_url)
	MsgSubstepPlan MsgType = "substep_plan" // static tree of substeps, emitted before a step's script runs
	MsgSubstep     MsgType = "substep"      // runtime "current substep" START (Data = substep ID)
	MsgSubstepEnd  MsgType = "substep_end"  // runtime "current substep" END   (Data = substep ID)
)

// ExitInfo carries structured failure context attached to MsgExit, so the UI
// can show users *why* a run failed without making them grep through logs.
type ExitInfo struct {
	Code       int      `json:"code"`
	FailedStep string   `json:"failed_step,omitempty"`
	Reason     string   `json:"reason,omitempty"`
	LastStderr []string `json:"last_stderr,omitempty"`
}

type WSMessage struct {
	Type  MsgType `json:"type"`
	Data  string  `json:"data,omitempty"`
	Code  *int    `json:"code,omitempty"`
	RunID uint    `json:"run_id,omitempty"`
	Seq   int64   `json:"seq,omitempty"`
	// Time is the server clock (Unix millis) at the moment the message was
	// broadcast. The frontend uses it as the authoritative event time so
	// per-step duration timers don't drift on re-render or re-attach.
	Time     int64             `json:"time,omitempty"`
	Step     string            `json:"step,omitempty"`
	Meta     map[string]string `json:"meta,omitempty"`
	ExitInfo *ExitInfo         `json:"exit_info,omitempty"`
	// Substeps carries the planned substep tree on MsgSubstepPlan messages.
	Substeps []Substep `json:"substeps,omitempty"`
	// Transient messages (e.g., rolling live-tail meta updates) are sent to
	// active subscribers but skipped from the ring buffer and the DB flush.
	// This keeps high-frequency overlapping updates from filling memory.
	Transient bool `json:"-"`
}

func intPtr(i int) *int { return &i }

// connMutexes stores a per-connection write mutex; gorilla/websocket requires
// that concurrent goroutines do not write to the same connection simultaneously.
var connMutexes sync.Map // *websocket.Conn -> *sync.Mutex

// wsSend writes a WSMessage to a websocket connection (concurrent-safe per conn).
func wsSend(conn *websocket.Conn, msg WSMessage) error {
	mu, _ := connMutexes.LoadOrStore(conn, new(sync.Mutex))
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()
	b, _ := json.Marshal(msg)
	return conn.WriteMessage(websocket.TextMessage, b)
}

// wsCleanup removes the per-connection mutex when the connection is done.
func wsCleanup(conn *websocket.Conn) {
	connMutexes.Delete(conn)
}

// WS heartbeat constants. Ping every 30s; expect a pong within ~70s or treat
// the connection as dead. AWS ALB idle timeout defaults to 60s, so a 30s
// ping keeps the socket alive across silent stretches in long pipelines.
const (
	wsPingPeriod = 30 * time.Second
	wsPongWait   = 70 * time.Second
	wsWriteWait  = 10 * time.Second
)

// startHeartbeat installs a pong handler that refreshes the read deadline and
// starts a goroutine that periodically sends ping control frames. Call AFTER
// any initial handshake reads (those use their own deadline). Stop the
// heartbeat by closing the returned stop channel; this also returns when
// writes fail, which is the natural signal that the connection is gone.
func startHeartbeat(conn *websocket.Conn) chan<- struct{} {
	_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(wsPongWait))
	})

	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(wsPingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				// WriteControl is safe to call concurrently with other
				// write methods per gorilla/websocket docs, so we don't
				// need the per-conn write mutex here.
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(wsWriteWait)); err != nil {
					return
				}
			case <-stop:
				return
			}
		}
	}()
	return stop
}

// snapshotImageIDs returns the current set of Docker image IDs.
func snapshotImageIDs() map[string]bool {
	out, _ := exec.Command("docker", "images", "-q").Output()
	ids := make(map[string]bool)
	for _, id := range strings.Fields(string(out)) {
		ids[id] = true
	}
	return ids
}

// purgeNewImages removes images that appeared after the snapshot, skipping protected ones.
func purgeNewImages(before map[string]bool, runnerImage string) {
	out, err := exec.Command("docker", "images", "--format", "{{.ID}}\t{{.Repository}}:{{.Tag}}").Output()
	if err != nil {
		return
	}
	// Group repo:tags by image ID so all tags are checked before deciding to remove.
	tagsByID := make(map[string][]string)
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 || parts[0] == "" {
			continue
		}
		tagsByID[parts[0]] = append(tagsByID[parts[0]], parts[1])
	}
	for id, repoTags := range tagsByID {
		if before[id] {
			continue
		}
		protected := false
		for _, rt := range repoTags {
			if isProtectedTag(rt, runnerImage) {
				protected = true
				break
			}
		}
		if !protected {
			if err := exec.Command("docker", "rmi", "--force", id).Run(); err == nil {
				log.Printf("[runner] purged image %s (tags: %v)", id, repoTags)
			}
		}
	}
}

func isProtectedTag(repoTag, runnerImage string) bool {
	lower := strings.ToLower(repoTag)
	if strings.Contains(lower, "codeci") {
		return true
	}
	if strings.Contains(lower, "postgres") {
		return true
	}
	if runnerImage != "" && strings.Contains(lower, strings.ToLower(runnerImage)) {
		return true
	}
	return false
}

// repoCachePath returns the on-disk root the backend can read pipeline
// scripts from when the YAML references "/tmp/codeci-deploy/...". In both
// docker-compose and the helm chart the repo cache is mounted at the same
// path on the backend pod, so the default works without configuration.
func repoCachePath() string {
	if p := os.Getenv("REPO_CACHE_PATH"); p != "" {
		return p
	}
	return "/tmp/codeci-deploy"
}

// stepResult is what each per-step runner returns. Reason and LastStderr
// are only meaningful when Code != 0 — they feed the structured failure
// banner that RunDetail.tsx renders.
type stepResult struct {
	Code       int
	Reason     string
	LastStderr []string
}

// lastStderrSize bounds how many recent stderr lines we keep per step for
// the failure-summary UI. 20 lines is enough to show a Python traceback or
// a docker pull error without bloating the WS payload.
const lastStderrSize = 20

// stepRunner abstracts execution of a single step. Concrete implementations
// live in this file (docker) and codebuild_runner.go (CodeBuild).
type stepRunner interface {
	run(ctx context.Context, step pipeline.Step, send func(WSMessage)) stepResult
}

// dockerRunner executes steps inside the ephemeral codeci-runner-<runID>
// container. It is reused across all docker steps in a run.
type dockerRunner struct {
	containerName string
}

func (d *dockerRunner) run(ctx context.Context, step pipeline.Step, send func(WSMessage)) stepResult {
	return runDockerExec(ctx, send, step, d.containerName)
}

// RunSteps drives a pipeline to completion. It spins up the ephemeral
// runner only if at least one step needs docker; pipelines composed entirely
// of CodeBuild steps skip docker setup, image cleanup, and credential
// assumption entirely.
//
// cb may be nil; if it is and any step requires CodeBuild, RunSteps emits
// MsgError and returns non-zero rather than panicking.
func RunSteps(ctx context.Context, cb CodeBuildClients, send func(WSMessage), steps []pipeline.Step, runID uint) int {
	runnerImage := os.Getenv("RUNNER_IMAGE")
	if runnerImage == "" {
		runnerImage = "codeci-runner" // Fallback
	}

	dockerNeeded := false
	codeBuildNeeded := false
	for _, s := range steps {
		switch s.Runner {
		case "codebuild":
			codeBuildNeeded = true
		default:
			dockerNeeded = true
		}
	}
	if codeBuildNeeded && cb == nil {
		send(WSMessage{Type: MsgError, Data: "this server has no AWS credentials configured; cannot run CodeBuild steps"})
		exitCode := 1
		send(WSMessage{Type: MsgExit, Code: intPtr(exitCode), ExitInfo: &ExitInfo{Code: exitCode, Reason: "AWS not configured"}})
		return exitCode
	}

	var (
		containerStep stepRunner
		cleanups      []func()
	)
	defer func() {
		for i := len(cleanups) - 1; i >= 0; i-- {
			cleanups[i]()
		}
	}()
	if dockerNeeded {
		var (
			cleanup func()
			code    int
			reason  string
		)
		// RUNNER_BACKEND switches container-step execution between the local
		// docker daemon (VM/docker-compose) and ephemeral Kubernetes pods (EKS
		// helm deploy). Default is docker to preserve existing behavior.
		switch strings.ToLower(os.Getenv("RUNNER_BACKEND")) {
		case "kubernetes", "k8s":
			var kr *k8sRunner
			kr, cleanup, code, reason = setupK8sRunner(ctx, send, runnerImage, runID)
			containerStep = kr
		default:
			var dr *dockerRunner
			dr, cleanup, code, reason = setupDockerRunner(ctx, send, runnerImage, runID)
			containerStep = dr
		}
		if cleanup != nil {
			cleanups = append(cleanups, cleanup)
		}
		if code != 0 {
			send(WSMessage{
				Type: MsgExit, Code: intPtr(code),
				ExitInfo: &ExitInfo{Code: code, Reason: reason},
			})
			return code
		}
	}

	for _, step := range steps {
		send(WSMessage{Type: MsgStep, Data: step.Name, Step: step.Name})

		var res stepResult
		switch step.Runner {
		case "codebuild":
			res = runCodeBuildStep(ctx, cb, step, send)
		case "", "docker":
			res = containerStep.run(ctx, step, send)
		default:
			res = stepResult{Code: 1, Reason: fmt.Sprintf("unknown runner %q", step.Runner)}
			send(WSMessage{Type: MsgError, Data: res.Reason, Step: step.Name})
		}

		if res.Code != 0 {
			send(WSMessage{
				Type: MsgExit, Code: intPtr(res.Code), Step: step.Name,
				ExitInfo: &ExitInfo{
					Code:       res.Code,
					FailedStep: step.Name,
					Reason:     res.Reason,
					LastStderr: res.LastStderr,
				},
			})
			return res.Code
		}
	}

	send(WSMessage{Type: MsgExit, Code: intPtr(0), ExitInfo: &ExitInfo{Code: 0}})
	return 0
}

// setupDockerRunner brings up the ephemeral container and applies the
// volume/credential bootstrap. Returns (runner, cleanup, 0, "") on success.
// On failure returns (nil, possibly-non-nil-cleanup, code, reason) — the
// cleanup may still be needed if the container was started but later
// bootstrap failed.
func setupDockerRunner(ctx context.Context, send func(WSMessage), runnerImage string, runID uint) (*dockerRunner, func(), int, string) {
	containerName := fmt.Sprintf("codeci-runner-%d", runID)
	imagesBefore := snapshotImageIDs()

	// 1. Get volume mounts from current backend container
	hostname, _ := os.Hostname()
	volCmd := fmt.Sprintf("docker inspect %s --format '{{range .Mounts}}-v {{.Source}}:{{.Destination}}{{if not .RW}}:ro{{end}} {{end}}'", hostname)
	volOut, err := exec.Command("sh", "-c", volCmd).Output()
	if err != nil {
		reason := fmt.Sprintf("failed to detect volumes: %v", err)
		send(WSMessage{Type: MsgError, Data: reason})
		return nil, nil, 1, reason
	}
	// Filter out docker config mounts — the runner gets its own writable config
	// so pipelines can call `docker login` without hitting a read-only bind mount.
	rawFlags := strings.Fields(strings.TrimSpace(string(volOut)))
	var volFlags []string
	for i := 0; i < len(rawFlags); i++ {
		if rawFlags[i] == "-v" && i+1 < len(rawFlags) && strings.Contains(rawFlags[i+1], ".docker") {
			i++
			continue
		}
		volFlags = append(volFlags, rawFlags[i])
	}

	args := []string{"run", "-d", "--rm", "--name", containerName}
	args = append(args, volFlags...)
	if pat := os.Getenv("GIT_PAT"); pat != "" {
		args = append(args, "-e", "GIT_PAT="+pat)
	}
	if roleArn := os.Getenv("PIPELINE_ROLE_ARN"); roleArn != "" {
		args = append(args, "-e", "PIPELINE_ROLE_ARN="+roleArn)
	}
	args = append(args, runnerImage, "sleep", "infinity")

	if startErr := exec.CommandContext(ctx, "docker", args...).Run(); startErr != nil {
		reason := fmt.Sprintf("failed to start runner container: %v", startErr)
		send(WSMessage{Type: MsgError, Data: reason})
		return nil, nil, 1, reason
	}

	cleanup := func() {
		_ = exec.Command("docker", "stop", "-t", "2", containerName).Run()
		purgeNewImages(imagesBefore, runnerImage)
	}

	dockerConfigSetup := `mkdir -p /app /root/.docker && printf '{"credsStore":"ecr-login"}\n' > /root/.docker/config.json`
	if err := exec.Command("docker", "exec", containerName, "sh", "-c", dockerConfigSetup).Run(); err != nil {
		reason := fmt.Sprintf("failed to init docker config in runner: %v", err)
		send(WSMessage{Type: MsgError, Data: reason})
		return nil, cleanup, 1, reason
	}

	if roleArn := os.Getenv("PIPELINE_ROLE_ARN"); roleArn != "" {
		assumeCmd := fmt.Sprintf(
			`aws sts assume-role `+
				`--role-arn '%s' `+
				`--role-session-name codeci-pipeline-%d `+
				`--query Credentials `+
				`--output json `+
				`| python3 -c "`+
				`import sys,json; c=json.load(sys.stdin); `+
				`open('/tmp/aws-assumed-env','w').write(`+
				`'export AWS_ACCESS_KEY_ID='+c['AccessKeyId']+'\\n'+`+
				`'export AWS_SECRET_ACCESS_KEY='+c['SecretAccessKey']+'\\n'+`+
				`'export AWS_SESSION_TOKEN='+c['SessionToken']+'\\n'`+
				`)"`,
			roleArn, runID,
		)
		if err := exec.Command("docker", "exec", containerName, "sh", "-c", assumeCmd).Run(); err != nil {
			reason := fmt.Sprintf("failed to assume pipeline role %s: %v", roleArn, err)
			send(WSMessage{Type: MsgError, Data: reason})
			return nil, cleanup, 1, reason
		}
	}

	if pat := os.Getenv("GIT_PAT"); pat != "" {
		gitSetup := fmt.Sprintf(
			`printf 'https://x-access-token:%s@github.com\n' > /root/.git-credentials && `+
				`git config --global credential.helper store && `+
				`git config --global url."https://x-access-token:%s@github.com/".insteadOf "https://github.com/"`,
			pat, pat,
		)
		setupStep := pipeline.Step{Name: "git-setup", Run: gitSetup}
		if res := runDockerExec(ctx, send, setupStep, containerName); res.Code != 0 {
			send(WSMessage{Type: MsgError, Data: "failed to configure git credentials"})
			return nil, cleanup, res.Code, "git credential setup failed"
		}
	}

	return &dockerRunner{containerName: containerName}, cleanup, 0, ""
}

// runDockerExec executes a single docker-runner step. It captures the last
// stderr lines (for failure UX) and surfaces signal kills (e.g., 137 = SIGKILL,
// often OOM) as a human-readable Reason.
func runDockerExec(ctx context.Context, send func(WSMessage), step pipeline.Step, containerName string) stepResult {
	// Static substep plan + instrumented script. PlanSubsteps returns an
	// empty result when the script is unparseable / trivially small, in
	// which case we fall through to the un-instrumented script. Skip
	// planning entirely when the step explicitly opts out.
	var plan PlanResult
	if substepsEnabled(step) {
		plan = PlanSubsteps(step.Run, ".", repoCachePath(), resolvePlanOptions(step, send))
	}
	scriptBody := step.Run
	if plan.HasMarkers {
		send(WSMessage{
			Type:     MsgSubstepPlan,
			Step:     step.Name,
			Substeps: plan.Substeps,
		})
		scriptBody = plan.Script
	}

	// Source assumed-role credentials if present, then run the step.
	// Explicit existence check required: ash (alpine) exits the shell on a
	// missing sourced file even with || true.
	wrapped := `if [ -f /tmp/aws-assumed-env ]; then . /tmp/aws-assumed-env; fi; ` + scriptBody
	// bash is required because the planner emits heredocs and other
	// bash-only constructs; if the runner image lacks bash, fall back to sh.
	shell := "bash"
	if plan.HasMarkers {
		// Verify bash is available; cheap and avoids cryptic failures.
		if err := exec.Command("docker", "exec", containerName, "command", "-v", "bash").Run(); err != nil {
			shell = "sh"
			// Instrumented bodies use bash-only syntax — strip them.
			wrapped = `if [ -f /tmp/aws-assumed-env ]; then . /tmp/aws-assumed-env; fi; ` + step.Run
			plan.HasMarkers = false
		}
	} else {
		shell = "sh"
	}
	cmd := exec.CommandContext(ctx, "docker", "exec", "-w", "/app", containerName, shell, "-c", wrapped)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		send(WSMessage{Type: MsgError, Data: fmt.Sprintf("stdout pipe: %v", err), Step: step.Name})
		return stepResult{Code: 1, Reason: "internal: stdout pipe failed"}
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		send(WSMessage{Type: MsgError, Data: fmt.Sprintf("stderr pipe: %v", err), Step: step.Name})
		return stepResult{Code: 1, Reason: "internal: stderr pipe failed"}
	}
	if err := cmd.Start(); err != nil {
		send(WSMessage{Type: MsgError, Data: fmt.Sprintf("start: %v", err), Step: step.Name})
		return stepResult{Code: 1, Reason: fmt.Sprintf("internal: start failed: %v", err)}
	}

	var (
		tailMu sync.Mutex
		tail   = make([]string, 0, lastStderrSize)
	)
	pushTail := func(line string) {
		tailMu.Lock()
		defer tailMu.Unlock()
		if len(tail) >= lastStderrSize {
			tail = tail[1:]
		}
		tail = append(tail, line)
	}

	markerTag := plan.MarkerTag
	// emitOrFilter routes a single output line. Marker lines (only present
	// when we instrumented the script) are converted to MsgSubstep /
	// MsgSubstepEnd events and NOT forwarded as logs — they're protocol,
	// not user output.
	emitOrFilter := func(line, lineKind string) {
		if markerTag != "" {
			if id, name, kind := ParseSubstepMarker(line, markerTag); kind != MarkerNone {
				routeSubstepMarker(send, step.Name, id, name, kind)
				return
			}
		}
		if lineKind == "stderr" {
			pushTail(line)
			send(WSMessage{Type: MsgStderr, Data: line + "\n", Step: step.Name})
		} else {
			send(WSMessage{Type: MsgStdout, Data: line + "\n", Step: step.Name})
		}
	}

	done := make(chan struct{}, 2)
	go func() {
		scanner := bufio.NewScanner(stdout)
		// Bump max line size from default 64K to 1MB so embedded JSON logs
		// (e.g., docker buildkit progress, kubectl describe) don't truncate.
		scanner.Buffer(make([]byte, 64*1024), 1<<20)
		for scanner.Scan() {
			emitOrFilter(scanner.Text(), "stdout")
		}
		if err := scanner.Err(); err != nil {
			send(WSMessage{Type: MsgError, Data: fmt.Sprintf("stdout scan error: %v", err), Step: step.Name})
		}
		done <- struct{}{}
	}()
	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 64*1024), 1<<20)
		for scanner.Scan() {
			emitOrFilter(scanner.Text(), "stderr")
		}
		if err := scanner.Err(); err != nil {
			send(WSMessage{Type: MsgError, Data: fmt.Sprintf("stderr scan error: %v", err), Step: step.Name})
		}
		done <- struct{}{}
	}()

	<-done
	<-done

	code := 0
	if err := cmd.Wait(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		} else {
			code = 1
		}
	}

	tailMu.Lock()
	tailCopy := append([]string(nil), tail...)
	tailMu.Unlock()

	if code == 0 {
		return stepResult{Code: 0}
	}

	reason := fmt.Sprintf("exit %d", code)
	switch code {
	case 137:
		reason = "exit 137 (SIGKILL — likely out of memory)"
	case 139:
		reason = "exit 139 (segmentation fault)"
	case 143:
		reason = "exit 143 (SIGTERM — process terminated)"
	case -1:
		// Process killed via context cancellation.
		if ctx.Err() == context.DeadlineExceeded {
			reason = "step timed out"
		} else if ctx.Err() == context.Canceled {
			reason = "step cancelled"
		}
	}
	return stepResult{Code: code, Reason: reason, LastStderr: tailCopy}
}

// substepsEnabled reports whether substep planning is on for this step.
// `substeps: false` in YAML opts the step out; omitted defaults to true.
func substepsEnabled(step pipeline.Step) bool {
	return step.Substeps == nil || *step.Substeps
}

// resolvePlanOptions translates step.SubstepDepth into PlanOptions, surfacing
// a one-line stderr warning when the YAML asks for a depth above the safety
// cap. Negative / zero values use the planner default silently.
func resolvePlanOptions(step pipeline.Step, send func(WSMessage)) PlanOptions {
	if step.SubstepDepth == nil {
		return PlanOptions{}
	}
	d := *step.SubstepDepth
	if d > MaxAllowedPlanDepth {
		send(WSMessage{
			Type: MsgStderr,
			Step: step.Name,
			Data: fmt.Sprintf("[codeci] substep_depth=%d clamped to %d (MaxAllowedPlanDepth)\n", d, MaxAllowedPlanDepth),
		})
		d = MaxAllowedPlanDepth
	}
	return PlanOptions{MaxDepth: d}
}

// routeSubstepMarker converts a parsed marker into the appropriate WS
// message. Centralized so the docker and k8s runners stay in sync.
func routeSubstepMarker(send func(WSMessage), stepName, id, name string, kind MarkerKind) {
	switch kind {
	case MarkerStart:
		msg := WSMessage{Type: MsgSubstep, Data: id, Step: stepName}
		send(msg)
	case MarkerName:
		msg := WSMessage{Type: MsgSubstep, Data: id, Step: stepName}
		if name != "" {
			msg.Meta = map[string]string{"name": sanitizeLabel(stripBannerPunct(name))}
		}
		send(msg)
	case MarkerEnd:
		send(WSMessage{Type: MsgSubstepEnd, Data: id, Step: stepName})
	}
}
