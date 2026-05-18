import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import { type WsMessage } from "@/lib/ws";
import { cn, isErrorLine } from "@/lib/utils";

interface LogTerminalProps {
  messages: WsMessage[];
  running: boolean;
}

// Single uniform row height keeps virtualization cheap. Long lines scroll
// horizontally instead of wrapping; users can toggle wrap via the header.
const ROW_HEIGHT = 18;
const VIRTUALIZATION_THRESHOLD = 200;

function lineClass(type: WsMessage["type"], data?: string) {
  switch (type) {
    case "step":   return "text-cyan-400 font-semibold";
    case "stdout": return "text-emerald-400";
    case "stderr": return isErrorLine(data ?? "") ? "text-red-400" : "text-amber-400";
    case "error":  return "text-red-500 font-semibold";
    case "exit":   return "text-zinc-400 italic";
    case "meta":   return "text-violet-400 italic";
    default:       return "text-zinc-300";
  }
}

function formatLine(msg: WsMessage): string {
  switch (msg.type) {
    case "step":  return `▶ ${msg.data}`;
    case "exit":  return msg.code === 0 ? "✓ Completed successfully" : `✗ Exited with code ${msg.code}`;
    case "meta":  {
      if (!msg.meta) return "";
      // Compact summary so users see the key facts inline.
      const interesting = ["build_id", "phase", "console_url"];
      return interesting.filter(k => msg.meta?.[k]).map(k => `${k}=${msg.meta?.[k]}`).join(" ");
    }
    default:      return (msg.data ?? "").replace(/\n$/, "");
  }
}

interface RowData {
  messages: WsMessage[];
  wrap: boolean;
}

const Row = memo(function Row({ index, style, data }: ListChildComponentProps<RowData>) {
  const msg = data.messages[index];
  return (
    <div
      style={style}
      className={cn(
        "font-mono text-xs leading-[18px] px-4",
        data.wrap ? "whitespace-pre-wrap break-all" : "whitespace-nowrap",
        lineClass(msg.type, msg.data),
      )}
    >
      {formatLine(msg)}
    </div>
  );
});

export function LogTerminal({ messages, running }: LogTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<FixedSizeList<RowData>>(null);
  const autoScroll = useRef(true);
  const [wrap, setWrap] = useState(() =>
    typeof window !== "undefined" && window.innerWidth < 768
  );
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Measure container; ResizeObserver keeps us in sync with window resizes
  // without a layout pass on every render.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Auto-scroll on new messages, but only if user hasn't scrolled up.
  useEffect(() => {
    if (!autoScroll.current) return;
    if (messages.length === 0) return;
    listRef.current?.scrollToItem(messages.length - 1, "end");
  }, [messages.length]);

  const handleScroll = useCallback(({ scrollOffset, scrollDirection }: { scrollOffset: number; scrollDirection: "forward" | "backward" }) => {
    if (!listRef.current) return;
    const totalHeight = messages.length * ROW_HEIGHT;
    const viewport = size.h;
    const atBottom = totalHeight - scrollOffset - viewport < ROW_HEIGHT * 2;
    if (scrollDirection === "backward") {
      autoScroll.current = atBottom;
    } else if (atBottom) {
      autoScroll.current = true;
    }
  }, [messages.length, size.h]);

  const copyLogs = useCallback(() => {
    const text = messages.map((m) => formatLine(m)).join("\n");
    navigator.clipboard.writeText(text);
  }, [messages]);

  const itemKey = useCallback((index: number, data: RowData) => {
    const m = data.messages[index];
    return m.seq ?? index;
  }, []);

  const rowData = useMemo<RowData>(() => ({ messages, wrap }), [messages, wrap]);

  const useVirtual = messages.length > VIRTUALIZATION_THRESHOLD;

  return (
    <div className="flex flex-col h-full rounded-xl border border-zinc-800 overflow-hidden bg-zinc-950">
      {/* Terminal header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/80">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="h-3 w-3 rounded-full bg-red-500/80" />
            <div className="h-3 w-3 rounded-full bg-amber-500/80" />
            <div className="h-3 w-3 rounded-full bg-emerald-500/80" />
          </div>
          <span className="text-xs text-zinc-500 font-mono ml-2">
            execution log{messages.length > 0 ? ` · ${messages.length} lines` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {running && (
            <span className="flex items-center gap-1.5 text-xs text-blue-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              Running
            </span>
          )}
          <button
            onClick={() => setWrap((w) => !w)}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1 rounded hover:bg-zinc-800"
            title={wrap ? "Disable line wrapping" : "Enable line wrapping"}
          >
            {wrap ? "Wrap: on" : "Wrap: off"}
          </button>
          <button
            onClick={copyLogs}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1 rounded hover:bg-zinc-800"
          >
            Copy
          </button>
        </div>
      </div>

      {/* Log body */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden">
        {messages.length === 0 ? (
          <p className="absolute inset-0 flex items-center justify-center text-zinc-600 italic text-xs">
            Waiting for execution to start…
          </p>
        ) : useVirtual && size.h > 0 ? (
          <FixedSizeList<RowData>
            ref={listRef}
            height={size.h}
            width={size.w}
            itemCount={messages.length}
            itemSize={ROW_HEIGHT}
            itemData={rowData}
            itemKey={itemKey}
            onScroll={handleScroll}
            overscanCount={20}
          >
            {Row}
          </FixedSizeList>
        ) : (
          <div className="absolute inset-0 overflow-y-auto py-2">
            {messages.map((msg, i) => (
              <div
                key={msg.seq ?? i}
                className={cn(
                  "font-mono text-xs leading-[18px] px-4",
                  wrap ? "whitespace-pre-wrap break-all" : "whitespace-nowrap",
                  lineClass(msg.type, msg.data),
                )}
              >
                {formatLine(msg)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
