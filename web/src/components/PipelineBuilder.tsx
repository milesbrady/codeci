import { useMemo, useRef, useState } from "react";
import yaml from "js-yaml";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Hash,
  KeyRound,
  ListChecks,
  Plus,
  Sparkles,
  Terminal,
  ToggleLeft,
  Trash2,
  Type as TypeIcon,
  Wand2,
  Cloud,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type ParamType = "text" | "select" | "checkbox" | "password";
type Runner = "docker" | "codebuild";

interface BuilderOption {
  label: string;
  value: string;
}

interface BuilderParameter {
  _key: string;
  id: string;
  label: string;
  type: ParamType;
  required: boolean;
  readonly: boolean;
  default: string | boolean;
  placeholder: string;
  options: BuilderOption[];
  source: string;
}

interface BuilderEnvVar {
  _key: string;
  key: string;
  value: string;
}

interface BuilderCodeBuild {
  project: string;
  source_version: string;
  env: BuilderEnvVar[];
  buildspec_override: string;
  timeout_minutes: number | "";
}

interface BuilderStep {
  _key: string;
  name: string;
  runner: Runner;
  run: string;
  codebuild: BuilderCodeBuild;
  // Substep-tree controls. Both apply only to Docker (shell) steps; CodeBuild
  // steps don't use the substep planner.
  //   substepsEnabled = true (default) emits the substep tree.
  //   substepsEnabled = false skips planning entirely.
  // substepDepth overrides the planner's default depth cap when set.
  // Empty string means "use default"; numbers ≤0 or > MaxAllowedPlanDepth
  // are corrected by the backend.
  substepsEnabled: boolean;
  substepDepth: number | "";
}

export interface BuilderState {
  name: string;
  description: string;
  version: string;
  repository: string;
  // maxConcurrentRuns caps how many copies of this pipeline can run at the
  // same time. Additional submissions queue FIFO. Stored as a number (>=1);
  // the empty-string sentinel keeps the input controlled while the user
  // clears it before retyping.
  maxConcurrentRuns: number | "";
  // queueStrategy controls how the queue behaves when the limit is hit.
  //   - "fifo" (default): submissions execute in order.
  //   - "replace": only the newest submission stays queued. Constrained to
  //     maxConcurrentRuns === 1 — the UI disables it otherwise.
  queueStrategy: "fifo" | "replace";
  parameters: BuilderParameter[];
  steps: BuilderStep[];
}

let keyCounter = 0;
const nextKey = (prefix: string) => `${prefix}_${++keyCounter}_${Date.now().toString(36)}`;

const emptyCodeBuild = (): BuilderCodeBuild => ({
  project: "",
  source_version: "",
  env: [],
  buildspec_override: "",
  timeout_minutes: "",
});

const blankParameter = (overrides: Partial<BuilderParameter> = {}): BuilderParameter => ({
  _key: nextKey("p"),
  id: "",
  label: "",
  type: "text",
  required: false,
  readonly: false,
  default: "",
  placeholder: "",
  options: [],
  source: "",
  ...overrides,
});

const blankStep = (overrides: Partial<BuilderStep> = {}): BuilderStep => ({
  _key: nextKey("s"),
  name: "",
  runner: "docker",
  run: "",
  codebuild: emptyCodeBuild(),
  substepsEnabled: true,
  substepDepth: "",
  ...overrides,
});

export const blankBuilderState = (): BuilderState => ({
  name: "",
  description: "",
  version: "1.0",
  repository: "",
  maxConcurrentRuns: 1,
  queueStrategy: "fifo",
  parameters: [],
  steps: [],
});

// ─── YAML <-> Builder ─────────────────────────────────────────────────────────
function slugifyId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function builderToYaml(state: BuilderState): string {
  const out: any = {
    name: state.name || "",
    description: state.description || "",
    version: state.version || "1.0",
  };

  if (state.repository && state.repository.trim()) {
    out.repository = state.repository.trim();
  }

  // Only emit max_concurrent_runs when it diverges from the default (1) so
  // unchanged pipelines keep a clean YAML.
  const maxRuns = typeof state.maxConcurrentRuns === "number" ? state.maxConcurrentRuns : Number(state.maxConcurrentRuns);
  if (Number.isFinite(maxRuns) && maxRuns > 1) {
    out.max_concurrent_runs = maxRuns;
  }

  // queue_strategy only needs to appear in YAML when it's non-default.
  // "replace" requires max_concurrent_runs: 1 (backend enforces this too).
  if (state.queueStrategy === "replace" && (!Number.isFinite(maxRuns) || maxRuns === 1)) {
    out.queue_strategy = "replace";
  }

  if (state.parameters.length > 0) {
    out.parameters = state.parameters.map((p) => {
      const o: any = {
        id: p.id,
        label: p.label,
        type: p.type,
        required: !!p.required,
      };
      if (p.readonly) o.readonly = true;
      if (p.placeholder) o.placeholder = p.placeholder;
      if (p.type === "checkbox") {
        o.default = p.default === true || p.default === "true";
      } else if (p.default !== "" && p.default !== undefined && p.default !== null) {
        o.default = p.default;
      }
      if (p.type === "select") {
        o.options = (p.options || []).map((opt) => ({
          label: opt.label || opt.value,
          value: opt.value,
        }));
        if (p.source) o.source = p.source;
      }
      return o;
    });
  }

  if (state.steps.length > 0) {
    out.steps = state.steps.map((s) => {
      const step: any = { name: s.name };
      if (s.runner === "codebuild") {
        step.runner = "codebuild";
        const cb: any = { project: s.codebuild.project };
        if (s.codebuild.source_version) cb.source_version = s.codebuild.source_version;
        if (s.codebuild.env.length > 0) {
          cb.env = {};
          for (const e of s.codebuild.env) {
            if (e.key.trim()) cb.env[e.key] = e.value;
          }
          if (Object.keys(cb.env).length === 0) delete cb.env;
        }
        if (s.codebuild.buildspec_override) cb.buildspec_override = s.codebuild.buildspec_override;
        if (s.codebuild.timeout_minutes !== "" && Number(s.codebuild.timeout_minutes) > 0) {
          cb.timeout_minutes = Number(s.codebuild.timeout_minutes);
        }
        step.codebuild = cb;
      } else {
        step.run = s.run;
        // Substep controls only apply to Docker steps. Omit when at default
        // values so the YAML stays clean.
        if (s.substepsEnabled === false) {
          step.substeps = false;
        }
        if (s.substepDepth !== "" && Number(s.substepDepth) > 0) {
          step.substep_depth = Number(s.substepDepth);
        }
      }
      return step;
    });
  }

  return yaml.dump(out, { lineWidth: 120, noRefs: true, indent: 2, quotingType: '"' });
}

export function yamlToBuilder(text: string): BuilderState {
  let parsed: any;
  try {
    parsed = yaml.load(text || "") || {};
  } catch {
    return blankBuilderState();
  }
  if (typeof parsed !== "object" || parsed === null) return blankBuilderState();

  const params: BuilderParameter[] = Array.isArray(parsed.parameters)
    ? parsed.parameters.map((p: any) => {
        const type: ParamType = ["text", "select", "checkbox", "password"].includes(p?.type)
          ? p.type
          : "text";
        const opts: BuilderOption[] = Array.isArray(p?.options)
          ? p.options.map((o: any) => ({
              label: String(o?.label ?? o?.value ?? ""),
              value: String(o?.value ?? ""),
            }))
          : [];
        let def: string | boolean = "";
        if (type === "checkbox") def = !!p?.default;
        else if (p?.default !== undefined && p?.default !== null) def = String(p.default);
        return blankParameter({
          id: String(p?.id ?? ""),
          label: String(p?.label ?? ""),
          type,
          required: !!p?.required,
          readonly: !!p?.readonly,
          default: def,
          placeholder: String(p?.placeholder ?? ""),
          options: opts,
          source: String(p?.source ?? ""),
        });
      })
    : [];

  const steps: BuilderStep[] = Array.isArray(parsed.steps)
    ? parsed.steps.map((s: any) => {
        const runner: Runner = s?.runner === "codebuild" || s?.codebuild ? "codebuild" : "docker";
        const cb = s?.codebuild ?? {};
        const envEntries: BuilderEnvVar[] = cb && typeof cb.env === "object" && cb.env
          ? Object.entries(cb.env).map(([k, v]) => ({
              _key: nextKey("e"),
              key: String(k),
              value: String(v ?? ""),
            }))
          : [];
        return blankStep({
          name: String(s?.name ?? ""),
          runner,
          run: String(s?.run ?? ""),
          codebuild: {
            project: String(cb?.project ?? ""),
            source_version: String(cb?.source_version ?? ""),
            env: envEntries,
            buildspec_override: String(cb?.buildspec_override ?? ""),
            timeout_minutes:
              cb?.timeout_minutes && Number(cb.timeout_minutes) > 0
                ? Number(cb.timeout_minutes)
                : "",
          },
          // Backend treats omitted as enabled — only explicit false disables.
          substepsEnabled: s?.substeps === false ? false : true,
          substepDepth:
            s?.substep_depth && Number(s.substep_depth) > 0
              ? Number(s.substep_depth)
              : "",
        });
      })
    : [];

  const parsedMax = Number(parsed.max_concurrent_runs);
  const maxConcurrentRuns: number = Number.isFinite(parsedMax) && parsedMax >= 1 ? Math.floor(parsedMax) : 1;

  // queue_strategy is "fifo" unless the YAML explicitly says "replace".
  // The "replace" combination is only valid with max=1; if the YAML pairs
  // it with max>1 we silently downgrade to "fifo" in the builder so the
  // user can fix the conflict via the UI without it being rejected on save.
  const rawStrategy = typeof parsed.queue_strategy === "string" ? parsed.queue_strategy.toLowerCase() : "";
  const queueStrategy: "fifo" | "replace" =
    rawStrategy === "replace" && maxConcurrentRuns === 1 ? "replace" : "fifo";

  return {
    name: String(parsed.name ?? ""),
    description: String(parsed.description ?? ""),
    version: String(parsed.version ?? "1.0"),
    repository: String(parsed.repository ?? ""),
    maxConcurrentRuns,
    queueStrategy,
    parameters: params,
    steps: steps,
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────
export interface BuilderIssue {
  level: "error" | "warn";
  message: string;
}

export function validateBuilder(state: BuilderState): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  if (!state.name.trim()) issues.push({ level: "error", message: "Pipeline needs a name." });

  const seen = new Set<string>();
  for (let i = 0; i < state.parameters.length; i++) {
    const p = state.parameters[i];
    if (!p.id.trim()) {
      issues.push({ level: "error", message: `Parameter #${i + 1} is missing an id.` });
      continue;
    }
    if (!/^[a-z][a-z0-9_]*$/i.test(p.id)) {
      issues.push({
        level: "error",
        message: `Parameter "${p.id}" id must start with a letter and contain only letters, digits, and underscores.`,
      });
    }
    if (seen.has(p.id)) {
      issues.push({ level: "error", message: `Duplicate parameter id "${p.id}".` });
    }
    seen.add(p.id);
    if (p.type === "select" && p.options.length === 0 && !p.source) {
      issues.push({
        level: "warn",
        message: `Select parameter "${p.id}" has no options and no source.`,
      });
    }
  }

  if (state.steps.length === 0) {
    issues.push({ level: "warn", message: "Pipeline has no steps yet." });
  }
  for (let i = 0; i < state.steps.length; i++) {
    const s = state.steps[i];
    if (!s.name.trim()) {
      issues.push({ level: "error", message: `Step #${i + 1} is missing a name.` });
    }
    if (s.runner === "docker" && !s.run.trim()) {
      issues.push({ level: "error", message: `Step "${s.name || i + 1}" has no shell command.` });
    }
    if (s.runner === "codebuild" && !s.codebuild.project.trim()) {
      issues.push({
        level: "error",
        message: `CodeBuild step "${s.name || i + 1}" needs a project name.`,
      });
    }

    // Highlight unknown ${param} refs
    const refs = collectParamRefs(
      s.runner === "docker"
        ? s.run
        : `${s.codebuild.source_version} ${s.codebuild.buildspec_override} ${s.codebuild.env
            .map((e) => `${e.key}=${e.value}`)
            .join(" ")}`,
    );
    for (const r of refs) {
      if (!seen.has(r)) {
        issues.push({
          level: "warn",
          message: `Step "${s.name || i + 1}" references \${${r}}, but no parameter has that id.`,
        });
      }
    }
  }
  return issues;
}

function collectParamRefs(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\$\{([a-z][a-z0-9_]*)\}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

// ─── Templates ────────────────────────────────────────────────────────────────
const TEMPLATES: { key: string; name: string; description: string; icon: any; build: () => BuilderState }[] = [
  {
    key: "blank",
    name: "Blank",
    description: "Start from scratch.",
    icon: Sparkles,
    build: blankBuilderState,
  },
  {
    key: "hello",
    name: "Hello world",
    description: "A simple two-step pipeline.",
    icon: Terminal,
    build: () => ({
      ...blankBuilderState(),
      name: "Hello World",
      description: "A simple example pipeline.",
      version: "1.0",
      parameters: [
        blankParameter({
          id: "your_name",
          label: "Your name",
          type: "text",
          required: true,
          default: "world",
          placeholder: "world",
        }),
      ],
      steps: [
        blankStep({ name: "Greet", run: 'echo "Hello, ${your_name}!"' }),
        blankStep({ name: "Goodbye", run: 'echo "See you later, ${your_name}."' }),
      ],
    }),
  },
  {
    key: "git",
    name: "Git deploy",
    description: "Clone a repo and run a deploy script.",
    icon: GitBranch,
    build: () => ({
      ...blankBuilderState(),
      name: "Deploy from Git",
      description: "Clone a branch and execute a deploy script.",
      version: "1.0",
      repository: "https://github.com/org/repo",
      parameters: [],
      steps: [
        blankStep({ name: "Deploy", run: "cd /tmp/codeci-deploy && ./deploy.sh" }),
      ],
    }),
  },
  {
    key: "codebuild",
    name: "AWS CodeBuild",
    description: "Trigger a CodeBuild project.",
    icon: Cloud,
    build: () => ({
      ...blankBuilderState(),
      name: "Build via CodeBuild",
      description: "Run an existing AWS CodeBuild project.",
      version: "1.0",
      parameters: [
        blankParameter({
          id: "image_tag",
          label: "Image tag",
          type: "text",
          required: true,
          default: "latest",
        }),
      ],
      steps: [
        blankStep({
          name: "Build images",
          runner: "codebuild",
          codebuild: {
            project: "my-image-builder",
            source_version: "",
            buildspec_override: "",
            timeout_minutes: 30,
            env: [{ _key: nextKey("e"), key: "IMAGE_TAG", value: "${image_tag}" }],
          },
        }),
      ],
    }),
  },
];

// ─── UI helpers ───────────────────────────────────────────────────────────────
const TYPE_META: Record<ParamType, { icon: any; label: string; chip: string }> = {
  text: { icon: TypeIcon, label: "Text", chip: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
  select: { icon: ListChecks, label: "Select", chip: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  checkbox: { icon: ToggleLeft, label: "Checkbox", chip: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  password: { icon: KeyRound, label: "Password", chip: "bg-rose-500/15 text-rose-300 border-rose-500/30" },
};

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
      {children}
      {hint && <span className="text-zinc-600 normal-case font-normal text-[11px]">— {hint}</span>}
    </label>
  );
}

function SectionCard({
  title,
  subtitle,
  icon: Icon,
  action,
  children,
  accent,
}: {
  title: string;
  subtitle?: string;
  icon: any;
  action?: React.ReactNode;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center", accent || "bg-violet-500/15 text-violet-300")}>
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
            {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
          </div>
        </div>
        {action}
      </header>
      <div className="p-5 space-y-4">{children}</div>
    </section>
  );
}

// Tiny chip used for inserting ${param_id} into shell editors.
function ParamChip({ id, onClick }: { id: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-zinc-800/80 hover:bg-violet-600/20 hover:text-violet-200 text-zinc-300 border border-zinc-700 hover:border-violet-500/40 transition-colors"
      title={`Insert \${${id}}`}
    >
      <span className="text-violet-400">${"{"}</span>
      {id}
      <span className="text-violet-400">{"}"}</span>
    </button>
  );
}

// ─── Parameter card ───────────────────────────────────────────────────────────
function ParameterCard({
  index,
  total,
  param,
  onChange,
  onRemove,
  onMove,
  otherParamIds,
  duplicate,
  defaultExpanded = true,
}: {
  index: number;
  total: number;
  param: BuilderParameter;
  onChange: (next: BuilderParameter) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  otherParamIds: string[];
  duplicate: boolean;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const meta = TYPE_META[param.type];
  const Icon = meta.icon;

  const update = (patch: Partial<BuilderParameter>) => onChange({ ...param, ...patch });

  return (
    <div
      className={cn(
        "rounded-lg border bg-zinc-900/60 transition-colors",
        duplicate ? "border-red-500/50" : "border-zinc-800",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/70">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-zinc-500 hover:text-zinc-200 transition-colors"
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className={cn("h-6 w-6 rounded flex items-center justify-center", meta.chip)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-sm text-zinc-100 truncate">{param.label || param.id || `Parameter ${index + 1}`}</span>
          {param.id && (
            <code className="text-[11px] text-violet-300/80 font-mono">${"{"}{param.id}{"}"}</code>
          )}
          {param.required && (
            <span className="text-[10px] text-rose-300/80 uppercase">required</span>
          )}
        </div>
        <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", meta.chip)}>{meta.label}</span>
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          className="text-zinc-500 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed"
          title="Move up"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          className="text-zinc-500 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed"
          title="Move down"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="text-zinc-500 hover:text-red-400 transition-colors"
          title="Remove parameter"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>

      {expanded && (
        <div className="p-4 grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <FieldLabel hint="shown to the user">Label</FieldLabel>
            <Input
              value={param.label}
              placeholder="e.g. Git Branch"
              onChange={(e) => {
                const label = e.target.value;
                const autoId = !param.id || param.id === slugifyId(param.label);
                update(autoId ? { label, id: slugifyId(label) } : { label });
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel hint="used as ${id} in steps">ID</FieldLabel>
            <div className="relative">
              <Hash className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
              <Input
                className={cn("pl-8 font-mono", duplicate && "border-red-500/50 focus:ring-red-500")}
                value={param.id}
                placeholder="git_branch"
                onChange={(e) => update({ id: e.target.value.replace(/\s+/g, "_") })}
              />
            </div>
            {duplicate && <span className="text-[11px] text-red-400">Duplicate id — must be unique.</span>}
          </div>

          <div className="flex flex-col gap-1.5">
            <FieldLabel>Type</FieldLabel>
            <div className="grid grid-cols-4 gap-1.5">
              {(Object.keys(TYPE_META) as ParamType[]).map((t) => {
                const M = TYPE_META[t];
                const TIcon = M.icon;
                const active = param.type === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => update({ type: t, default: t === "checkbox" ? false : "" })}
                    className={cn(
                      "flex flex-col items-center justify-center gap-1 py-2 rounded-md border text-[11px] transition-colors",
                      active
                        ? "border-violet-500/60 bg-violet-500/10 text-violet-200"
                        : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
                    )}
                  >
                    <TIcon className="h-3.5 w-3.5" />
                    {M.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <FieldLabel>Default value</FieldLabel>
            {param.type === "checkbox" ? (
              <button
                type="button"
                onClick={() => update({ default: !(param.default === true || param.default === "true") })}
                className={cn(
                  "h-10 rounded-md border px-3 text-sm flex items-center gap-2",
                  param.default === true || param.default === "true"
                    ? "border-violet-500/60 bg-violet-500/10 text-violet-200"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300",
                )}
              >
                <span
                  className={cn(
                    "h-4 w-4 rounded border flex items-center justify-center",
                    param.default === true || param.default === "true"
                      ? "bg-violet-500 border-violet-400"
                      : "border-zinc-600",
                  )}
                >
                  {(param.default === true || param.default === "true") && <CheckCircle2 className="h-3 w-3 text-white" />}
                </span>
                {param.default === true || param.default === "true" ? "Checked by default" : "Unchecked by default"}
              </button>
            ) : (
              <Input
                value={String(param.default ?? "")}
                placeholder="(optional)"
                onChange={(e) => update({ default: e.target.value })}
              />
            )}
          </div>

          {(param.type === "text" || param.type === "password") && (
            <div className="flex flex-col gap-1.5 col-span-2">
              <FieldLabel hint="hint shown when empty">Placeholder</FieldLabel>
              <Input
                value={param.placeholder}
                onChange={(e) => update({ placeholder: e.target.value })}
                placeholder="e.g. https://github.com/org/repo"
              />
            </div>
          )}

          {param.type === "select" && (
            <div className="col-span-2 space-y-3">
              <div className="flex flex-col gap-1.5">
                <FieldLabel hint="auto-fill from another parameter">Source</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => update({ source: "" })}
                    className={cn(
                      "px-2.5 py-1 rounded-md text-xs border transition-colors",
                      !param.source
                        ? "border-violet-500/60 bg-violet-500/10 text-violet-200"
                        : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700",
                    )}
                  >
                    Static options
                  </button>
                  {otherParamIds.map((pid) => {
                    const tag = `git-branches:${pid}`;
                    return (
                      <button
                        key={pid}
                        type="button"
                        onClick={() => update({ source: tag })}
                        className={cn(
                          "px-2.5 py-1 rounded-md text-xs border transition-colors flex items-center gap-1.5",
                          param.source === tag
                            ? "border-violet-500/60 bg-violet-500/10 text-violet-200"
                            : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700",
                        )}
                      >
                        <GitBranch className="h-3 w-3" />
                        git-branches from <code className="font-mono">{pid}</code>
                      </button>
                    );
                  })}
                </div>
                {param.source && (
                  <p className="text-[11px] text-zinc-500">
                    Options will be fetched from the git repo URL in <code className="text-violet-300/80">{param.source.split(":")[1]}</code> at run time.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <FieldLabel hint={param.source ? "fallback when source can't load" : "values shown in the dropdown"}>
                    Options
                  </FieldLabel>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      update({
                        options: [...param.options, { label: "", value: "" }],
                      })
                    }
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add option
                  </Button>
                </div>
                {param.options.length === 0 && (
                  <p className="text-xs text-zinc-500 italic">No options yet.</p>
                )}
                {param.options.map((opt, oi) => (
                  <div key={oi} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                    <Input
                      value={opt.label}
                      placeholder="Label (shown to user)"
                      onChange={(e) => {
                        const next = [...param.options];
                        next[oi] = { ...opt, label: e.target.value };
                        update({ options: next });
                      }}
                    />
                    <Input
                      value={opt.value}
                      placeholder="Value (passed to step)"
                      className="font-mono"
                      onChange={(e) => {
                        const next = [...param.options];
                        next[oi] = { ...opt, value: e.target.value };
                        update({ options: next });
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = [...param.options];
                        next.splice(oi, 1);
                        update({ options: next });
                      }}
                      className="text-zinc-500 hover:text-red-400 px-2"
                      title="Remove option"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="col-span-2 flex flex-wrap gap-4 pt-2 border-t border-zinc-800/60">
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={param.required}
                onChange={(e) => update({ required: e.target.checked })}
                className="accent-violet-600"
              />
              Required
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={param.readonly}
                onChange={(e) => update({ readonly: e.target.checked })}
                className="accent-violet-600"
              />
              Read-only (locked at the default)
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Step card ────────────────────────────────────────────────────────────────
function StepCard({
  index,
  total,
  step,
  onChange,
  onRemove,
  onMove,
  paramIds,
  defaultExpanded = true,
}: {
  index: number;
  total: number;
  step: BuilderStep;
  onChange: (next: BuilderStep) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  paramIds: string[];
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const runRef = useRef<HTMLTextAreaElement | null>(null);
  const update = (patch: Partial<BuilderStep>) => onChange({ ...step, ...patch });

  function insertParamRef(pid: string) {
    if (step.runner === "codebuild") return;
    const ta = runRef.current;
    const token = `\${${pid}}`;
    if (!ta) {
      update({ run: (step.run || "") + token });
      return;
    }
    const start = ta.selectionStart ?? step.run.length;
    const end = ta.selectionEnd ?? step.run.length;
    const next = step.run.slice(0, start) + token + step.run.slice(end);
    update({ run: next });
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/70">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-zinc-500 hover:text-zinc-200 transition-colors"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className="h-6 w-6 rounded bg-violet-500/15 text-violet-300 text-[11px] font-semibold flex items-center justify-center">
          {index + 1}
        </span>
        <input
          value={step.name}
          placeholder={`Step ${index + 1}`}
          onChange={(e) => update({ name: e.target.value })}
          className="flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
        />
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded border",
            step.runner === "codebuild"
              ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
              : "bg-sky-500/15 text-sky-300 border-sky-500/30",
          )}
        >
          {step.runner === "codebuild" ? "CodeBuild" : "Docker"}
        </span>
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          className="text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
          title="Move up"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          className="text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
          title="Move down"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="text-zinc-500 hover:text-red-400"
          title="Remove step"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>

      {expanded && (
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <FieldLabel>Runner</FieldLabel>
            <div className="flex items-center rounded-md border border-zinc-800 overflow-hidden">
              <button
                type="button"
                onClick={() => update({ runner: "docker" })}
                className={cn(
                  "px-3 py-1.5 text-xs flex items-center gap-1.5 transition-colors",
                  step.runner === "docker"
                    ? "bg-sky-500/20 text-sky-200"
                    : "text-zinc-400 hover:bg-zinc-800",
                )}
              >
                <Terminal className="h-3.5 w-3.5" /> Docker (shell)
              </button>
              <button
                type="button"
                onClick={() => update({ runner: "codebuild" })}
                className={cn(
                  "px-3 py-1.5 text-xs flex items-center gap-1.5 transition-colors",
                  step.runner === "codebuild"
                    ? "bg-amber-500/20 text-amber-200"
                    : "text-zinc-400 hover:bg-zinc-800",
                )}
              >
                <Cloud className="h-3.5 w-3.5" /> AWS CodeBuild
              </button>
            </div>
          </div>

          {step.runner === "docker" ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <FieldLabel hint="bash inside the runner container">Shell command</FieldLabel>
                {paramIds.length > 0 && (
                  <span className="text-[11px] text-zinc-500">Click a chip to insert at cursor:</span>
                )}
              </div>
              {paramIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {paramIds.map((pid) => (
                    <ParamChip key={pid} id={pid} onClick={() => insertParamRef(pid)} />
                  ))}
                </div>
              )}
              <textarea
                ref={runRef}
                value={step.run}
                onChange={(e) => update({ run: e.target.value })}
                rows={Math.max(6, Math.min(20, step.run.split("\n").length + 1))}
                spellCheck={false}
                className="w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500"
                placeholder={`echo "Hello, \${name}"`}
              />

              <div className="pt-3 mt-2 border-t border-zinc-800/70 space-y-3">
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Substep tracking
                </div>

                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={step.substepsEnabled}
                    onChange={(e) =>
                      update({
                        substepsEnabled: e.target.checked,
                        // Wipe an unused depth override when disabling — keeps
                        // the YAML clean and avoids the contradictory combo.
                        substepDepth: e.target.checked ? step.substepDepth : "",
                      })
                    }
                    className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-violet-500 focus:ring-violet-500"
                  />
                  <span className="text-sm text-zinc-200 leading-tight">
                    Show substep progress
                    <span className="block text-[11px] text-zinc-500 mt-0.5">
                      Surface individual commands and nested function calls as a live progress tree.
                      Turn off for noisy or sensitive steps.
                    </span>
                  </span>
                </label>

                <div
                  className={cn(
                    "flex items-center gap-3 transition-opacity",
                    step.substepsEnabled ? "opacity-100" : "opacity-40 pointer-events-none",
                  )}
                >
                  <FieldLabel hint="0 = use default (2)">Substep depth</FieldLabel>
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    value={step.substepDepth === "" ? "" : String(step.substepDepth)}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") {
                        update({ substepDepth: "" });
                      } else {
                        const n = Number(v);
                        update({ substepDepth: Number.isFinite(n) && n > 0 ? n : "" });
                      }
                    }}
                    placeholder="default"
                    className="w-24 font-mono"
                  />
                  <span className="text-[11px] text-zinc-500 leading-tight">
                    Higher values unfold more nested calls into the progress tree
                    (max 10).
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5 col-span-2">
                <FieldLabel hint="must already exist in AWS">CodeBuild project</FieldLabel>
                <Input
                  value={step.codebuild.project}
                  onChange={(e) =>
                    update({ codebuild: { ...step.codebuild, project: e.target.value } })
                  }
                  placeholder="my-image-builder"
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel hint="branch, tag, or commit — supports ${param} refs">Branch / Git ref</FieldLabel>
                <Input
                  value={step.codebuild.source_version}
                  onChange={(e) =>
                    update({ codebuild: { ...step.codebuild, source_version: e.target.value } })
                  }
                  placeholder="${git_branch}"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel hint="minutes">Timeout</FieldLabel>
                <Input
                  type="number"
                  value={step.codebuild.timeout_minutes}
                  onChange={(e) =>
                    update({
                      codebuild: {
                        ...step.codebuild,
                        timeout_minutes: e.target.value === "" ? "" : Number(e.target.value),
                      },
                    })
                  }
                  placeholder="30"
                />
              </div>
              <div className="col-span-2 space-y-2">
                <div className="flex items-center justify-between">
                  <FieldLabel hint="passed via EnvironmentVariablesOverride">Environment variables</FieldLabel>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      update({
                        codebuild: {
                          ...step.codebuild,
                          env: [...step.codebuild.env, { _key: nextKey("e"), key: "", value: "" }],
                        },
                      })
                    }
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add variable
                  </Button>
                </div>
                {step.codebuild.env.length === 0 && (
                  <p className="text-xs text-zinc-500 italic">No env vars set.</p>
                )}
                {step.codebuild.env.map((env, ei) => (
                  <div key={env._key} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                    <Input
                      value={env.key}
                      placeholder="VAR_NAME"
                      className="font-mono"
                      onChange={(e) => {
                        const next = [...step.codebuild.env];
                        next[ei] = { ...env, key: e.target.value };
                        update({ codebuild: { ...step.codebuild, env: next } });
                      }}
                    />
                    <Input
                      value={env.value}
                      placeholder='value (use ${param_id})'
                      className="font-mono"
                      onChange={(e) => {
                        const next = [...step.codebuild.env];
                        next[ei] = { ...env, value: e.target.value };
                        update({ codebuild: { ...step.codebuild, env: next } });
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = [...step.codebuild.env];
                        next.splice(ei, 1);
                        update({ codebuild: { ...step.codebuild, env: next } });
                      }}
                      className="text-zinc-500 hover:text-red-400 px-2"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="col-span-2 flex flex-col gap-1.5">
                <FieldLabel hint="optional inline buildspec YAML">Buildspec override</FieldLabel>
                <textarea
                  value={step.codebuild.buildspec_override}
                  onChange={(e) =>
                    update({
                      codebuild: { ...step.codebuild, buildspec_override: e.target.value },
                    })
                  }
                  rows={4}
                  spellCheck={false}
                  className="w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-xs font-mono text-zinc-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main builder ─────────────────────────────────────────────────────────────
interface PipelineBuilderProps {
  state: BuilderState;
  onChange: (next: BuilderState) => void;
  onSave: () => void;
  saving?: boolean;
  saveLabel?: string;
  showTemplates?: boolean;
  /** When provided, also displayed as the pipeline filename hint. */
  filenameHint?: string;
  /** Collapse parameter and step cards that are present on mount (e.g. when editing an existing pipeline). New cards added after mount stay expanded. */
  collapseExisting?: boolean;
}

export function PipelineBuilder({
  state,
  onChange,
  onSave,
  saving,
  saveLabel = "Save pipeline",
  showTemplates = false,
  filenameHint,
  collapseExisting = false,
}: PipelineBuilderProps) {
  const issues = useMemo(() => validateBuilder(state), [state]);

  // Snapshot keys present on mount so only newly-added cards expand by default.
  const initialKeysRef = useRef<Set<string> | null>(null);
  if (initialKeysRef.current === null) {
    initialKeysRef.current = new Set([
      ...state.parameters.map((p) => p._key),
      ...state.steps.map((s) => s._key),
    ]);
  }
  const isExisting = (key: string) => collapseExisting && initialKeysRef.current!.has(key);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warn");

  const dupIds = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of state.parameters) {
      if (p.id) counts[p.id] = (counts[p.id] ?? 0) + 1;
    }
    return new Set(Object.keys(counts).filter((k) => counts[k] > 1));
  }, [state.parameters]);

  const paramIds = state.parameters.map((p) => p.id).filter(Boolean);

  function setParam(idx: number, next: BuilderParameter) {
    const ps = [...state.parameters];
    ps[idx] = next;
    onChange({ ...state, parameters: ps });
  }
  function moveParam(idx: number, dir: -1 | 1) {
    const ps = [...state.parameters];
    const ni = idx + dir;
    if (ni < 0 || ni >= ps.length) return;
    [ps[idx], ps[ni]] = [ps[ni], ps[idx]];
    onChange({ ...state, parameters: ps });
  }
  function removeParam(idx: number) {
    const ps = [...state.parameters];
    ps.splice(idx, 1);
    onChange({ ...state, parameters: ps });
  }
  function addParam(preset?: Partial<BuilderParameter>) {
    onChange({
      ...state,
      parameters: [...state.parameters, blankParameter(preset)],
    });
  }

  function setStep(idx: number, next: BuilderStep) {
    const ss = [...state.steps];
    ss[idx] = next;
    onChange({ ...state, steps: ss });
  }
  function moveStep(idx: number, dir: -1 | 1) {
    const ss = [...state.steps];
    const ni = idx + dir;
    if (ni < 0 || ni >= ss.length) return;
    [ss[idx], ss[ni]] = [ss[ni], ss[idx]];
    onChange({ ...state, steps: ss });
  }
  function removeStep(idx: number) {
    const ss = [...state.steps];
    ss.splice(idx, 1);
    onChange({ ...state, steps: ss });
  }
  function addStep(preset?: Partial<BuilderStep>) {
    onChange({ ...state, steps: [...state.steps, blankStep(preset)] });
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-4 custom-scroll">
        {showTemplates && (
          <SectionCard title="Start from a template" icon={Wand2} accent="bg-fuchsia-500/15 text-fuchsia-300">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {TEMPLATES.map((t) => {
                const TIcon = t.icon;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => onChange(t.build())}
                    className="group flex flex-col items-start gap-1.5 p-3 rounded-lg border border-zinc-800 bg-zinc-900/60 hover:border-violet-500/50 hover:bg-violet-500/5 transition-colors text-left"
                  >
                    <div className="h-7 w-7 rounded-md bg-violet-500/15 text-violet-300 flex items-center justify-center group-hover:bg-violet-500/25">
                      <TIcon className="h-3.5 w-3.5" />
                    </div>
                    <span className="text-sm text-zinc-100 font-medium">{t.name}</span>
                    <span className="text-[11px] text-zinc-500 leading-snug">{t.description}</span>
                  </button>
                );
              })}
            </div>
          </SectionCard>
        )}

        <SectionCard title="Pipeline metadata" icon={Sparkles}>
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-12 md:col-span-7 flex flex-col gap-1.5">
              <FieldLabel hint="shown in the pipeline list">Name</FieldLabel>
              <Input
                value={state.name}
                placeholder="Deploy Production"
                onChange={(e) => onChange({ ...state, name: e.target.value })}
              />
              {filenameHint && (
                <span className="text-[11px] text-zinc-500">
                  Filename: <code className="text-violet-300/80">{filenameHint}</code>
                </span>
              )}
            </div>
            <div className="col-span-12 md:col-span-5 flex flex-col gap-1.5">
              <FieldLabel>Version</FieldLabel>
              <Input
                value={state.version}
                placeholder="1.0"
                onChange={(e) => onChange({ ...state, version: e.target.value })}
              />
            </div>
            <div className="col-span-12 flex flex-col gap-1.5">
              <FieldLabel hint="what does this pipeline do?">Description</FieldLabel>
              <Input
                value={state.description}
                placeholder="Builds the app and deploys it to the dev cluster."
                onChange={(e) => onChange({ ...state, description: e.target.value })}
              />
            </div>
            <div className="col-span-12 flex flex-col gap-1.5">
              <FieldLabel hint="optional — auto-clones into /tmp/codeci-deploy and adds a Branch selector">
                Source Repository
              </FieldLabel>
              <Input
                value={state.repository}
                placeholder="https://github.com/org/repo"
                onChange={(e) => onChange({ ...state, repository: e.target.value })}
              />
            </div>
            {/*
              Concurrency + queue strategy share a row. Each cell uses
              flex-col + justify-end so the actual control bottom-aligns
              with its sibling even when the FieldLabel hints wrap to
              different heights, and so the conditional helper under the
              Select doesn't shove its control upward.
            */}
            <div className="col-span-12 md:col-span-5 flex flex-col gap-1.5 md:justify-end">
              <FieldLabel hint="default 1 — extra submissions queue as slots open">
                Max concurrent runs
              </FieldLabel>
              <Input
                type="number"
                min={1}
                step={1}
                value={state.maxConcurrentRuns === "" ? "" : String(state.maxConcurrentRuns)}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    onChange({ ...state, maxConcurrentRuns: "" });
                    return;
                  }
                  const n = Math.max(1, Math.floor(Number(raw)));
                  const nextMax = Number.isFinite(n) ? n : 1;
                  // "replace" is only valid at max=1 — force the strategy
                  // back to "fifo" the moment the user picks a higher cap
                  // so we never emit an invalid combination.
                  const nextStrategy = nextMax === 1 ? state.queueStrategy : "fifo";
                  onChange({ ...state, maxConcurrentRuns: nextMax, queueStrategy: nextStrategy });
                }}
                onBlur={() => {
                  if (state.maxConcurrentRuns === "" || Number(state.maxConcurrentRuns) < 1) {
                    onChange({ ...state, maxConcurrentRuns: 1 });
                  }
                }}
              />
            </div>
            <div className="col-span-12 md:col-span-7 flex flex-col gap-1.5 md:justify-end relative">
              <FieldLabel
                hint={
                  state.maxConcurrentRuns === 1
                    ? "behaviour when a new run arrives at the cap"
                    : "available only when Max concurrent runs is 1"
                }
              >
                Queue strategy
              </FieldLabel>
              <Select
                value={state.queueStrategy}
                disabled={state.maxConcurrentRuns !== 1}
                onChange={(e) =>
                  onChange({ ...state, queueStrategy: e.target.value as "fifo" | "replace" })
                }
                options={[
                  { label: "Sequential (FIFO) — run each submission in order", value: "fifo" },
                  { label: "Always latest — newer submissions replace the queued one", value: "replace" },
                ]}
              />
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Parameters"
          subtitle="Inputs the user fills in before running the pipeline."
          icon={SlidersIcon}
          accent="bg-emerald-500/15 text-emerald-300"
          action={
            <div className="flex items-center gap-1.5">
              <Button type="button" size="sm" variant="ghost" onClick={() => addParam({ type: "text" })} title="Add text input">
                <TypeIcon className="h-3.5 w-3.5 mr-1" /> Text
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => addParam({ type: "select" })} title="Add dropdown">
                <ListChecks className="h-3.5 w-3.5 mr-1" /> Select
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  addParam({
                    type: "select",
                    label: "Branch",
                    id: "git_branch",
                    source: paramIds[0] ? `git-branches:${paramIds[0]}` : "git-branches:git_repo",
                  })
                }
                title="Add a branch picker tied to a repo URL parameter"
              >
                <GitBranch className="h-3.5 w-3.5 mr-1" /> Branch
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => addParam({ type: "checkbox" })}>
                <ToggleLeft className="h-3.5 w-3.5 mr-1" /> Toggle
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => addParam({ type: "password" })}>
                <KeyRound className="h-3.5 w-3.5 mr-1" /> Secret
              </Button>
            </div>
          }
        >
          {state.parameters.length === 0 ? (
            <EmptyHint
              icon={Plus}
              title="No parameters yet"
              hint="Use the buttons above to add a text input, select, branch picker, toggle or secret."
            />
          ) : (
            <div className="space-y-2.5">
              {state.parameters.map((p, i) => (
                <ParameterCard
                  key={p._key}
                  index={i}
                  total={state.parameters.length}
                  param={p}
                  onChange={(np) => setParam(i, np)}
                  onRemove={() => removeParam(i)}
                  onMove={(d) => moveParam(i, d)}
                  otherParamIds={state.parameters.filter((_, j) => j !== i).map((q) => q.id).filter(Boolean)}
                  duplicate={!!p.id && dupIds.has(p.id)}
                  defaultExpanded={!isExisting(p._key)}
                />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Steps"
          subtitle="Run sequentially. Each step is either a shell command or a CodeBuild project."
          icon={Terminal}
          accent="bg-sky-500/15 text-sky-300"
          action={
            <div className="flex items-center gap-1.5">
              <Button type="button" size="sm" variant="ghost" onClick={() => addStep({ runner: "docker" })}>
                <Terminal className="h-3.5 w-3.5 mr-1" /> Shell step
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => addStep({ runner: "codebuild" })}>
                <Cloud className="h-3.5 w-3.5 mr-1" /> CodeBuild step
              </Button>
            </div>
          }
        >
          {state.steps.length === 0 ? (
            <EmptyHint
              icon={Terminal}
              title="No steps yet"
              hint="Add a shell step to run commands inside the runner, or a CodeBuild step to delegate to AWS."
            />
          ) : (
            <div className="space-y-2.5">
              {state.steps.map((s, i) => (
                <StepCard
                  key={s._key}
                  index={i}
                  total={state.steps.length}
                  step={s}
                  onChange={(ns) => setStep(i, ns)}
                  onRemove={() => removeStep(i)}
                  onMove={(d) => moveStep(i, d)}
                  paramIds={paramIds}
                  defaultExpanded={!isExisting(s._key)}
                />
              ))}
            </div>
          )}
        </SectionCard>

        {(errors.length > 0 || warnings.length > 0) && (
          <SectionCard
            title={errors.length > 0 ? "Issues" : "Warnings"}
            icon={AlertTriangle}
            accent={errors.length > 0 ? "bg-red-500/15 text-red-300" : "bg-amber-500/15 text-amber-300"}
          >
            <ul className="text-xs space-y-1.5">
              {errors.map((i, k) => (
                <li key={`e${k}`} className="text-red-300 flex items-start gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  {i.message}
                </li>
              ))}
              {warnings.map((i, k) => (
                <li key={`w${k}`} className="text-amber-300/90 flex items-start gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  {i.message}
                </li>
              ))}
            </ul>
          </SectionCard>
        )}

      </div>

      <footer className="shrink-0 mt-3 flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/80 px-4 py-2.5 backdrop-blur">
        <div className="text-xs text-zinc-500">
          {errors.length === 0 ? (
            <span className="flex items-center gap-1.5 text-emerald-300/80">
              <CheckCircle2 className="h-3.5 w-3.5" /> Looks good
            </span>
          ) : (
            <span className="text-red-300/80">
              {errors.length} issue{errors.length === 1 ? "" : "s"} to fix before saving
            </span>
          )}
        </div>
        <Button onClick={onSave} loading={saving} disabled={errors.length > 0}>
          {saveLabel}
        </Button>
      </footer>

      <style>{`
        .custom-scroll::-webkit-scrollbar { width: 8px; }
        .custom-scroll::-webkit-scrollbar-track { background: transparent; }
        .custom-scroll::-webkit-scrollbar-thumb { background: #27272a; border-radius: 4px; }
        .custom-scroll::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
      `}</style>
    </div>
  );
}

function EmptyHint({ icon: Icon, title, hint }: { icon: any; title: string; hint: string }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 px-6 py-8 text-center">
      <div className="h-10 w-10 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-3">
        <Icon className="h-4 w-4 text-zinc-500" />
      </div>
      <h4 className="text-sm font-medium text-zinc-200">{title}</h4>
      <p className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto">{hint}</p>
    </div>
  );
}

// Inline replacement for SlidersHorizontal so the Parameters section header gets a nicer matched icon set.
function SlidersIcon(props: any) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="21" y1="4" x2="14" y2="4" />
      <line x1="10" y1="4" x2="3" y2="4" />
      <line x1="21" y1="12" x2="12" y2="12" />
      <line x1="8" y1="12" x2="3" y2="12" />
      <line x1="21" y1="20" x2="16" y2="20" />
      <line x1="12" y1="20" x2="3" y2="20" />
      <line x1="14" y1="2" x2="14" y2="6" />
      <line x1="8" y1="10" x2="8" y2="14" />
      <line x1="16" y1="18" x2="16" y2="22" />
    </svg>
  );
}
