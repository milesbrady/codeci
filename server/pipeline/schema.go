package pipeline

type Pipeline struct {
	ID          string      `json:"id"` // derived from filename slug
	Name        string      `yaml:"name" json:"name"`
	Description string      `yaml:"description" json:"description"`
	Version     string      `yaml:"version" json:"version"`
	Repository  string      `yaml:"repository,omitempty" json:"repository,omitempty"`
	// MaxConcurrentRuns caps how many copies of this pipeline may be running
	// at once on this server. Additional submissions are persisted with
	// status="queued" and dispatched FIFO as slots free up. Defaults to 1
	// when omitted (normalised in loader.go).
	MaxConcurrentRuns int `yaml:"max_concurrent_runs,omitempty" json:"max_concurrent_runs,omitempty"`
	// QueueStrategy controls what happens when a new run is submitted while
	// the per-pipeline limit is already saturated.
	//   - "fifo" (default): submissions are queued and dispatched in order.
	//   - "replace": only the most-recent submission stays queued; any
	//     existing queued run is marked "superseded" the moment a newer one
	//     arrives. Useful for "always build the latest commit" pipelines.
	//     Only valid when MaxConcurrentRuns == 1.
	QueueStrategy string      `yaml:"queue_strategy,omitempty" json:"queue_strategy,omitempty"`
	Parameters    []Parameter `yaml:"parameters" json:"parameters"`
	Steps         []Step      `yaml:"steps" json:"steps"`
}

// Queue strategy constants kept in one place so callers don't sprinkle the
// magic strings across the codebase.
const (
	QueueStrategyFIFO    = "fifo"
	QueueStrategyReplace = "replace"
)

// cloneStepSnippet is the canonical clone-or-update bash block injected as
// the first step when a pipeline declares a top-level `repository:`.
//
// Two-tier model:
//   1. A shared *bare mirror* at /var/cache/codeci/mirrors/<sha>.git acts as a
//      local cache for the repo. flock serializes concurrent `remote update`
//      calls when multiple runs target the same mirror.
//   2. Each run gets its own working tree at /tmp/codeci-deploy (provided as
//      an emptyDir on k8s and a per-run host bind in docker). The clone is
//      --single-branch --depth 1 from the local mirror, so it's fast and
//      isolated from any other in-flight run's checkout.
const cloneStepSnippet = `set -e
REPO="${git_repo}"
BRANCH="${git_branch}"
MIRROR_ROOT="/var/cache/codeci/mirrors"
SHA=$(printf '%s' "$REPO" | sha1sum | awk '{print $1}')
MIRROR="$MIRROR_ROOT/$SHA.git"
LOCK="$MIRROR_ROOT/$SHA.lock"
mkdir -p "$MIRROR_ROOT"
(
  flock 9
  if [ ! -d "$MIRROR" ]; then
    git clone --mirror --quiet "$REPO" "$MIRROR"
  else
    git -C "$MIRROR" remote set-url origin "$REPO"
    git -C "$MIRROR" remote update --prune
  fi
) 9>"$LOCK"
# /tmp/codeci-deploy is the mount point (emptyDir on k8s, bind on docker) —
# unlinking the directory itself fails with EBUSY. Empty its contents in
# place so git clone has a clean target.
mkdir -p /tmp/codeci-deploy
find /tmp/codeci-deploy -mindepth 1 -delete
git clone --branch "$BRANCH" --single-branch --depth 1 "$MIRROR" /tmp/codeci-deploy
echo "Branch: $(git -C /tmp/codeci-deploy branch --show-current) @ $(git -C /tmp/codeci-deploy rev-parse --short HEAD)"
`

// Expand applies schema-level conveniences. When Repository is set, it
// prepends a readonly git_repo parameter, a git_branch select parameter
// (source: git-branches:git_repo), and a "Clone / update repository" step —
// each only added if not already declared by the pipeline author.
func (p *Pipeline) Expand() {
	if p.Repository == "" {
		return
	}

	hasGitRepo, hasGitBranch := false, false
	for _, param := range p.Parameters {
		switch param.ID {
		case "git_repo":
			hasGitRepo = true
		case "git_branch":
			hasGitBranch = true
		}
	}

	var injected []Parameter
	if !hasGitRepo {
		injected = append(injected, Parameter{
			ID:       "git_repo",
			Label:    "Source Repository",
			Type:     "text",
			Required: true,
			Readonly: true,
			Default:  p.Repository,
		})
	}
	if !hasGitBranch {
		injected = append(injected, Parameter{
			ID:       "git_branch",
			Label:    "Branch",
			Type:     "select",
			Required: true,
			Default:  "main",
			Source:   "git-branches:git_repo",
			Options:  []Option{},
		})
	}
	if len(injected) > 0 {
		p.Parameters = append(injected, p.Parameters...)
	}

	hasCloneStep := false
	for _, s := range p.Steps {
		if s.Name == "Clone / update repository" {
			hasCloneStep = true
			break
		}
	}
	if !hasCloneStep {
		p.Steps = append([]Step{{
			Name:   "Clone / update repository",
			Run:    cloneStepSnippet,
			Runner: "docker",
		}}, p.Steps...)
	}

	// With a per-run checkout living at /tmp/codeci-deploy, every user step
	// should already start there — saves authors from repeating `cd
	// /tmp/codeci-deploy` at the top of each step. Skip the clone step
	// itself (it bootstraps the directory) and any non-shell step.
	// Existing pipelines that still write `cd /tmp/codeci-deploy` keep
	// working: the second cd is a harmless no-op.
	for i := range p.Steps {
		if p.Steps[i].Name == "Clone / update repository" {
			continue
		}
		if p.Steps[i].Run == "" {
			continue
		}
		p.Steps[i].Run = "cd /tmp/codeci-deploy\n" + p.Steps[i].Run
	}
}

type Parameter struct {
	ID          string   `yaml:"id" json:"id"`
	Label       string   `yaml:"label" json:"label"`
	Type        string   `yaml:"type" json:"type"` // text | select | checkbox | password
	Required    bool     `yaml:"required" json:"required"`
	Readonly    bool     `yaml:"readonly" json:"readonly"`
	Default     any      `yaml:"default" json:"default"`
	Placeholder string   `yaml:"placeholder" json:"placeholder"`
	Options     []Option `yaml:"options" json:"options"`
	Source      string   `yaml:"source" json:"source,omitempty"` // e.g. "git-branches:git_repo"
}

type Option struct {
	Label string `yaml:"label" json:"label"`
	Value string `yaml:"value" json:"value"`
}

// Step is one unit of pipeline execution. A step runs either inside the
// ephemeral docker runner (Runner == "" or "docker", uses Run) or on AWS
// CodeBuild (Runner == "codebuild", uses CodeBuild). Exactly one of Run or
// CodeBuild must be set; loader.go validates this.
//
// SubstepDepth and Substeps tune the per-step substep planner (see
// server/execution/substepplan.go). Both are pointer-typed so omitted vs
// zero-value is distinguishable in the YAML.
//
//   - Substeps:    false disables substep planning entirely for this step.
//                  The step still runs; the UI just shows it as a single
//                  milestone. Omitted = enabled.
//   - SubstepDepth: overrides the default depth cap. Higher = more nested
//                  calls surfaced as substeps. Values ≤ 0 use the default;
//                  values above the internal safety max are clamped. Ignored
//                  when Substeps is explicitly false.
type Step struct {
	Name         string         `yaml:"name" json:"name"`
	Run          string         `yaml:"run,omitempty" json:"run,omitempty"`
	Runner       string         `yaml:"runner,omitempty" json:"runner,omitempty"`
	CodeBuild    *CodeBuildStep `yaml:"codebuild,omitempty" json:"codebuild,omitempty"`
	Substeps     *bool          `yaml:"substeps,omitempty" json:"substeps,omitempty"`
	SubstepDepth *int           `yaml:"substep_depth,omitempty" json:"substep_depth,omitempty"`
}

// CodeBuildStep configures a step that delegates execution to an AWS
// CodeBuild project. The backend starts the build via the SDK and streams
// CloudWatch logs back over the same WebSocket.
type CodeBuildStep struct {
	Project           string            `yaml:"project" json:"project"`
	SourceVersion     string            `yaml:"source_version,omitempty" json:"source_version,omitempty"`
	Env               map[string]string `yaml:"env,omitempty" json:"env,omitempty"`
	BuildspecOverride string            `yaml:"buildspec_override,omitempty" json:"buildspec_override,omitempty"`
	TimeoutMinutes    int               `yaml:"timeout_minutes,omitempty" json:"timeout_minutes,omitempty"`
}
