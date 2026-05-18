import { useEffect, useMemo, useRef, useState } from "react";
import type { WsMessage } from "@/lib/ws";
import { isErrorLine } from "@/lib/utils";
import { X, Search, ArrowDownToLine, Pause, Play as PlayIcon, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * LogViewerModal renders a full-viewport log popup with text + type filters.
 *
 * Filtering is a non-destructive view over the parent's `logs` prop — the
 * parent's WS pipeline keeps pushing into the underlying array; this modal
 * just decides what's rendered. Filters run on every render; the log array
 * is already debounced upstream (RunDetail's useBatchedLogs).
 */
export type LogTypeFilter = {
  stdout: boolean;
  stderr: boolean;
  step: boolean;
  error: boolean;
  exit: boolean;
};

const DEFAULT_TYPE_FILTER: LogTypeFilter = {
  stdout: true,
  stderr: true,
  step: true,
  error: true,
  exit: true,
};

export function LogViewerModal({
  logs,
  open,
  onClose,
  running,
}: {
  logs: WsMessage[];
  open: boolean;
  onClose: () => void;
  running: boolean;
}) {
  const [query, setQuery] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [types, setTypes] = useState<LogTypeFilter>(DEFAULT_TYPE_FILTER);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Esc to dismiss
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: WsMessage[] = [];
    for (const m of logs) {
      if (!matchType(m, types)) continue;
      if (errorsOnly && !isMessageError(m)) continue;
      if (q) {
        const text = (m.data ?? "") + " " + (m.step ?? "");
        if (!text.toLowerCase().includes(q)) continue;
      }
      out.push(m);
    }
    return out;
  }, [logs, query, types, errorsOnly]);

  // Auto-scroll: stick to bottom when enabled. We snap on every render since
  // a fresh WS message pushes a new entry into `logs` -> filtered changes.
  useEffect(() => {
    if (!open || !autoScroll) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered.length, open, autoScroll]);

  if (!open) return null;

  const counts = countByType(logs);

  function toggleType(k: keyof LogTypeFilter) {
    setTypes((prev) => ({ ...prev, [k]: !prev[k] }));
  }

  async function handleCopy() {
    const text = filtered
      .map((m) => {
        if (m.type === "step") return `▶ ${m.data}`;
        if (m.type === "exit") return `Exit: ${m.code}`;
        return m.data ?? "";
      })
      .join("");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // best-effort
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-7xl h-[92vh] flex flex-col rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-zinc-100">Live logs</h2>
            {running && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300 bg-emerald-950/40 border border-emerald-800 rounded-full px-2 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                streaming
              </span>
            )}
            <span className="text-xs text-zinc-500">
              {filtered.length.toLocaleString()} / {logs.length.toLocaleString()} lines
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              title="Copy filtered logs"
              className="gap-1.5"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <button
              onClick={onClose}
              className="rounded p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title="Close (Esc)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-5 py-2.5">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter logs… (regex-free substring)"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 pl-8 pr-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-violet-600"
            />
          </div>
          <div className="flex items-center gap-1">
            <FilterChip label="stdout" count={counts.stdout} active={types.stdout} onClick={() => toggleType("stdout")} colorClass="emerald" />
            <FilterChip label="stderr" count={counts.stderr} active={types.stderr} onClick={() => toggleType("stderr")} colorClass="amber" />
            <FilterChip label="step"   count={counts.step}   active={types.step}   onClick={() => toggleType("step")}   colorClass="cyan" />
            <FilterChip label="error"  count={counts.error}  active={types.error}  onClick={() => toggleType("error")}  colorClass="red" />
            <FilterChip label="exit"   count={counts.exit}   active={types.exit}   onClick={() => toggleType("exit")}   colorClass="zinc" />
          </div>
          <label className="inline-flex items-center gap-1.5 text-xs text-zinc-400 ml-1">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => setErrorsOnly(e.target.checked)}
              className="h-3.5 w-3.5 accent-red-500"
            />
            Errors only
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAutoScroll((v) => !v)}
            className="gap-1.5 ml-auto"
            title={autoScroll ? "Pause auto-scroll" : "Resume auto-scroll"}
          >
            {autoScroll ? <Pause className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
            {autoScroll ? "Tailing" : "Paused"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const el = bodyRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            title="Jump to bottom"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Body */}
        <div
          ref={bodyRef}
          className="flex-1 overflow-y-auto font-mono text-[12px] leading-relaxed p-4 bg-zinc-950"
        >
          {filtered.length === 0 ? (
            <div className="flex items-center justify-center h-full text-zinc-600 text-xs">
              {logs.length === 0
                ? (running ? "Waiting for output…" : "No log entries.")
                : "No entries match the current filter."}
            </div>
          ) : (
            filtered.map((msg, i) => (
              <Line key={msg.seq ?? i} msg={msg} highlight={query.trim()} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  label, count, active, onClick, colorClass,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  colorClass: "emerald" | "amber" | "cyan" | "red" | "zinc";
}) {
  const colors: Record<typeof colorClass, string> = {
    emerald: "border-emerald-700 text-emerald-300 bg-emerald-950/40",
    amber:   "border-amber-700  text-amber-300  bg-amber-950/40",
    cyan:    "border-cyan-700   text-cyan-300   bg-cyan-950/40",
    red:     "border-red-700    text-red-300    bg-red-950/40",
    zinc:    "border-zinc-700   text-zinc-300   bg-zinc-900",
  };
  return (
    <button
      onClick={onClick}
      className={
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-all " +
        (active ? colors[colorClass] : "border-zinc-800 text-zinc-600 bg-transparent hover:text-zinc-400")
      }
      title={active ? `Hide ${label}` : `Show ${label}`}
    >
      <span className="uppercase tracking-wide">{label}</span>
      <span className="opacity-60">{count}</span>
    </button>
  );
}

function Line({ msg, highlight }: { msg: WsMessage; highlight: string }) {
  const cls =
    msg.type === "step"   ? "text-cyan-400 font-semibold mt-2" :
    msg.type === "stdout" ? "text-emerald-300" :
    msg.type === "stderr" ? (isErrorLine(msg.data ?? "") ? "text-red-300" : "text-amber-300") :
    msg.type === "error"  ? "text-red-400 font-semibold" :
    "text-zinc-500 italic";

  const content =
    msg.type === "step" ? `▶ ${msg.data ?? ""}` :
    msg.type === "exit" ? `Exit: ${msg.code}` :
    msg.data ?? "";

  return <div className={cls}>{renderHighlighted(content, highlight)}</div>;
}

function renderHighlighted(text: string, query: string) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={idx} className="bg-violet-500/40 text-zinc-100 rounded-sm px-0.5">
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    i = idx + q.length;
  }
  return parts;
}

function matchType(m: WsMessage, t: LogTypeFilter): boolean {
  switch (m.type) {
    case "stdout": return t.stdout;
    case "stderr": return t.stderr;
    case "step":   return t.step;
    case "error":  return t.error;
    case "exit":   return t.exit;
    default:       return true; // init / meta — show as-is.
  }
}

function isMessageError(m: WsMessage): boolean {
  if (m.type === "error") return true;
  if (m.type === "stderr") return isErrorLine(m.data ?? "");
  if (m.type === "exit") return (m.code ?? 0) !== 0;
  return false;
}

function countByType(logs: WsMessage[]) {
  const c = { stdout: 0, stderr: 0, step: 0, error: 0, exit: 0 };
  for (const m of logs) {
    if (m.type in c) (c as Record<string, number>)[m.type]++;
  }
  return c;
}
