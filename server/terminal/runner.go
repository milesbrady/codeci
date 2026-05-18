package terminal

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

// runnerImage mirrors execution.RunSteps' env override: production deployments
// override RUNNER_IMAGE, dev defaults to the local-built tag.
func runnerImage() string {
	if v := os.Getenv("RUNNER_IMAGE"); v != "" {
		return v
	}
	return "codeci-runner"
}

// EnsureStorageDirs creates the per-user root and shared dir on first boot.
// Per-user subdirectories are created lazily by StartContainer because the
// number of users is unbounded over time.
func EnsureStorageDirs(root string) error {
	if err := os.MkdirAll(filepath.Join(root, "users"), 0o755); err != nil {
		return err
	}
	// /shared is world-writable so any user's container (running as root inside,
	// but mapped to the host bind mount's perms) can read and write.
	return os.MkdirAll(filepath.Join(root, "shared"), 0o777)
}

// StartContainer spins up an ephemeral runner with the user's /storage and
// the global /shared bind-mounted, plus the same AWS / git env the pipeline
// runner uses so the user inherits pipeline-equivalent cloud access.
// Pipeline / script / config volumes are intentionally NOT replicated.
//
// userStoragePath / sharedStoragePath are the paths as the Docker daemon will
// see them — i.e. host paths if the backend is containerized.
func StartContainer(ctx context.Context, userID uint, userStoragePath, sharedStoragePath string) (string, error) {
	if err := os.MkdirAll(userStoragePath, 0o755); err != nil {
		return "", fmt.Errorf("create user storage dir: %w", err)
	}

	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		return "", fmt.Errorf("rand: %w", err)
	}
	name := fmt.Sprintf("codeci-terminal-%d-%s", userID, hex.EncodeToString(suffix))

	args := []string{
		"run", "-d", "--rm",
		"--name", name,
		"--memory=1g", "--cpus=2",
		"-v", userStoragePath + ":/storage",
		"-v", sharedStoragePath + ":/shared",
		"-w", "/storage",
	}
	// Forward the same env the pipeline runner gets. The container then resolves
	// AWS creds via IMDS (EC2 instance role) and bootstrap below assumes
	// PIPELINE_ROLE_ARN, matching what pipelines do.
	if pat := os.Getenv("GIT_PAT"); pat != "" {
		args = append(args, "-e", "GIT_PAT="+pat)
	}
	if roleArn := os.Getenv("PIPELINE_ROLE_ARN"); roleArn != "" {
		args = append(args, "-e", "PIPELINE_ROLE_ARN="+roleArn)
	}
	args = append(args, runnerImage(), "sleep", "infinity")

	if err := exec.CommandContext(ctx, "docker", args...).Run(); err != nil {
		return "", fmt.Errorf("docker run: %w", err)
	}

	// Best-effort bootstrap: container is already usable without these, so
	// any failure here is logged but doesn't block the user from getting a
	// shell. Mirrors execution/runner.go:setupDockerRunner.
	bootstrapShell(ctx, name)

	return name, nil
}

// bootstrapShell prepares the container for a friendly interactive session:
//   - ECR docker-credential helper config (for `docker login` parity)
//   - STS assume-role into PIPELINE_ROLE_ARN, written to /tmp/aws-assumed-env
//   - Git credentials configured from GIT_PAT
//   - /root/.bashrc auto-sources the assumed creds so `aws`, `kubectl`, etc.
//     "just work" with pipeline-equivalent permissions.
//
// All steps are best-effort — interactive bash starts regardless.
func bootstrapShell(ctx context.Context, containerName string) {
	steps := []string{
		// 1. ECR docker-credential helper (so `docker login` to ECR works).
		`mkdir -p /root/.docker && printf '{"credsStore":"ecr-login"}\n' > /root/.docker/config.json`,

		// 2. Assume PIPELINE_ROLE_ARN if set; jq @sh quoting handles tokens
		//    that include +, /, =, etc. without breaking shell parsing.
		`if [ -n "$PIPELINE_ROLE_ARN" ]; then ` +
			`aws sts assume-role ` +
			`--role-arn "$PIPELINE_ROLE_ARN" ` +
			`--role-session-name "codeci-terminal-$$" ` +
			`--query Credentials --output json 2>/dev/null ` +
			`| jq -r '"export AWS_ACCESS_KEY_ID=" + (.AccessKeyId | @sh), ` +
			`"export AWS_SECRET_ACCESS_KEY=" + (.SecretAccessKey | @sh), ` +
			`"export AWS_SESSION_TOKEN=" + (.SessionToken | @sh)' ` +
			`> /tmp/aws-assumed-env || rm -f /tmp/aws-assumed-env; fi`,

		// 3. Git credentials so `git clone` against private GitHub works.
		`if [ -n "$GIT_PAT" ]; then ` +
			`printf 'https://x-access-token:%s@github.com\n' "$GIT_PAT" > /root/.git-credentials && ` +
			`git config --global credential.helper store && ` +
			`git config --global url."https://x-access-token:$GIT_PAT@github.com/".insteadOf "https://github.com/"; fi`,

		// 4. Bashrc: auto-source assumed creds + identifiable prompt.
		`cat >> /root/.bashrc <<'BASHRC'

# Codeci terminal — auto-source assumed-role AWS creds if present
if [ -f /tmp/aws-assumed-env ]; then
    . /tmp/aws-assumed-env
fi

export PS1='\[\e[0;36m\]\u@codeci-terminal\[\e[0m\]:\[\e[0;32m\]\w\[\e[0m\]\$ '
BASHRC`,
	}

	for _, step := range steps {
		if out, err := exec.CommandContext(ctx, "docker", "exec", containerName, "sh", "-c", step).CombinedOutput(); err != nil {
			log.Printf("[terminal] bootstrap step failed (container=%s): %v: %s", containerName, err, string(out))
		}
	}
}

// StopContainer asks docker to stop the container with a 2s grace period.
// `--rm` on `docker run` ensures it's then removed.
func StopContainer(name string) {
	if name == "" {
		return
	}
	_ = exec.Command("docker", "stop", "-t", "2", name).Run()
}
