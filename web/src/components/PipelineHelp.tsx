export function PipelineHelp() {
  return (
    <div className="space-y-6 text-sm text-zinc-400">
      <section>
        <h3 className="text-zinc-200 font-medium mb-2 border-b border-zinc-800 pb-1">Core Fields</h3>
        <ul className="list-disc list-inside space-y-1">
          <li><code className="text-violet-400">name</code>: Display name of the pipeline</li>
          <li><code className="text-violet-400">description</code>: Purpose of this pipeline</li>
          <li><code className="text-violet-400">version</code>: Version (e.g. "1.0.0")</li>
        </ul>
      </section>

      <section>
        <h3 className="text-zinc-200 font-medium mb-2 border-b border-zinc-800 pb-1">Parameters</h3>
        <p className="mb-2 italic text-xs">Defines inputs for the pipeline run.</p>
        <ul className="space-y-2">
          <li>
            <code className="text-violet-400">id</code>: Unique identifier used for interpolation
          </li>
          <li>
            <code className="text-violet-400">type</code>: 
            <span className="text-zinc-500 ml-1">text, select, checkbox, password</span>
          </li>
          <li>
            <code className="text-violet-400">required</code>: 
            <span className="text-zinc-500 ml-1">Boolean; prevents running if empty</span>
          </li>
          <li>
            <code className="text-violet-400">default</code>: 
            <span className="text-zinc-500 ml-1">Initial value for the input</span>
          </li>
          <li>
            <code className="text-violet-400">readonly</code>: 
            <span className="text-zinc-500 ml-1">Boolean; user cannot change value</span>
          </li>
          <li>
            <code className="text-violet-400">placeholder</code>: 
            <span className="text-zinc-500 ml-1">Hint text for empty inputs</span>
          </li>
        </ul>
      </section>

      <section>
        <h3 className="text-zinc-200 font-medium mb-2 border-b border-zinc-800 pb-1">Special Sources</h3>
        <p className="text-xs mb-2">
          Use <code className="text-violet-400">source: git-branches:param_id</code> on a <code className="text-zinc-300">select</code> type to fetch branches from a git URL provided in another parameter.
        </p>
      </section>

      <section>
        <h3 className="text-zinc-200 font-medium mb-2 border-b border-zinc-800 pb-1">User Scripts</h3>
        <p className="text-xs mb-2">
          You can reference scripts created in the <strong>Scripts</strong> section. These are available at <code className="text-violet-400">/app/user-scripts/id.sh</code>.
        </p>
        <div className="rounded bg-zinc-950 p-2 border border-zinc-800">
          <pre className="text-[10px] text-zinc-500">
{`steps:
  - name: Run Custom Script
    run: bash /app/user-scripts/my-script.sh`}
          </pre>
        </div>
      </section>

      <section>
        <h3 className="text-zinc-200 font-medium mb-2 border-b border-zinc-800 pb-1">AWS CodeBuild Runner</h3>
        <p className="text-xs mb-2">
          Any step can run on an existing AWS <strong>CodeBuild</strong> project instead of the local docker runner. Set
          {" "}<code className="text-violet-400">runner: codebuild</code> and provide a <code className="text-violet-400">codebuild</code> block. Docker and CodeBuild steps can be mixed inside the same pipeline.
        </p>
        <ul className="list-disc list-inside space-y-1 text-xs mb-2">
          <li><code className="text-violet-400">project</code>: Name of the existing CodeBuild project (required)</li>
          <li><code className="text-violet-400">env</code>: Map of env vars passed via <code className="text-zinc-300">EnvironmentVariablesOverride</code>; values support <code className="text-zinc-300">{"${param_id}"}</code></li>
          <li><code className="text-violet-400">source_version</code>: Branch, tag, or commit to build from. Supports <code className="text-zinc-300">{"${param_id}"}</code> — e.g. <code className="text-zinc-300">{"${git_branch}"}</code></li>
          <li><code className="text-violet-400">buildspec_override</code>: Optional inline buildspec</li>
          <li><code className="text-violet-400">timeout_minutes</code>: Optional build timeout</li>
        </ul>
        <div className="rounded bg-zinc-950 p-2 border border-zinc-800">
          <pre className="text-[10px] text-zinc-500">
{`steps:
  - name: Build Images
    runner: codebuild
    codebuild:
      project: my-image-builder
      env:
        IMAGE_TAG: "\${image_tag}"
        CLUSTER_NAME: "\${override_cluster}"
        AWS_REGION: "\${aws_region}"
      timeout_minutes: 30`}
          </pre>
        </div>
        <div className="space-y-1 text-xs mt-2">
          <p>
            <strong>Live tail:</strong> While the build runs, the step row shows a rolling preview of the last ~10 CloudWatch lines, plus a <code className="text-zinc-300">[CodeBuild]</code> chip with the current phase and a link to the AWS console.
          </p>
          <p>
            <strong>On success:</strong> the tail is cleared and a single <code className="text-zinc-300">[CodeBuild] build SUCCEEDED</code> line is kept — full logs stay in CloudWatch only.
          </p>
          <p>
            <strong>On failure:</strong> the last ~30 log lines plus the failed phase context are saved and shown in the failure summary banner.
          </p>
          <p className="text-zinc-500">
            <strong>Note:</strong> the EC2 instance role must allow <code className="text-zinc-300">codebuild:StartBuild</code>, <code className="text-zinc-300">codebuild:BatchGetBuilds</code>, <code className="text-zinc-300">codebuild:StopBuild</code>, and <code className="text-zinc-300">logs:GetLogEvents</code> on the build's log group.
          </p>
        </div>
      </section>

      <section>
        <h3 className="text-zinc-200 font-medium mb-2 border-b border-zinc-800 pb-1">Execution &amp; Security</h3>
        <div className="space-y-2 text-xs">
          <p>
            Values are injected into steps using <code className="text-violet-400">{"${param_id}"}</code>.
          </p>
          <div className="rounded bg-red-950/20 border border-red-900/30 p-2 text-red-300/80">
            <strong>Security:</strong> Characters like <code className="text-red-200 font-mono">; &amp;&amp; || ` $(</code> are disallowed in parameter values to prevent shell injection.
          </div>
          <p>
            <strong>Git Auth:</strong> HTTPS git URLs automatically have the system Personal Access Token (PAT) injected if configured.
          </p>
        </div>
      </section>

      <section>
        <h3 className="text-zinc-200 font-medium mb-2 border-b border-zinc-800 pb-1">Step Example</h3>
        <div className="rounded bg-zinc-950 p-2 border border-zinc-800">
          <pre className="text-[10px] text-zinc-500">
{`steps:
  - name: Build
    run: |
      npm install
      npm run build
  - name: Deploy
    run: ./deploy.sh --env \${env}`}
          </pre>
        </div>
      </section>
    </div>
  );
}
