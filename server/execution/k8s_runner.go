package execution

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/codeci/codeci/server/pipeline"
)

// k8sRunner executes pipeline steps inside an ephemeral Kubernetes pod
// (codeci-runner-<runID>) instead of a Docker container. It is selected when
// RUNNER_BACKEND=kubernetes is set on the backend pod. The pod template
// (image, namespace, PVCs, service account) is taken from env vars so the
// Helm chart can wire it without touching Go code.
type k8sRunner struct {
	podName   string
	namespace string
}

func (k *k8sRunner) run(ctx context.Context, step pipeline.Step, send func(WSMessage)) stepResult {
	return runKubectlExec(ctx, send, step, k.podName, k.namespace)
}

// k8sRunnerEnv collects the env-derived knobs that shape the runner pod.
type k8sRunnerEnv struct {
	Namespace        string
	ServiceAccount   string
	PipelinesPVC     string
	ScriptsPVC       string
	RepoCachePVC     string
	NodeSelectorJSON string
	TolerationsJSON  string
}

func loadK8sRunnerEnv() (k8sRunnerEnv, error) {
	ns := os.Getenv("RUNNER_NAMESPACE")
	if ns == "" {
		// Default to the namespace the backend pod is running in.
		if b, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace"); err == nil {
			ns = strings.TrimSpace(string(b))
		}
	}
	if ns == "" {
		return k8sRunnerEnv{}, errors.New("RUNNER_NAMESPACE not set and serviceaccount namespace file unavailable")
	}
	return k8sRunnerEnv{
		Namespace:        ns,
		ServiceAccount:   getenvDefault("RUNNER_SERVICE_ACCOUNT", "devops-pipeline-runner"),
		PipelinesPVC:     getenvDefault("RUNNER_PIPELINES_PVC", "devops-pipeline-pipelines"),
		ScriptsPVC:       getenvDefault("RUNNER_SCRIPTS_PVC", "devops-pipeline-scripts"),
		RepoCachePVC:     getenvDefault("RUNNER_REPO_CACHE_PVC", "devops-pipeline-repo-cache"),
		NodeSelectorJSON: os.Getenv("RUNNER_NODE_SELECTOR_JSON"),
		TolerationsJSON:  os.Getenv("RUNNER_TOLERATIONS_JSON"),
	}, nil
}

func getenvDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// setupK8sRunner mirrors setupDockerRunner: bring up the ephemeral runner,
// apply ECR credential helper / role assumption / git PAT bootstrap, return
// (runner, cleanup, 0, "") on success. On failure returns (nil, cleanup, code,
// reason); the cleanup may still need to delete a partially-created pod.
func setupK8sRunner(ctx context.Context, send func(WSMessage), runnerImage string, runID uint) (*k8sRunner, func(), int, string) {
	envCfg, err := loadK8sRunnerEnv()
	if err != nil {
		reason := fmt.Sprintf("k8s runner config: %v", err)
		send(WSMessage{Type: MsgError, Data: reason})
		return nil, nil, 1, reason
	}

	podName := fmt.Sprintf("codeci-runner-%d", runID)

	podYAML, err := renderRunnerPodYAML(podName, runnerImage, envCfg)
	if err != nil {
		reason := fmt.Sprintf("render runner pod spec: %v", err)
		send(WSMessage{Type: MsgError, Data: reason})
		return nil, nil, 1, reason
	}

	applyCmd := exec.CommandContext(ctx, "kubectl", "apply", "-n", envCfg.Namespace, "-f", "-")
	applyCmd.Stdin = strings.NewReader(podYAML)
	if out, applyErr := applyCmd.CombinedOutput(); applyErr != nil {
		reason := fmt.Sprintf("failed to create runner pod: %v: %s", applyErr, strings.TrimSpace(string(out)))
		send(WSMessage{Type: MsgError, Data: reason})
		return nil, nil, 1, reason
	}

	cleanup := func() {
		// Use a short grace period so cancel-run frees the pod promptly. We
		// detach context so this still runs when the run was cancelled.
		_ = exec.Command("kubectl", "delete", "pod", podName, "-n", envCfg.Namespace,
			"--grace-period=2", "--wait=false", "--ignore-not-found=true").Run()
	}

	waitCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	waitCmd := exec.CommandContext(waitCtx, "kubectl", "wait", "pod/"+podName,
		"-n", envCfg.Namespace, "--for=condition=Ready", "--timeout=3m")
	if out, waitErr := waitCmd.CombinedOutput(); waitErr != nil {
		reason := fmt.Sprintf("runner pod %s did not become ready: %v: %s", podName, waitErr, strings.TrimSpace(string(out)))
		send(WSMessage{Type: MsgError, Data: reason})
		return nil, cleanup, 1, reason
	}

	// Combined setup: ECR docker-credential helper config + Git safe-directory.
	// EFS access points assign workdir ownership from a configured GID range
	// (1000–2000 by default) while the runner pod runs as UID 0; without
	// `safe.directory *` Git refuses operations on the cloned repo with
	// "fatal: detected dubious ownership in repository". The wildcard is
	// scoped to this ephemeral pod and disappears on teardown.
	podSetup := `mkdir -p /app /root/.docker && ` +
		`printf '{"credsStore":"ecr-login"}\n' > /root/.docker/config.json && ` +
		`git config --global --add safe.directory '*'`
	if err := kubectlExecSilent(ctx, envCfg.Namespace, podName, podSetup); err != nil {
		reason := fmt.Sprintf("failed to init runner pod (docker config + git safe-dir): %v", err)
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
		if err := kubectlExecSilent(ctx, envCfg.Namespace, podName, assumeCmd); err != nil {
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
		if res := runKubectlExec(ctx, send, setupStep, podName, envCfg.Namespace); res.Code != 0 {
			send(WSMessage{Type: MsgError, Data: "failed to configure git credentials"})
			return nil, cleanup, res.Code, "git credential setup failed"
		}
	}

	return &k8sRunner{podName: podName, namespace: envCfg.Namespace}, cleanup, 0, ""
}

// kubectlExecSilent runs a shell command inside the runner pod and discards
// output unless the command fails. Used by setup steps that shouldn't pollute
// the user-visible log stream.
func kubectlExecSilent(ctx context.Context, namespace, podName, shellCmd string) error {
	cmd := exec.CommandContext(ctx, "kubectl", "exec", podName, "-n", namespace, "--", "sh", "-c", shellCmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// runKubectlExec is the k8s equivalent of runDockerExec: stream stdout/stderr
// to the WS, bound tail buffer for failure summary, classify common signal-
// based exit codes for the failure UX.
func runKubectlExec(ctx context.Context, send func(WSMessage), step pipeline.Step, podName, namespace string) stepResult {
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
	wrapped := `if [ -f /tmp/aws-assumed-env ]; then . /tmp/aws-assumed-env; fi; cd /app; ` + scriptBody
	shell := "bash"
	if !plan.HasMarkers {
		shell = "sh"
	} else {
		// The runner image bundles bash; the pod is built from the same
		// codeci-runner image. If we ever bring up a slim pod that lacks
		// bash this would surface as a runtime failure — handle once that
		// becomes a real configuration.
	}
	cmd := exec.CommandContext(ctx, "kubectl", "exec", podName, "-n", namespace, "--", shell, "-c", wrapped)

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
		if ctx.Err() == context.DeadlineExceeded {
			reason = "step timed out"
		} else if ctx.Err() == context.Canceled {
			reason = "step cancelled"
		}
	}
	return stepResult{Code: code, Reason: reason, LastStderr: tailCopy}
}

// renderRunnerPodYAML produces the inline manifest that creates the
// ephemeral runner pod. Volume claims and the service account come from
// loadK8sRunnerEnv so the Helm chart owns the wiring.
func renderRunnerPodYAML(name, image string, env k8sRunnerEnv) (string, error) {
	// Optional nodeSelector / tolerations are passed in as raw JSON for
	// simplicity; we marshal them straight into the spec when present.
	var nodeSelector map[string]string
	if env.NodeSelectorJSON != "" {
		if err := json.Unmarshal([]byte(env.NodeSelectorJSON), &nodeSelector); err != nil {
			return "", fmt.Errorf("RUNNER_NODE_SELECTOR_JSON: %w", err)
		}
	}
	var tolerations []any
	if env.TolerationsJSON != "" {
		if err := json.Unmarshal([]byte(env.TolerationsJSON), &tolerations); err != nil {
			return "", fmt.Errorf("RUNNER_TOLERATIONS_JSON: %w", err)
		}
	}

	pod := map[string]any{
		"apiVersion": "v1",
		"kind":       "Pod",
		"metadata": map[string]any{
			"name": name,
			"labels": map[string]string{
				"app.kubernetes.io/name":       "devops-pipeline-runner",
				"app.kubernetes.io/managed-by": "codeci-backend",
			},
		},
		"spec": map[string]any{
			"restartPolicy":      "Never",
			"serviceAccountName": env.ServiceAccount,
			"containers": []any{
				map[string]any{
					"name":            "runner",
					"image":           image,
					"imagePullPolicy": "IfNotPresent",
					"command":         []string{"sleep", "infinity"},
					"workingDir":      "/app",
					"env": []any{
						map[string]any{"name": "GIT_PAT", "value": os.Getenv("GIT_PAT")},
						map[string]any{"name": "PIPELINE_ROLE_ARN", "value": os.Getenv("PIPELINE_ROLE_ARN")},
						map[string]any{"name": "AWS_REGION", "value": os.Getenv("AWS_REGION")},
						// EFS access points map every operation to a fixed UID;
						// root inside the pod can't chown back to uid 0, which
						// breaks `tar -x` (and any restore of ownership). The
						// TAR_OPTIONS env var is prepended to every GNU-tar
						// invocation, so this is the cheapest global fix.
						map[string]any{"name": "TAR_OPTIONS", "value": "--no-same-owner"},
					},
					"volumeMounts": []any{
						map[string]any{"name": "pipelines", "mountPath": "/app/pipelines", "readOnly": true},
						map[string]any{"name": "scripts", "mountPath": "/app/user-scripts", "readOnly": true},
						map[string]any{"name": "repo-cache", "mountPath": "/tmp/codeci-deploy"},
					},
				},
			},
			"volumes": []any{
				map[string]any{
					"name":                  "pipelines",
					"persistentVolumeClaim": map[string]string{"claimName": env.PipelinesPVC},
				},
				map[string]any{
					"name":                  "scripts",
					"persistentVolumeClaim": map[string]string{"claimName": env.ScriptsPVC},
				},
				map[string]any{
					"name":                  "repo-cache",
					"persistentVolumeClaim": map[string]string{"claimName": env.RepoCachePVC},
				},
			},
		},
	}
	if nodeSelector != nil {
		pod["spec"].(map[string]any)["nodeSelector"] = nodeSelector
	}
	if tolerations != nil {
		pod["spec"].(map[string]any)["tolerations"] = tolerations
	}

	b, err := json.Marshal(pod) // kubectl accepts JSON via -f
	if err != nil {
		return "", err
	}
	return string(b), nil
}
