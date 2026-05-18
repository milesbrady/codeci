package pipeline

import (
	"fmt"
	"strings"
)

// dangerousChars are shell metacharacters that could enable injection.
// Values containing these are rejected entirely.
var dangerousChars = []string{";", "&&", "||", "`", "$(", "${", "\n", "\r"}

func InterpolateSteps(steps []Step, params map[string]string, gitPAT string) ([]Step, error) {
	result := make([]Step, len(steps))
	for i, step := range steps {
		out := step // copy preserves Runner / CodeBuild
		if step.Run != "" {
			interpolated, err := interpolate(step.Run, params, gitPAT)
			if err != nil {
				return nil, fmt.Errorf("step %q: %w", step.Name, err)
			}
			out.Run = interpolated
		}
		if step.CodeBuild != nil {
			cb := *step.CodeBuild
			if cb.SourceVersion != "" {
				v, err := interpolate(cb.SourceVersion, params, "")
				if err != nil {
					return nil, fmt.Errorf("step %q: source_version: %w", step.Name, err)
				}
				cb.SourceVersion = v
			}
			if len(cb.Env) > 0 {
				newEnv := make(map[string]string, len(cb.Env))
				for k, v := range cb.Env {
					interpolated, err := interpolate(v, params, "")
					if err != nil {
						return nil, fmt.Errorf("step %q: env %q: %w", step.Name, k, err)
					}
					newEnv[k] = interpolated
				}
				cb.Env = newEnv
			}
			out.CodeBuild = &cb
		}
		result[i] = out
	}
	return result, nil
}

func interpolate(template string, params map[string]string, gitPAT string) (string, error) {
	for k, v := range params {
		if err := validateValue(k, v); err != nil {
			return "", err
		}

		finalVal := v
		// If it looks like a git URL and we have a PAT, inject it
		if gitPAT != "" && strings.HasPrefix(v, "https://") && !strings.Contains(v, "@") {
			finalVal = strings.Replace(v, "https://", fmt.Sprintf("https://%s@", gitPAT), 1)
		}

		template = strings.ReplaceAll(template, "${"+k+"}", finalVal)
	}
	return template, nil
}

func validateValue(key, value string) error {
	for _, ch := range dangerousChars {
		if strings.Contains(value, ch) {
			return fmt.Errorf("parameter %q contains disallowed characters", key)
		}
	}
	return nil
}
