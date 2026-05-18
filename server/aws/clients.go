// Package aws holds the singleton AWS service clients used by the backend.
//
// On EC2 the underlying config is loaded from instance metadata; locally it
// reads the standard AWS_* env vars / shared config file. If config loading
// fails we return nil — the server stays runnable for users whose pipelines
// only use docker steps.
package aws

import (
	"context"
	"log"
	"os"
	"strings"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	awscfg "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
	"github.com/aws/aws-sdk-go-v2/service/codebuild"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// fallbackRegion is used only if neither the env, the shared config, nor
// IMDS provides a region. It exists to keep the SDK's endpoint resolver
// from blowing up with "Missing Region" when the backend container can't
// reach EC2 instance metadata (Docker bridge + IMDS hop limit = 1).
const fallbackRegion = "us-east-1"

// Clients bundles the AWS service clients needed by the CodeBuild runner.
// It is created once at startup and shared across all runs.
type Clients struct {
	Region     string
	CodeBuild  *codebuild.Client
	CloudWatch *cloudwatchlogs.Client
}

// New loads default AWS configuration and returns a Clients bundle. The
// region is resolved with this priority:
//
//  1. AWS_REGION env var (set explicitly in the docker-compose for prod)
//  2. AWS_DEFAULT_REGION env var
//  3. Anything LoadDefaultConfig finds (shared config, IMDS)
//  4. fallbackRegion
//
// If config loading itself fails, we log and return nil so non-CodeBuild
// pipelines keep working.
func New(ctx context.Context) *Clients {
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = os.Getenv("AWS_DEFAULT_REGION")
	}

	opts := []func(*awscfg.LoadOptions) error{
		// WithDefaultRegion only kicks in if no other source resolves one.
		awscfg.WithDefaultRegion(fallbackRegion),
	}
	if region != "" {
		opts = append(opts, awscfg.WithRegion(region))
	}

	cfg, err := awscfg.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		log.Printf("[aws] config load failed; CodeBuild steps will not be available: %v", err)
		return nil
	}
	if cfg.Region == "" {
		// Last-ditch belt-and-suspenders so the endpoint resolver never sees
		// an empty region.
		cfg.Region = fallbackRegion
	}

	// If PIPELINE_ROLE_ARN is set, assume it for all SDK calls. The EC2
	// instance role only has sts:AssumeRole on this ARN — the broader
	// codebuild:* / logs:* permissions live on the assumed role
	// (CodeBuildKubectlRole carries AWSCodeBuildAdminAccess +
	// CloudWatchLogsFullAccess). This mirrors the existing pattern the
	// runner container uses (`aws sts assume-role` before `aws codebuild
	// start-build`) and keeps us off a path that would require expanding
	// the EC2 role's identity-based policy.
	if roleArn := strings.TrimSpace(os.Getenv("PIPELINE_ROLE_ARN")); roleArn != "" {
		stsClient := sts.NewFromConfig(cfg)
		provider := stscreds.NewAssumeRoleProvider(stsClient, roleArn, func(o *stscreds.AssumeRoleOptions) {
			o.RoleSessionName = "codeci-backend"
		})
		// Cache wraps the provider so we don't hit STS on every SDK call —
		// it auto-refreshes ~5 min before the temporary creds expire.
		cfg.Credentials = awssdk.NewCredentialsCache(provider)
		log.Printf("[aws] backend will assume role for AWS API calls: %s", roleArn)
	}

	log.Printf("[aws] resolved region: %s", cfg.Region)
	return &Clients{
		Region:     cfg.Region,
		CodeBuild:  codebuild.NewFromConfig(cfg),
		CloudWatch: cloudwatchlogs.NewFromConfig(cfg),
	}
}
