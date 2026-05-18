package execution

import (
	"os"
	"strings"
	"testing"
)

// TestPlanSubsteps_RealDeployScript verifies the planner handles the user's
// real-world deploy script (when present in the repo cache) without crashing,
// and produces a reasonable number of substeps. It is skipped when the script
// isn't available locally — the test is end-to-end and not part of CI gating.
func TestPlanSubsteps_RealDeployScript(t *testing.T) {
	scriptPath := "../../repo-cache/kubernetes/scripts/deploy-application.sh"
	body, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Skipf("real-world script not available at %s: %v", scriptPath, err)
	}

	// Simulate the YAML step that invokes the script.
	yamlRunBlock := "cd ../../repo-cache\n" +
		"export AWS_REGION=us-east-1\n" +
		"bash " + scriptPath + " --override-cluster=devops --override-namespace=devops\n"

	plan := PlanSubsteps(yamlRunBlock, ".", "", PlanOptions{})
	if !plan.HasMarkers {
		t.Fatal("planner produced empty plan for real-world step")
	}
	if len(plan.Substeps) < 1 {
		t.Fatalf("expected at least one substep, got %d", len(plan.Substeps))
	}

	// The bash invocation MUST get recursively expanded.
	bashCall := plan.Substeps[len(plan.Substeps)-1]
	if len(bashCall.Children) == 0 {
		t.Fatalf("expected children for bash %s invocation, got none", scriptPath)
	}
	t.Logf("real-world plan: %d top-level substeps, deploy-application.sh expanded into %d children",
		len(plan.Substeps), len(bashCall.Children))

	// Smoke-check: the instrumented script should contain a marker emit for
	// at least the first child of the recursive expansion.
	if !strings.Contains(plan.Script, "__codeci_marker \"") {
		t.Errorf("instrumented script appears to be missing marker emits")
	}
	_ = body
}
