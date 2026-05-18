import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import { type PipelineStep } from "@/lib/api";
import { type SubstepNode, type WsMessage } from "@/lib/ws";
import { cn, isErrorLine, formatElapsed } from "@/lib/utils";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";

type StepStatus = "pending" | "running" | "success" | "failed";

interface SubstepRuntime {
  status: StepStatus;
  startedAt?: number;
  duration?: number;
}

interface StepState {
  status: StepStatus;
  messages: WsMessage[];
  startedAt?: number;
  duration?: number;
  meta: Record<string, string>;
  /** Plan tree as delivered by the backend; null until a plan arrives. */
  plan: SubstepNode[] | null;
  /** Per-substep runtime state keyed by hierarchical ID. */
  substepRuntime: Record<string, SubstepRuntime>;
  /** ID of the currently-running substep, if any. */
  currentSubstepId?: string;
}

const STEP_LOG_ROW_HEIGHT = 18;
const STEP_VIRTUALIZATION_THRESHOLD = 200;
const MAX_STEP_LOG_HEIGHT = 256; // Tailwind max-h-64

function deriveStepStates(
  steps: PipelineStep[],
  messages: WsMessage[],
  _isPipelineRunning: boolean
): StepState[] {
  const states: StepState[] = steps.map(() => ({
    status: "pending",
    messages: [],
    meta: {},
    plan: null,
    substepRuntime: {},
  }));

  // applyNameOverride returns a copy of the plan tree with the node whose
  // id matches `targetID` relabeled. Used when the runtime emits a resolved
  // value for a dynamic echo (e.g. "AWS Region: us-east-1" supersedes the
  // static-prefix label "AWS Region:" that the plan was built with).
  const applyNameOverride = (
    nodes: SubstepNode[] | null,
    targetID: string,
    newName: string,
  ): SubstepNode[] | null => {
    if (!nodes) return nodes;
    let changed = false;
    const next = nodes.map((n): SubstepNode => {
      if (n.id === targetID) {
        changed = true;
        return { ...n, name: newName };
      }
      const childUpdate = applyNameOverride(n.children ?? null, targetID, newName);
      if (childUpdate && childUpdate !== n.children) {
        changed = true;
        return { ...n, children: childUpdate };
      }
      return n;
    });
    return changed ? next : nodes;
  };

  // Walk a plan tree returning every substep ID in source order. Used when
  // resolving the parent of a marker, propagating completion, etc.
  const flattenIds = (nodes: SubstepNode[] | null | undefined): string[] => {
    if (!nodes) return [];
    const out: string[] = [];
    const walk = (ns: SubstepNode[]) => {
      for (const n of ns) {
        out.push(n.id);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(nodes);
    return out;
  };

  // Mark a substep with the given status and stamp duration. No-op if the
  // substep isn't in the plan.
  const setSubstepStatus = (
    idx: number,
    id: string,
    status: StepStatus,
    t: number,
  ) => {
    const prev = states[idx].substepRuntime[id];
    const startedAt = prev?.startedAt ?? (status === "running" ? t : undefined);
    const duration =
      status !== "running" && startedAt !== undefined ? t - startedAt : prev?.duration;
    states[idx] = {
      ...states[idx],
      substepRuntime: {
        ...states[idx].substepRuntime,
        [id]: { status, startedAt, duration },
      },
    };
  };

  // Returns the dot-prefixed ancestor chain (NOT including the node itself).
  // Used so that when "1.2.3" goes running, "1" and "1.2" are also marked
  // running — the user sees the whole path through the tree light up.
  const ancestorsOf = (id: string): string[] => {
    const parts = id.split(".");
    const out: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      out.push(parts.slice(0, i).join("."));
    }
    return out;
  };

  // When substep X goes running, every sibling that comes "before" X in tree
  // order is implicitly done — scripts don't skip backward. Determines those
  // and promotes them to success.
  const promoteAncestorsAndPredecessors = (idx: number, runningId: string, t: number) => {
    const allIds = flattenIds(states[idx].plan);
    const runningIdx = allIds.indexOf(runningId);
    if (runningIdx < 0) return;
    const ancestors = new Set(ancestorsOf(runningId));
    for (let i = 0; i < runningIdx; i++) {
      const id = allIds[i];
      if (ancestors.has(id)) continue; // ancestors stay "running"
      const cur = states[idx].substepRuntime[id]?.status ?? "pending";
      if (cur === "pending" || cur === "running") {
        setSubstepStatus(idx, id, "success", t);
      }
    }
    // Ancestors stay "running" until their last child completes — at the
    // moment a new substep starts under them, they're definitely active.
    for (const a of ancestors) {
      const cur = states[idx].substepRuntime[a]?.status ?? "pending";
      if (cur === "pending") {
        setSubstepStatus(idx, a, "running", t);
      }
    }
    setSubstepStatus(idx, runningId, "running", t);
  };

  let currentIdx = -1;

  for (const msg of messages) {
    // Use the server's clock as the event time. Falling back to Date.now()
    // would re-stamp running steps to "now" on every re-render, which made
    // the step timer appear to restart whenever a new log line arrived.
    const t = msg.time ?? Date.now();
    if (msg.type === "step") {
      const idx = steps.findIndex((s) => s.name === msg.data);
      if (idx === -1) continue;
      if (currentIdx >= 0 && states[currentIdx].status === "running") {
        states[currentIdx] = {
          ...states[currentIdx],
          status: "success",
          duration: states[currentIdx].startedAt != null
            ? t - states[currentIdx].startedAt!
            : undefined,
        };
        // When the parent step ends cleanly, any in-flight substeps are
        // implicitly done as well.
        for (const id of flattenIds(states[currentIdx].plan)) {
          const cur = states[currentIdx].substepRuntime[id]?.status ?? "pending";
          if (cur === "running") setSubstepStatus(currentIdx, id, "success", t);
        }
      }
      currentIdx = idx;
      states[idx] = {
        ...states[idx],
        status: "running",
        startedAt: t,
      };
    } else if (msg.type === "stdout" || msg.type === "stderr" || msg.type === "error") {
      let target = currentIdx;
      if (msg.step) {
        const idx = steps.findIndex((s) => s.name === msg.step);
        if (idx !== -1) target = idx;
      }
      if (target >= 0) {
        states[target].messages.push(msg);
      }
    } else if (msg.type === "substep_plan") {
      let target = currentIdx;
      if (msg.step) {
        const idx = steps.findIndex((s) => s.name === msg.step);
        if (idx !== -1) target = idx;
      }
      if (target < 0) continue;
      states[target] = {
        ...states[target],
        plan: msg.substeps ?? [],
        // Reset runtime state so a re-attached plan doesn't show stale ticks.
        substepRuntime: {},
      };
    } else if (msg.type === "substep") {
      let target = currentIdx;
      if (msg.step) {
        const idx = steps.findIndex((s) => s.name === msg.step);
        if (idx !== -1) target = idx;
      }
      const id = (msg.data ?? "").trim();
      if (target < 0 || !id) continue;
      states[target] = {
        ...states[target],
        currentSubstepId: id,
      };
      promoteAncestorsAndPredecessors(target, id, t);
      // The runtime can emit a resolved label override (for echoes that
      // include $vars or $(...)). Apply it to the plan tree so the user
      // sees "AWS Region: us-east-1" instead of "AWS Region:".
      const resolvedName = msg.meta?.name;
      if (resolvedName) {
        states[target] = {
          ...states[target],
          plan: applyNameOverride(states[target].plan, id, resolvedName),
        };
      }
    } else if (msg.type === "substep_end") {
      // END marker: the backend's __codeci_with_stack wrapper returned, so
      // this substep (and any still-running descendant the planner couldn't
      // fully instrument due to the depth cap) is done. Without this the
      // indicator would freeze on the last leaf until the parent step's
      // `exit` event fired.
      let target = currentIdx;
      if (msg.step) {
        const idx = steps.findIndex((s) => s.name === msg.step);
        if (idx !== -1) target = idx;
      }
      const endId = (msg.data ?? "").trim();
      if (target < 0 || !endId) continue;
      const isTerminal = (s: StepStatus) => s === "success" || s === "failed";
      // Mark endId itself, then any running descendant. We compare by
      // dot-prefix so depth-capped leaves (whose ids aren't in the plan)
      // are also reached when they exist in substepRuntime.
      const candidates = new Set<string>([endId]);
      for (const id of Object.keys(states[target].substepRuntime)) {
        if (id === endId || id.startsWith(endId + ".")) candidates.add(id);
      }
      for (const id of flattenIds(states[target].plan)) {
        if (id === endId || id.startsWith(endId + ".")) candidates.add(id);
      }
      for (const id of candidates) {
        const cur = states[target].substepRuntime[id]?.status ?? "pending";
        if (cur === "running") {
          setSubstepStatus(target, id, "success", t);
        } else if (cur === "pending" && id === endId) {
          // Substep id isn't in the plan (depth-capped) but was running
          // implicitly via the wrapper. Stamp it as success too so it
          // doesn't hang in substepRuntime indefinitely.
          setSubstepStatus(target, id, "success", t);
        }
        if (isTerminal(cur)) continue;
      }
      if (states[target].currentSubstepId === endId) {
        states[target] = { ...states[target], currentSubstepId: undefined };
      }
    } else if (msg.type === "meta") {
      let target = currentIdx;
      if (msg.step) {
        const idx = steps.findIndex((s) => s.name === msg.step);
        if (idx !== -1) target = idx;
      }
      if (target >= 0 && msg.meta) {
        states[target] = {
          ...states[target],
          meta: { ...states[target].meta, ...msg.meta },
        };
      }
    } else if (msg.type === "exit") {
      let target = currentIdx;
      if (msg.step) {
        const idx = steps.findIndex((s) => s.name === msg.step);
        if (idx !== -1) target = idx;
      }
      if (target >= 0 && states[target].status === "running") {
        const success = (msg.code ?? 0) === 0;
        // Propagate to substeps: still-pending → stays pending (we just
        // never reached them, e.g. early exit); still-running → success
        // when parent succeeded, failed when parent failed.
        for (const id of flattenIds(states[target].plan)) {
          const cur = states[target].substepRuntime[id]?.status ?? "pending";
          if (cur === "running") {
            setSubstepStatus(target, id, success ? "success" : "failed", t);
          }
        }
        states[target] = {
          ...states[target],
          status: success ? "success" : "failed",
          duration: states[target].startedAt != null
            ? t - states[target].startedAt!
            : undefined,
        };
      }
    }
  }

  // Intentionally do NOT downgrade an in-flight step to "failed" purely
  // because the parent reports the pipeline as not running. The WS may have
  // disconnected (idle proxy, network blip) while the backend run is still
  // going — falsely showing "failed" was the source of a real user-reported
  // bug. The only authoritative failure signal is an `exit` message with a
  // non-zero code, which is handled in the loop above. When the run truly
  // ends, the parent shows the final status from the DB record (the badge
  // in the header, plus the run.Status-driven banner).

  return states;
}

function useTick(running: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
}

function formatDuration(ms?: number, startedAt?: number): string {
  if (ms !== undefined) return formatElapsed(ms);
  if (startedAt !== undefined) return formatElapsed(Date.now() - startedAt);
  return "";
}

// ── Icons ──────────────────────────────────────────────────────────────────

function PendingIcon() {
  return (
    <div className="h-7 w-7 rounded-full border-2 border-zinc-600 bg-zinc-900 flex items-center justify-center flex-shrink-0">
      <div className="h-2 w-2 rounded-full bg-zinc-600" />
    </div>
  );
}

function RunningIcon() {
  return (
    <div className="relative h-7 w-7 flex-shrink-0">
      <div className="absolute inset-0 rounded-full bg-violet-500 opacity-30 animate-ping" />
      <svg className="absolute inset-0 h-7 w-7 animate-spin" viewBox="0 0 28 28" fill="none">
        <circle
          cx="14" cy="14" r="12"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeDasharray="56"
          strokeDashoffset="42"
          className="text-violet-500"
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="h-3 w-3 rounded-full bg-violet-500" />
      </div>
    </div>
  );
}

function SuccessIcon() {
  return (
    <div className="h-7 w-7 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0 shadow-[0_0_10px_rgba(16,185,129,0.4)]">
      <svg className="h-4 w-4 text-white" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3,8 6.5,12 13,4" />
      </svg>
    </div>
  );
}

function FailedIcon() {
  return (
    <div className="h-7 w-7 rounded-full bg-red-500 flex items-center justify-center flex-shrink-0 shadow-[0_0_10px_rgba(239,68,68,0.4)]">
      <svg className="h-4 w-4 text-white" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
        <line x1="4" y1="4" x2="12" y2="12" />
        <line x1="12" y1="4" x2="4" y2="12" />
      </svg>
    </div>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "running":  return <RunningIcon />;
    case "success":  return <SuccessIcon />;
    case "failed":   return <FailedIcon />;
    default:         return <PendingIcon />;
  }
}

// ── Status badge ───────────────────────────────────────────────────────────

function StatusBadge({ status, duration, startedAt }: { status: StepStatus; duration?: number; startedAt?: number }) {
  const dur = formatDuration(duration, status === "running" ? startedAt : undefined);

  const cfg = {
    pending: { label: "Pending",  cls: "text-zinc-500 bg-zinc-800/60 border-zinc-700" },
    running: { label: "Running",  cls: "text-violet-300 bg-violet-950/60 border-violet-700" },
    success: { label: "Done",     cls: "text-emerald-300 bg-emerald-950/60 border-emerald-700" },
    failed:  { label: "Failed",   cls: "text-red-300 bg-red-950/60 border-red-700" },
  }[status];

  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border", cfg.cls)}>
      {status === "running" && (
        <span className="flex gap-0.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
      )}
      {cfg.label}
      {dur && <span className="opacity-70">{dur}</span>}
    </span>
  );
}

// ── Per-step log block ─────────────────────────────────────────────────────

const StepLogRow = memo(function StepLogRow({ index, style, data }: ListChildComponentProps<WsMessage[]>) {
  const msg = data[index];
  return (
    <div
      style={style}
      className={cn(
        "whitespace-nowrap font-mono text-xs leading-[18px]",
        msg.type === "stdout" ? "text-emerald-400" :
        msg.type === "stderr" ? (isErrorLine(msg.data ?? "") ? "text-red-400" : "text-amber-400") :
        msg.type === "error"  ? "text-red-500 font-semibold" :
        msg.type === "meta"   ? "text-violet-400 italic" :
        "text-zinc-400"
      )}
    >
      {(msg.data ?? "").replace(/\n$/, "")}
    </div>
  );
});

function StepLogs({ messages }: { messages: WsMessage[] }) {
  const itemKey = useCallback((index: number, data: WsMessage[]) => data[index].seq ?? index, []);
  const listRef = useRef<FixedSizeList<WsMessage[]>>(null);

  // Auto-scroll to bottom on new logs (cheap: just one rAF per messages.length change).
  useEffect(() => {
    if (messages.length === 0) return;
    listRef.current?.scrollToItem(messages.length - 1, "end");
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <p className="text-xs text-zinc-600 italic px-1">No output for this step.</p>
    );
  }

  if (messages.length > STEP_VIRTUALIZATION_THRESHOLD) {
    const height = Math.min(MAX_STEP_LOG_HEIGHT, messages.length * STEP_LOG_ROW_HEIGHT);
    return (
      <FixedSizeList
        ref={listRef}
        height={height}
        width="100%"
        itemCount={messages.length}
        itemSize={STEP_LOG_ROW_HEIGHT}
        itemData={messages}
        itemKey={itemKey}
        overscanCount={10}
      >
        {StepLogRow}
      </FixedSizeList>
    );
  }

  return (
    <div className="font-mono text-xs leading-[18px]">
      {messages.map((msg, i) => (
        <div
          key={msg.seq ?? i}
          className={cn(
            "whitespace-pre-wrap break-all",
            msg.type === "stdout" ? "text-emerald-400" :
            msg.type === "stderr" ? (isErrorLine(msg.data ?? "") ? "text-red-400" : "text-amber-400") :
            msg.type === "error"  ? "text-red-500 font-semibold" :
            msg.type === "meta"   ? "text-violet-400 italic" :
            "text-zinc-400"
          )}
        >
          {msg.data}
        </div>
      ))}
    </div>
  );
}

// ── Substeps (statically-planned progress tree under each step) ───────────

function SubstepIcon({ status }: { status: StepStatus }) {
  if (status === "running") {
    return (
      <span className="relative inline-flex h-3 w-3 flex-shrink-0">
        <span className="absolute inset-0 rounded-full bg-violet-500 opacity-40 animate-ping" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-violet-500" />
      </span>
    );
  }
  if (status === "success") {
    return (
      <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-emerald-500 flex-shrink-0">
        <svg className="h-2 w-2 text-white" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3,8 6.5,12 13,4" />
        </svg>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-red-500 flex-shrink-0">
        <svg className="h-2 w-2 text-white" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round">
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
      </span>
    );
  }
  return (
    <span className="inline-flex h-3 w-3 rounded-full border border-zinc-700 bg-zinc-900 flex-shrink-0" />
  );
}

interface SubstepTreeProps {
  nodes: SubstepNode[];
  runtime: Record<string, SubstepRuntime>;
  depth?: number;
}

// subtreeHasFired returns true if `node` (or any descendant) is in `runtime`.
// `runtime` only gains entries when a start/end marker actually fires at run
// time, so this filter shows ONLY the branches a particular invocation
// exercised — not every helper the static planner could see in the AST.
function subtreeHasFired(
  node: SubstepNode,
  runtime: Record<string, SubstepRuntime>,
): boolean {
  if (runtime[node.id]) return true;
  if (node.children) {
    for (const c of node.children) {
      if (subtreeHasFired(c, runtime)) return true;
    }
  }
  return false;
}

function SubstepTree({ nodes, runtime, depth = 0 }: SubstepTreeProps) {
  const visible = nodes.filter((n) => subtreeHasFired(n, runtime));
  if (visible.length === 0) return null;
  return (
    <ul className={cn("space-y-1", depth === 0 ? "mt-2 ml-5 border-l border-zinc-800 pl-4" : "mt-1 ml-3 border-l border-zinc-800/60 pl-3")}>
      {visible.map((node) => {
        const rt = runtime[node.id];
        const status: StepStatus = rt?.status ?? "pending";
        const dur = formatDuration(rt?.duration, status === "running" ? rt?.startedAt : undefined);
        return (
          <li key={node.id} className="text-[12px]">
            <div className="flex items-center gap-2">
              <SubstepIcon status={status} />
              <span
                className={cn(
                  "truncate font-mono",
                  status === "running" ? "text-violet-200" :
                  status === "success" ? "text-zinc-300" :
                  status === "failed"  ? "text-red-300" :
                  "text-zinc-500"
                )}
                title={node.name}
              >
                {node.name}
              </span>
              {dur && (
                <span className="text-[10px] font-mono text-zinc-500 ml-auto pl-2">{dur}</span>
              )}
            </div>
            {node.children && node.children.length > 0 && (
              <SubstepTree nodes={node.children} runtime={runtime} depth={depth + 1} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SubstepProgress({ state }: { state: StepState }) {
  if (!state.plan || state.plan.length === 0) return null;
  // Total = substeps the runtime has actually touched (matches what
  // SubstepTree renders). The counter grows as new branches execute,
  // rather than displaying a fixed total full of unreachable functions.
  const firedIds = Object.keys(state.substepRuntime);
  if (firedIds.length === 0) return null;
  const done = firedIds.filter((id) => {
    const s = state.substepRuntime[id]?.status;
    return s === "success" || s === "failed";
  }).length;
  return (
    <>
      <div className="mt-2 ml-5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-500">
        <span>Substeps</span>
        <span className="font-mono">{done}/{firedIds.length}</span>
      </div>
      <SubstepTree nodes={state.plan} runtime={state.substepRuntime} />
    </>
  );
}

// ── Step row chips (codebuild build link, phase) ───────────────────────────

function StepMetaChips({ meta }: { meta: Record<string, string> }) {
  if (!meta) return null;
  const isCodeBuild = meta.runner === "codebuild";
  if (!isCodeBuild) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-violet-950/60 text-violet-300 border border-violet-800">
        CodeBuild
      </span>
      {meta.phase && (
        <span className="text-[10px] text-zinc-500 font-mono">{meta.phase}</span>
      )}
      {meta.console_url && (
        <a
          href={meta.console_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-0.5 text-[10px] text-violet-400 hover:text-violet-300"
          title="Open this build in the AWS console"
        >
          AWS <ExternalLink className="h-2.5 w-2.5" />
        </a>
      )}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

interface StepTrackerProps {
  steps: PipelineStep[];
  messages: WsMessage[];
  running: boolean;
  defaultExpanded?: boolean;
}

export function StepTracker({ steps, messages, running, defaultExpanded = true }: StepTrackerProps) {
  useTick(running);

  const [showLogs, setShowLogs] = useState(false);
  const [expandedMap, setExpandedMap] = useState<Record<number, boolean>>({});

  // Re-derive only when the message-array identity changes; with rAF batching
  // upstream this is bounded to one re-derive per animation frame.
  const derived = useMemo(
    () => deriveStepStates(steps, messages, running),
    [steps, messages, running]
  );

  // Auto-expand the currently running step
  useEffect(() => {
    const runningIdx = derived.findIndex((s) => s.status === "running");
    if (runningIdx >= 0) {
      setExpandedMap((prev) => ({ ...prev, [runningIdx]: true }));
    }
  }, [derived]);

  const toggle = useCallback((idx: number) => {
    setExpandedMap((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }, []);

  const isExpanded = (idx: number) =>
    expandedMap[idx] !== undefined ? expandedMap[idx] : defaultExpanded;

  if (steps.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
        No steps defined.
      </div>
    );
  }

  const exitMsg = messages.find((m) => m.type === "exit");

  return (
    <div className="flex flex-col gap-0 p-4 md:p-6 h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
          Execution Steps
        </h3>
        <button
          onClick={() => setShowLogs(!showLogs)}
          className="text-[11px] font-medium px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
        >
          {showLogs ? "Hide Logs" : "Show Logs"}
        </button>
      </div>

      <div className="relative">
        {steps.map((step, idx) => {
          const state = derived[idx];
          const expanded = isExpanded(idx);
          const isLast = idx === steps.length - 1;
          const hasPlan = !!state.plan && Object.keys(state.substepRuntime).length > 0;
          const canToggle = state.messages.length > 0 || state.status === "running" || hasPlan;

          return (
            <div key={idx} className="relative flex gap-4">
              <div className="flex flex-col items-center">
                <StepIcon status={state.status} />
                {!isLast && (
                  <div
                    className={cn(
                      "w-0.5 flex-1 min-h-6 mt-1 rounded-full transition-colors duration-500",
                      state.status === "success" ? "bg-emerald-700/50" :
                      state.status === "failed"  ? "bg-red-700/50" :
                      state.status === "running" ? "bg-violet-700/50 animate-pulse" :
                      "bg-zinc-800"
                    )}
                  />
                )}
              </div>

              <div className={cn("flex-1 pb-6 min-w-0", isLast && "pb-2")}>
                <div
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-lg px-3 py-2 -mx-3 transition-colors",
                    canToggle ? "cursor-pointer hover:bg-zinc-800/50" : ""
                  )}
                  onClick={() => canToggle && toggle(idx)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {canToggle ? (
                      expanded
                        ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500 flex-shrink-0" />
                        : <ChevronRight className="h-3.5 w-3.5 text-zinc-500 flex-shrink-0" />
                    ) : (
                      <span className="h-3.5 w-3.5 flex-shrink-0" />
                    )}
                    <span className={cn(
                      "text-sm font-medium truncate",
                      state.status === "pending"  ? "text-zinc-500" :
                      state.status === "running"  ? "text-violet-200" :
                      state.status === "success"  ? "text-zinc-200" :
                      "text-red-300"
                    )}>
                      {step.name}
                    </span>
                    <StepMetaChips meta={state.meta} />
                  </div>
                  <StatusBadge
                    status={state.status}
                    duration={state.duration}
                    startedAt={state.startedAt}
                  />
                </div>

                {expanded && canToggle && (
                  <>
                    {/* Statically-planned substep tree — gated by expand so
                        collapsing the step hides its sub-steps too. */}
                    <SubstepProgress state={state} />

                    {/* Live tail (CodeBuild). Shows the rolling last ~10 lines
                        while the build runs; cleared automatically once it
                        reaches a terminal status. */}
                    {state.status === "running" && state.meta.live_tail && (
                      <div className="mt-2 ml-5 rounded-lg bg-zinc-950/70 border border-zinc-800 px-3 py-2">
                        <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                          live tail
                        </p>
                        <pre className="font-mono text-[11px] leading-[15px] text-zinc-400 whitespace-pre-wrap break-all max-h-24 md:max-h-36 overflow-hidden">
                          {state.meta.live_tail}
                        </pre>
                      </div>
                    )}

                    {showLogs && (
                      <div className="mt-2 ml-5 rounded-lg bg-zinc-950 border border-zinc-800 p-3 max-h-48 md:max-h-64 overflow-y-auto">
                        <StepLogs messages={state.messages} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!running && exitMsg && (
        <div className={cn(
          "mt-4 rounded-lg border px-4 py-3 text-sm font-medium text-center",
          exitMsg.code === 0
            ? "bg-emerald-950/40 border-emerald-800 text-emerald-300"
            : "bg-red-950/40 border-red-800 text-red-300"
        )}>
          {exitMsg.code === 0
            ? "✓ All steps completed successfully"
            : "✗ Pipeline failed — see summary above and step logs"}
        </div>
      )}
    </div>
  );
}
