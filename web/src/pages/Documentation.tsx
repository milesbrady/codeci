import { useEffect, useMemo, useState } from "react";
import { Layout, PageHeader } from "@/components/Layout";
import {
  BookOpen,
  LayoutDashboard,
  Activity,
  History,
  Terminal as TerminalIcon,
  TerminalSquare,
  Bell,
  User as UserIcon,
  Settings as SettingsIcon,
  Search,
  Play,
  StopCircle,
  Trash2,
  ChevronRight,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Section = {
  id: string;
  label: string;
  group: "Overview" | "Pipeline Authoring" | "Using the App";
};

const SECTIONS: Section[] = [
  { id: "intro", label: "Getting Started", group: "Overview" },
  { id: "concepts", label: "Core Concepts", group: "Overview" },
  { id: "auth", label: "Sign-in & Session", group: "Overview" },

  { id: "yaml-overview", label: "YAML at a Glance", group: "Pipeline Authoring" },
  { id: "core-fields", label: "Core Fields", group: "Pipeline Authoring" },
  { id: "parameters", label: "Parameters", group: "Pipeline Authoring" },
  { id: "sources", label: "Dynamic Sources", group: "Pipeline Authoring" },
  { id: "steps", label: "Steps & Interpolation", group: "Pipeline Authoring" },
  { id: "substeps", label: "Substep Progress Tree", group: "Pipeline Authoring" },
  { id: "codebuild", label: "AWS CodeBuild Runner", group: "Pipeline Authoring" },
  { id: "user-scripts", label: "User Scripts", group: "Pipeline Authoring" },
  { id: "security", label: "Execution & Security", group: "Pipeline Authoring" },
  { id: "full-example", label: "Full Example", group: "Pipeline Authoring" },

  { id: "ui-pipelines", label: "Pipelines Page", group: "Using the App" },
  { id: "ui-run", label: "Running a Pipeline", group: "Using the App" },
  { id: "ui-active", label: "Active Runs", group: "Using the App" },
  { id: "ui-history", label: "Run History & Logs", group: "Using the App" },
  { id: "ui-scripts", label: "Scripts", group: "Using the App" },
  { id: "ui-terminal", label: "Terminal", group: "Using the App" },
  { id: "ui-notifications", label: "Notifications", group: "Using the App" },
  { id: "ui-profile", label: "Profile & TOTP", group: "Using the App" },
  { id: "ui-settings", label: "Admin Settings", group: "Using the App" },
  { id: "ui-tips", label: "Tips & Shortcuts", group: "Using the App" },
];

function Code({ children }: { children: React.ReactNode }) {
  return <code className="text-violet-400 font-mono text-[12px]">{children}</code>;
}

function Block({ children }: { children: string }) {
  return (
    <div className="rounded-md bg-zinc-950 border border-zinc-800 p-3 my-3">
      <pre className="text-[11px] leading-relaxed text-zinc-300 overflow-x-auto whitespace-pre">
{children}
      </pre>
    </div>
  );
}

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="scroll-mt-24 text-lg font-semibold text-zinc-100 mt-10 mb-3 pb-2 border-b border-zinc-800"
    >
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-zinc-200 mt-5 mb-2">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-zinc-400 leading-relaxed mb-3">{children}</p>;
}

function UL({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc list-outside pl-5 space-y-1.5 text-sm text-zinc-400 mb-3">{children}</ul>;
}

function Note({ tone = "info", children }: { tone?: "info" | "warn"; children: React.ReactNode }) {
  const palette =
    tone === "warn"
      ? "bg-amber-950/30 border-amber-900/40 text-amber-200"
      : "bg-violet-950/20 border-violet-900/40 text-violet-200";
  return (
    <div className={cn("rounded-md border p-3 my-3 text-xs leading-relaxed", palette)}>
      {children}
    </div>
  );
}

function NavRowDemo({
  Icon,
  label,
  hint,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-md border border-zinc-800 bg-zinc-900/40 text-sm">
      <Icon className="h-4 w-4 text-violet-400" />
      <span className="font-medium text-zinc-200 w-32">{label}</span>
      <span className="text-xs text-zinc-500">{hint}</span>
    </div>
  );
}

export function Documentation() {
  const [active, setActive] = useState<string>("intro");

  const grouped = useMemo(() => {
    const map = new Map<string, Section[]>();
    for (const s of SECTIONS) {
      if (!map.has(s.group)) map.set(s.group, []);
      map.get(s.group)!.push(s);
    }
    return map;
  }, []);

  // Track which section is in view to highlight the TOC.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 }
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <Layout>
      <PageHeader
        title="Documentation"
        description="Pipeline reference plus a tour of the app"
      />

      <div className="flex">
        {/* TOC */}
        <aside className="hidden lg:block w-64 shrink-0 border-r border-zinc-800 px-4 py-6 sticky top-0 self-start max-h-screen overflow-y-auto">
          {[...grouped.entries()].map(([group, items]) => (
            <div key={group} className="mb-5">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">
                {group}
              </p>
              <ul className="space-y-0.5">
                {items.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className={cn(
                        "block text-xs px-2 py-1 rounded transition-colors",
                        active === s.id
                          ? "bg-violet-600/20 text-violet-300"
                          : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60"
                      )}
                    >
                      {s.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>

        {/* Content */}
        <div className="flex-1 px-8 py-8 max-w-3xl">
          {/* ---------- OVERVIEW ---------- */}
          <H2 id="intro">
            <BookOpen className="inline h-5 w-5 text-violet-400 mr-2 -mt-0.5" />
            Getting Started
          </H2>
          <P>
            This app is a self-hosted DevOps console. You define pipelines as YAML files,
            and the UI renders typed forms, runs each step inside an ephemeral Docker
            container, and streams output live over WebSockets.
          </P>
          <P>
            Most users only need to know two things: how to fill in a pipeline form and
            click <strong>Run</strong>, and where to find the logs afterwards. Authors
            and admins get the rest of this doc.
          </P>

          <H2 id="concepts">Core Concepts</H2>
          <UL>
            <li>
              <strong className="text-zinc-200">Pipeline.</strong> A YAML file in{" "}
              <Code>pipelines/</Code> describing parameters and ordered steps. Edit
              live — no restart needed.
            </li>
            <li>
              <strong className="text-zinc-200">Run.</strong> One execution of a
              pipeline. Every run gets its own Docker container that is destroyed when
              the run ends.
            </li>
            <li>
              <strong className="text-zinc-200">Step.</strong> A single shell command (or
              CodeBuild job). Steps run sequentially; a non-zero exit fails the run.
            </li>
            <li>
              <strong className="text-zinc-200">Background execution.</strong> Once a
              run starts, closing the tab or refreshing the page does <em>not</em> kill
              it. Re-open the run from <Code>Run History</Code> or{" "}
              <Code>Active Runs</Code> to re-attach to the live log stream.
            </li>
            <li>
              <strong className="text-zinc-200">Concurrency.</strong> Multiple pipelines
              can run at once — each gets its own container and goroutine. They never
              block each other.
            </li>
          </UL>

          <H2 id="auth">Sign-in & Session</H2>
          <P>
            Two sign-in methods are supported and can coexist on the same instance:
          </P>
          <UL>
            <li>
              <strong className="text-zinc-200">Local</strong> — username + password.
              The first login enrolls TOTP (a 6-digit code from Google Authenticator,
              1Password, etc.). Every subsequent login asks for the code.
            </li>
            <li>
              <strong className="text-zinc-200">Microsoft Entra ID</strong> — when an
              admin enables it, a "Sign in with Microsoft" button appears on the login
              page. Entra users skip TOTP because Microsoft already enforces MFA.
            </li>
          </UL>
          <P>
            Sessions live in browser <Code>sessionStorage</Code> only — closing the tab
            signs you out. The server-side TTL is 24 hours by default; once it expires,
            the next interaction kicks you to <Code>/login?expired=1</Code>.
          </P>

          {/* ---------- AUTHORING ---------- */}
          <H2 id="yaml-overview">YAML at a Glance</H2>
          <P>
            Drop a <Code>.yaml</Code> file into the <Code>pipelines/</Code> directory
            and it shows up immediately — the loader reads the directory on every
            request. The slug of the filename becomes the pipeline ID.
          </P>
          <Block>{`name: string
description: string
version: string

parameters:
  - id: string
    label: string
    type: text | select | checkbox | password
    required: bool
    default: any
    placeholder: string
    readonly: bool
    options:        # select only (static list)
      - { label: string, value: string }
    source: string  # optional, e.g. "git-branches:<param_id>"

steps:
  - name: string
    runner: docker | codebuild   # optional; inferred when omitted
    run: string                  # docker steps
    substeps: bool               # docker steps; default true
    substep_depth: int           # docker steps; default 2 (max 10)
    codebuild:                   # codebuild steps
      project: string
      env: { KEY: value, ... }
      source_version: string
      buildspec_override: string
      timeout_minutes: int`}</Block>

          <H2 id="core-fields">Core Fields</H2>
          <UL>
            <li><Code>name</Code> — display name shown in the Pipelines list.</li>
            <li><Code>description</Code> — one-line summary; supports any plain text.</li>
            <li><Code>version</Code> — free-form string, e.g. <Code>"1.0.0"</Code>.</li>
          </UL>

          <H2 id="parameters">Parameters</H2>
          <P>
            Every parameter you declare becomes a typed field in the run form. The{" "}
            <Code>id</Code> is the variable you use inside steps via{" "}
            <Code>{"${id}"}</Code>.
          </P>
          <UL>
            <li><Code>type: text</Code> — single-line string input.</li>
            <li><Code>type: select</Code> — dropdown; populated from <Code>options</Code> or a dynamic <Code>source</Code>.</li>
            <li><Code>type: checkbox</Code> — boolean; expands to <Code>"true"</Code> or <Code>"false"</Code> when interpolated.</li>
            <li><Code>type: password</Code> — masked input; the value is treated as sensitive.</li>
            <li><Code>required: true</Code> — blocks the Run button while the field is empty.</li>
            <li><Code>default</Code> — pre-fills the form so common runs are one-click.</li>
            <li><Code>readonly: true</Code> — shown to the user but not editable; useful for fixed identifiers.</li>
            <li><Code>placeholder</Code> — hint text inside empty inputs.</li>
          </UL>

          <H2 id="sources">Dynamic Sources</H2>
          <P>
            Set <Code>source: git-branches:&lt;param_id&gt;</Code> on a{" "}
            <Code>select</Code> to auto-populate it from the live branches of the repo
            URL held in another parameter. The fetch is debounced (~600&nbsp;ms after
            the user stops typing). If a <Code>default</Code> branch is declared and
            present in the fetched list, it gets pre-selected.
          </P>
          <Block>{`parameters:
  - id: repo
    label: Repository URL
    type: text
    default: https://github.com/example-org/example.git

  - id: branch
    label: Branch
    type: select
    source: git-branches:repo
    default: main`}</Block>
          <Note>
            HTTPS git URLs automatically have the system Personal Access Token (PAT)
            injected when one is configured, so private repos work without
            per-pipeline credentials.
          </Note>

          <H2 id="steps">Steps & Interpolation</H2>
          <P>
            Steps run in declared order. Each step's <Code>run</Code> field is a shell
            script — multi-line is fine. Reference any parameter as{" "}
            <Code>{"${param_id}"}</Code>; the server substitutes values just before the
            step is launched.
          </P>
          <Block>{`steps:
  - name: Build
    run: |
      npm install
      npm run build

  - name: Deploy
    run: ./deploy.sh --env \${env}`}</Block>

          <H2 id="substeps">Substep Progress Tree</H2>
          <P>
            Docker steps automatically surface individual commands and nested
            function / external-script calls as a live progress tree, so long
            scripts show <em>where</em> they are at any moment. Two optional
            per-step fields control it:
          </P>
          <UL>
            <li>
              <Code>substeps: false</Code> — turn the tree off entirely for this
              step. The step still runs; the UI shows it as a single milestone.
              Useful for noisy or sensitive steps. Default is <Code>true</Code>.
            </li>
            <li>
              <Code>substep_depth: N</Code> — how deep to follow function /
              script calls when building the tree. Default <Code>2</Code> covers{" "}
              <em>top-level call → its body → leaf names</em> (three levels of
              names visible). Bump it (max <Code>10</Code>) when running a
              script with deeply nested helpers; the chain still executes either
              way, only the visible depth changes.
            </li>
          </UL>
          <Block>{`steps:
  - name: Deploy Application
    substep_depth: 4
    run: bash kubernetes/scripts/deploy-application.sh \${cluster}

  - name: Quick echo
    substeps: false
    run: echo done`}</Block>

          <H2 id="codebuild">AWS CodeBuild Runner</H2>
          <P>
            Any step can run inside an existing AWS CodeBuild project instead of the
            local Docker runner. Set <Code>runner: codebuild</Code> and provide a{" "}
            <Code>codebuild</Code> block. Docker and CodeBuild steps may be mixed
            inside the same pipeline.
          </P>
          <UL>
            <li><Code>project</Code> — name of the existing CodeBuild project (required).</li>
            <li><Code>env</Code> — map of env vars passed via <Code>EnvironmentVariablesOverride</Code>; values support <Code>{"${param_id}"}</Code>.</li>
            <li><Code>source_version</Code> — branch, tag, or commit to build from. Supports <Code>{"${param_id}"}</Code> — e.g. <Code>{"${git_branch}"}</Code>.</li>
            <li><Code>buildspec_override</Code> — optional inline buildspec.</li>
            <li><Code>timeout_minutes</Code> — optional build timeout.</li>
          </UL>
          <Block>{`steps:
  - name: Build Images
    runner: codebuild
    codebuild:
      project: my-image-builder
      source_version: "\${git_branch}"   # branch/tag/commit; supports \${param} refs
      env:
        IMAGE_TAG: "\${image_tag}"
        CLUSTER_NAME: "\${override_cluster}"
        AWS_REGION: "\${aws_region}"
      timeout_minutes: 30`}</Block>
          <H3>What you'll see in the UI</H3>
          <UL>
            <li>While the build runs, the step row shows a rolling preview of the last ~10 CloudWatch lines, plus a <Code>[CodeBuild]</Code> chip with the current phase and a deep-link to the AWS console.</li>
            <li>On success, the tail collapses to a single <Code>[CodeBuild] build SUCCEEDED</Code> line — full logs stay in CloudWatch.</li>
            <li>On failure, the last ~30 lines plus the failed phase are saved into the failure summary banner at the top of the run.</li>
          </UL>
          <Note tone="warn">
            The host EC2 role must allow{" "}
            <Code>codebuild:StartBuild</Code>, <Code>codebuild:BatchGetBuilds</Code>,{" "}
            <Code>codebuild:StopBuild</Code>, and{" "}
            <Code>logs:GetLogEvents</Code> on the build's log group.
          </Note>

          <H2 id="user-scripts">User Scripts</H2>
          <P>
            The <Code>Scripts</Code> section in the sidebar is a small script library.
            Anything you save there is automatically mounted inside every runner at{" "}
            <Code>/app/user-scripts/&lt;id&gt;.sh</Code>, so steps can call shared
            scripts without baking them into a pipeline file.
          </P>
          <Block>{`steps:
  - name: Run Custom Script
    run: bash /app/user-scripts/my-script.sh`}</Block>
          <P>
            Scripts can also be executed standalone from <Code>Scripts → Run</Code> for
            one-off tasks; that path uses the same runner image but bypasses the
            pipeline form.
          </P>

          <H2 id="security">Execution & Security</H2>
          <UL>
            <li>
              Each run gets a fresh <Code>codeci-runner</Code> container that is
              torn down when the run finishes — no state leaks between runs.
            </li>
            <li>
              The repo cache at <Code>/tmp/codeci-deploy</Code> (mapped to{" "}
              <Code>./repo-cache</Code> on the host) is shared across runs so git
              clones stay fast.
            </li>
            <li>
              Volume mounts on the backend (AWS credentials, Docker socket, repo
              cache) are detected and replicated into the ephemeral runner.
            </li>
            <li>
              Logs are buffered in memory and flushed to the database every 5 seconds,
              plus a final flush on completion — survives a server restart mid-run.
            </li>
          </UL>
          <Note tone="warn">
            Parameter values reject the characters <code className="text-red-300 font-mono">; &amp;&amp; || ` $(</code>{" "}
            to prevent shell injection. If your value legitimately needs one of these,
            handle it inside a script you control rather than the parameter itself.
          </Note>

          <H2 id="full-example">Full Example</H2>
          <Block>{`name: Build & Deploy Web App
description: Build the React UI and deploy to a target environment
version: "1.2.0"

parameters:
  - id: repo
    label: Repository URL
    type: text
    required: true
    default: https://github.com/example-org/example.git

  - id: branch
    label: Branch
    type: select
    source: git-branches:repo
    default: main

  - id: env
    label: Environment
    type: select
    required: true
    options:
      - { label: Staging,    value: staging }
      - { label: Production, value: prod }

  - id: skip_tests
    label: Skip tests
    type: checkbox
    default: false

steps:
  - name: Checkout
    run: |
      cd /tmp/codeci-deploy
      rm -rf app && git clone --branch \${branch} \${repo} app

  - name: Test
    run: |
      cd /tmp/codeci-deploy/app
      if [ "\${skip_tests}" != "true" ]; then npm test --silent; fi

  - name: Build & Push
    runner: codebuild
    codebuild:
      project: my-image-builder
      env:
        BRANCH: "\${branch}"
        ENV: "\${env}"

  - name: Deploy
    run: ./deploy.sh --env \${env}`}</Block>

          {/* ---------- USING THE APP ---------- */}
          <H2 id="ui-pipelines">
            <LayoutDashboard className="inline h-5 w-5 text-violet-400 mr-2 -mt-0.5" />
            Pipelines Page
          </H2>
          <P>
            <Code>Pipelines</Code> in the sidebar is the launchpad. Every YAML file in{" "}
            <Code>pipelines/</Code> shows up here; the most recently modified pipeline
            sits at the top.
          </P>
          <UL>
            <li>
              <Search className="inline h-3.5 w-3.5 text-zinc-400 -mt-0.5" /> The
              search box filters by name <em>and</em> description as you type.
            </li>
            <li>
              The view toggle in the header switches between a compact list (the
              default) and a card grid.
            </li>
            <li>
              <strong className="text-zinc-200">New Pipeline</strong> opens an in-app
              YAML editor — the same content rules described above apply.
            </li>
            <li>
              <Download className="inline h-3.5 w-3.5 text-zinc-400 -mt-0.5" />{" "}
              <strong className="text-zinc-200">Export</strong> in the header
              downloads every pipeline YAML as a single{" "}
              <Code>pipelines-&lt;timestamp&gt;.zip</Code> for backup or moving to
              another instance — disabled when there are no pipelines.
            </li>
            <li>Click any row to open its Run page.</li>
          </UL>

          <H2 id="ui-run">
            <Play className="inline h-5 w-5 text-violet-400 mr-2 -mt-0.5" />
            Running a Pipeline
          </H2>
          <P>
            The Run page has two halves. Left is a form generated from the YAML's{" "}
            <Code>parameters</Code>; right is a live step tracker.
          </P>
          <H3>Filling in the form</H3>
          <UL>
            <li>Required fields are marked with an asterisk and disable the Run button until they're filled.</li>
            <li>Dropdowns marked with a spinner are loading remote data (e.g. git branches) — wait for them to settle, or pick from the fallback options.</li>
            <li>Checkboxes interpolate as the literal strings <Code>"true"</Code> or <Code>"false"</Code>.</li>
            <li>Password fields are masked; their values are still substituted into <Code>{"${id}"}</Code> like any other parameter.</li>
          </UL>
          <H3>While it's running</H3>
          <UL>
            <li>Each step appears in the right panel, expanding to show stdout/stderr as it runs.</li>
            <li>Output is colour-coded: cyan = step header, green = stdout, amber = stderr/info, red = errors, grey = exit. Common error patterns are highlighted automatically.</li>
            <li>Closing the tab does <em>not</em> stop the run — re-open it from <Code>Active Runs</Code> or <Code>Run History</Code>.</li>
            <li>Use <strong className="text-zinc-200">Edit</strong> in the header to modify the YAML in place; <strong className="text-zinc-200">Delete</strong> removes the pipeline file (no active runs allowed).</li>
          </UL>

          <H2 id="ui-active">
            <Activity className="inline h-5 w-5 text-violet-400 mr-2 -mt-0.5" />
            Active Runs
          </H2>
          <P>
            <Code>/active</Code> shows everything currently running across the
            instance — yours and (if you're admin) everyone else's. The page polls
            every 3 seconds, the elapsed timer ticks every second, and the sidebar
            badge mirrors the count.
          </P>
          <UL>
            <li>Click a row to re-attach to its live log stream — the server replays the full backlog before streaming new output.</li>
            <li>
              <StopCircle className="inline h-3.5 w-3.5 text-red-400 -mt-0.5" />{" "}
              <strong className="text-zinc-200">Stop</strong> requests cancellation;
              the runner gets a SIGTERM and is reaped after a short grace period.
            </li>
          </UL>

          <H2 id="ui-history">
            <History className="inline h-5 w-5 text-violet-400 mr-2 -mt-0.5" />
            Run History & Logs
          </H2>
          <P>
            <Code>/runs</Code> lists every completed run, newest first, paginated 25
            at a time. Filter by pipeline, ID, or status; click any row to open its
            saved logs.
          </P>
          <UL>
            <li>
              <Trash2 className="inline h-3.5 w-3.5 text-red-400 -mt-0.5" />{" "}
              Per-row delete removes a single record; <strong className="text-zinc-200">Clear All</strong> in the header wipes everything you can see.
            </li>
            <li>Logs for a finished run are stored in the database and served from a small LRU cache on subsequent opens.</li>
            <li>If a run failed, the failure summary banner pins the last useful lines plus the step name to the top of the page.</li>
          </UL>

          <H2 id="ui-scripts">
            <TerminalIcon className="inline h-5 w-5 text-violet-400 mr-2 -mt-0.5" />
            Scripts
          </H2>
          <P>
            <Code>/scripts</Code> manages reusable shell scripts. Same list ordering
            rules — newest at the top.
          </P>
          <UL>
            <li><strong className="text-zinc-200">New Script</strong> opens an editor; save and it's instantly available inside every pipeline runner at <Code>/app/user-scripts/&lt;id&gt;.sh</Code>.</li>
            <li><strong className="text-zinc-200">Run</strong> executes the script standalone with a live log view — handy for one-offs.</li>
            <li><strong className="text-zinc-200">Edit / Delete</strong> behaves like the YAML editor.</li>
            <li>
              <Download className="inline h-3.5 w-3.5 text-zinc-400 -mt-0.5" />{" "}
              <strong className="text-zinc-200">Export</strong> in the header
              downloads every script as a single{" "}
              <Code>scripts-&lt;timestamp&gt;.zip</Code> for backup or moving to
              another instance.
            </li>
          </UL>

          <H2 id="ui-terminal">
            <TerminalSquare className="inline h-5 w-5 text-violet-400 mr-2 -mt-0.5" />
            Terminal
          </H2>
          <P>
            <Code>/terminal</Code> opens an interactive shell session inside a
            transient runner container — the same image pipelines use. Useful for
            quick diagnostics, manual <Code>aws</Code>/<Code>kubectl</Code>{" "}
            commands, or sanity-checking the cached repo at{" "}
            <Code>/tmp/codeci-deploy</Code> before you wire something into a pipeline.
          </P>
          <Note>
            The session ends when you leave the page; nothing in the container's
            local filesystem persists.
          </Note>

          <H2 id="ui-notifications">
            <Bell className="inline h-5 w-5 text-violet-400 mr-2 -mt-0.5" />
            Notifications
          </H2>
          <P>
            The bell next to the app name pops up a dropdown of recent run
            completions. The poll that drives the active-runs badge also detects{" "}
            <Code>running → done</Code> transitions and creates a notification once
            per run with a click-through to its log page.
          </P>

          <H2 id="ui-profile">
            <UserIcon className="inline h-5 w-5 text-violet-400 mr-2 -mt-0.5" />
            Profile & TOTP
          </H2>
          <P>
            Click your avatar in the bottom-left to open <Code>/profile</Code>:
          </P>
          <UL>
            <li>Change your password (local users only — Entra users manage credentials in Microsoft).</li>
            <li>Enable or disable TOTP. Disabling clears the stored secret; you'll be asked to re-enrol on next login.</li>
            <li>See your current role (User / Administrator) and authentication provider.</li>
          </UL>

          <H2 id="ui-settings">
            <SettingsIcon className="inline h-5 w-5 text-violet-400 mr-2 -mt-0.5" />
            Admin Settings
          </H2>
          <P>
            Visible only to administrators. Use it to:
          </P>
          <UL>
            <li>Rename the application — the new name appears in the sidebar header and browser tab title.</li>
            <li>Tune the runner timeout (1–1440 minutes).</li>
            <li>Configure Microsoft Entra ID SSO (tenant ID, client ID, redirect URL, client secret). The client secret uses a "Replace" button so the existing value is never echoed back.</li>
            <li>Create, edit, and delete users. <Code>auth_provider</Code> is fixed at creation — to switch a user between local and Entra, delete and recreate.</li>
          </UL>

          <H2 id="ui-tips">Tips & Shortcuts</H2>
          <P>A few things worth knowing as you settle in:</P>
          <div className="space-y-1.5 mb-4">
            <NavRowDemo Icon={LayoutDashboard} label="Pipelines" hint="Newest YAML on top — the file mtime drives the order" />
            <NavRowDemo Icon={TerminalIcon} label="Scripts" hint="Mounted at /app/user-scripts/<id>.sh inside every runner" />
            <NavRowDemo Icon={Activity} label="Active Runs" hint="Re-attach by clicking; full backlog replays before live stream" />
            <NavRowDemo Icon={History} label="Run History" hint="Paginated; logs cached after the first open" />
            <NavRowDemo Icon={TerminalSquare} label="Terminal" hint="Throwaway shell — leaves no trace when you close the tab" />
          </div>
          <UL>
            <li>The sidebar's Active Runs badge is a global counter — handy for spotting forgotten runs.</li>
            <li>Search is client-side and instant — there's no Enter key to press.</li>
            <li>Pipeline edits are hot-reloaded — save the YAML and refresh; no server restart.</li>
            <li>Run logs survive a server restart (5-second flush + final write), so a deploy mid-run still leaves the trail intact.</li>
          </UL>

          <div className="mt-12 mb-2 flex items-center gap-2 text-xs text-zinc-500">
            <ChevronRight className="h-3 w-3" />
            <span>End of documentation. Edit it at <Code>web/src/pages/Documentation.tsx</Code>.</span>
          </div>
        </div>
      </div>
    </Layout>
  );
}
