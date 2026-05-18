import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { Layout, PageHeader } from "@/components/Layout";
import { Badge } from "@/components/ui/badge";
import { createTerminalSocket, type TerminalControl } from "@/lib/ws";
import { TerminalSquare, AlertCircle } from "lucide-react";

type Status = "connecting" | "ready" | "error" | "closed";

export default function TerminalPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [containerName, setContainerName] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#a78bfa",
        cursorAccent: "#09090b",
        selectionBackground: "#3f3f46",
        black: "#18181b",
        brightBlack: "#52525b",
        red: "#f87171",
        brightRed: "#fca5a5",
        green: "#4ade80",
        brightGreen: "#86efac",
        yellow: "#fbbf24",
        brightYellow: "#fcd34d",
        blue: "#60a5fa",
        brightBlue: "#93c5fd",
        magenta: "#c084fc",
        brightMagenta: "#d8b4fe",
        cyan: "#22d3ee",
        brightCyan: "#67e8f9",
        white: "#e4e4e7",
        brightWhite: "#fafafa",
      },
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      // container not yet sized; the ResizeObserver below will catch up
    }
    termRef.current = term;
    fitRef.current = fit;

    const decoder = new TextDecoder();
    const ws = createTerminalSocket(
      (bytes) => {
        // xterm.write also accepts Uint8Array directly, but routing through a
        // TextDecoder gives us cleaner behavior for partial UTF-8 sequences
        // arriving across frame boundaries.
        term.write(decoder.decode(bytes, { stream: true }));
      },
      (msg: TerminalControl) => {
        if (msg.type === "ready") {
          setStatus("ready");
          setContainerName(msg.container ?? null);
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          term.focus();
        } else if (msg.type === "error") {
          setErrorMsg(msg.data ?? "terminal error");
          setStatus("error");
        } else if (msg.type === "timeout") {
          setErrorMsg("Idle for 30 minutes — session closed.");
        }
      },
      () => {
        setStatus((prev) => (prev === "error" ? prev : "closed"));
      },
    );
    wsRef.current = ws;

    const dataDisposable = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data: d }));
      }
    });

    let lastCols = term.cols;
    let lastRows = term.rows;
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      }
    });
    ro.observe(containerRef.current);

    return () => {
      dataDisposable.dispose();
      ro.disconnect();
      try {
        ws.close();
      } catch {
        // already closed
      }
      term.dispose();
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  return (
    <Layout>
      <PageHeader
        title="Terminal"
        description="Ephemeral runner shell — closes when you leave the page."
        action={
          <div className="flex items-center gap-2">
            <StatusBadge status={status} />
            {containerName && (
              <span className="text-xs text-zinc-500 font-mono truncate max-w-[280px]" title={containerName}>
                {containerName}
              </span>
            )}
          </div>
        }
      />

      {errorMsg && (
        <div className="mx-8 mt-4 flex items-start gap-2 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="flex flex-col px-8 py-4 h-[calc(100vh-85px)]">
        <div className="flex items-center justify-between mb-2 text-xs text-zinc-500">
          <span className="flex items-center gap-1.5">
            <TerminalSquare className="h-3.5 w-3.5" />
            <code>/storage</code> is yours; <code>/shared</code> is visible to all users.
          </span>
          <span>30 min idle timeout</span>
        </div>
        <div className="flex-1 min-h-0 rounded-lg border border-zinc-800 bg-[#09090b] overflow-hidden">
          <div ref={containerRef} className="h-full w-full p-2" />
        </div>
      </div>
    </Layout>
  );
}

function StatusBadge({ status }: { status: Status }) {
  if (status === "connecting") return <Badge variant="warning">Connecting…</Badge>;
  if (status === "ready") return <Badge variant="success">Connected</Badge>;
  if (status === "error") return <Badge variant="error">Error</Badge>;
  return <Badge variant="default">Disconnected</Badge>;
}
