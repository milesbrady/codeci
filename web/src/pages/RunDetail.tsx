import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { runsApi, pipelinesApi, type ExecutionRun, type Pipeline } from "@/lib/api";
import { createExecSocket, type WsMessage, type WsExitInfo } from "@/lib/ws";
import { Layout, PageHeader } from "@/components/Layout";
import { isErrorLine, formatElapsed } from "@/lib/utils";
import { StepTracker } from "@/components/StepTracker";
import { FailureSummary } from "@/components/FailureSummary";
import { LogViewerModal } from "@/components/LogViewerModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Play, Clock, Calendar, StopCircle, Loader2, Maximize2 } from "lucide-react";


function statusVariant(status: string): "success" | "error" | "running" | "warning" | "default" {
  switch (status) {
    case "success":    return "success";
    case "failed":     return "error";
    case "running":    return "running";
    case "queued":     return "warning";
    case "superseded": return "default";
    default:           return "warning";
  }
}

function fmtDate(d?: string) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function duration(start?: string, end?: string) {
  if (!start) return "—";
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  return formatElapsed(endMs - startMs);
}

/**
 * useBatchedLogs collects WS messages into a buffer and flushes them to React
 * state on the next animation frame. This caps log-driven re-renders to ~60
 * per second even when the server is pushing thousands of lines per second.
 */
function useBatchedLogs() {
  const [logs, setLogs] = useState<WsMessage[]>([]);
  const buffer = useRef<WsMessage[]>([]);
  const rafId = useRef<number | null>(null);

  const flush = useCallback(() => {
    rafId.current = null;
    if (buffer.current.length === 0) return;
    const pending = buffer.current;
    buffer.current = [];
    setLogs((prev) => prev.concat(pending));
  }, []);

  const append = useCallback((msg: WsMessage) => {
    buffer.current.push(msg);
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(flush);
    }
  }, [flush]);

  const reset = useCallback((next: WsMessage[] = []) => {
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    buffer.current = [];
    setLogs(next);
  }, []);

  useEffect(() => {
    return () => {
      if (rafId.current != null) cancelAnimationFrame(rafId.current);
    };
  }, []);

  return { logs, append, reset };
}

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<ExecutionRun | null>(null);
  const { logs, append, reset } = useBatchedLogs();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [queuedNotice, setQueuedNotice] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [, setTick] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  // Keep elapsed time live for in-flight runs.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (!id) return;
    const runId = Number(id);
    let cancelled = false;
    // Becomes true once we've received a terminal `exit` or server-side
    // `error` for this run — i.e. the connection close that follows is
    // expected, and we must not try to reconnect.
    let terminal = false;
    let reconnectTimer: number | null = null;

    function clearReconnectTimer() {
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function connect(pipelineID: string) {
      const ws = createExecSocket(
        pipelineID,
        {},
        (msg) => {
          if (cancelled) return;
          // Any message means the connection is healthy; React bails out
          // cheaply if the state is already false.
          setReconnecting(false);
          if (msg.type === "queued") {
            setQueuedNotice(msg.data || "Queued — waiting for an open slot.");
            return;
          }
          // Once the server emits a non-queued message after a queued banner
          // we know the run has been promoted and is now executing.
          if (msg.type !== "init") {
            setQueuedNotice((prev) => (prev ? null : prev));
          }
          if (msg.type === "exit") {
            terminal = true;
            setRunning(false);
            // Optimistically flip the local run record so the Stop
            // button disappears immediately. The DB write happens just
            // after the broadcast on the server, so a refetch here can
            // race ahead of it; we trust msg.code, then reconcile.
            const finishedAt = new Date(msg.time ?? Date.now()).toISOString();
            setRun((prev) => prev ? {
              ...prev,
              Status: (msg.code ?? 0) === 0 ? "success" : "failed",
              FinishedAt: finishedAt,
            } : prev);
            window.setTimeout(() => {
              if (cancelled) return;
              runsApi.get(runId)
                .then((r) => { if (!cancelled) setRun(r.data); })
                .catch(() => {});
            }, 800);
          } else if (msg.type === "error") {
            // Server reported a non-recoverable state (e.g. "run no longer
            // in memory" after a server restart). Don't reconnect; fall
            // back to the DB log path so the user still sees what we have.
            terminal = true;
            setRunning(false);
            runsApi.getLogs(runId)
              .then((r) => { if (!cancelled) reset(r.data ?? []); })
              .catch(() => {});
            runsApi.get(runId)
              .then((r) => { if (!cancelled) setRun(r.data); })
              .catch(() => {});
          }
          append(msg);
        },
        () => {
          // onClose. If the run is still in flight from our perspective,
          // try to re-attach. The server's re-attach path replays the
          // full in-memory backlog so we won't miss output.
          if (cancelled || terminal) return;
          setReconnecting(true);
          clearReconnectTimer();
          reconnectTimer = window.setTimeout(async () => {
            if (cancelled || terminal) return;
            // Confirm the run is still running before reattaching. If it
            // finished while we were disconnected, switch to the DB-logs
            // view instead of looping on a now-stale re-attach.
            try {
              const r = await runsApi.get(runId);
              if (cancelled) return;
              setRun(r.data);
              if (r.data.Status === "running" || r.data.Status === "queued") {
                wsRef.current = connect(pipelineID);
              } else {
                terminal = true;
                setRunning(false);
                setReconnecting(false);
                setQueuedNotice(null);
                const lr = await runsApi.getLogs(runId);
                if (!cancelled) reset(lr.data ?? []);
              }
            } catch {
              if (cancelled || terminal) return;
              // Transient network failure — retry with the same backoff.
              reconnectTimer = window.setTimeout(() => {
                if (!cancelled && !terminal) wsRef.current = connect(pipelineID);
              }, 3000);
            }
          }, 1500);
        },
        runId,
        () => { if (!cancelled) reset([]); }, // clear before backlog arrives
      );
      return ws;
    }

    (async () => {
      try {
        const runRes = await runsApi.get(runId);
        if (cancelled) return;
        const runData = runRes.data;
        setRun(runData);

        if (runData.Status === "running" || runData.Status === "queued") {
          setRunning(true);
          if (runData.Status === "queued") {
            setQueuedNotice("Queued — waiting for an open slot.");
          }
          wsRef.current = connect(runData.PipelineID);
        } else {
          // Completed run: load logs from DB
          const logsRes = await runsApi.getLogs(runId);
          if (!cancelled) reset(logsRes.data ?? []);
        }

        // Load pipeline definition for StepTracker (best-effort)
        try {
          const pRes = await pipelinesApi.get(runData.PipelineID);
          if (!cancelled) setPipeline(pRes.data);
        } catch {
          // Pipeline YAML may have been renamed/deleted — raw log fallback renders
        }
      } catch {
        // Run not found or network error — degrade gracefully
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      wsRef.current?.close();
    };
  }, [id, append, reset]);

  const params = useMemo(() => {
    try { return JSON.parse(run?.ParamsJSON ?? "{}") as Record<string, string>; }
    catch { return {}; }
  }, [run?.ParamsJSON]);

  // Pull structured failure info from the most recent exit message, if any.
  const exitInfo = useMemo<WsExitInfo | null>(() => {
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i].type === "exit" && logs[i].exit_info) return logs[i].exit_info!;
    }
    return null;
  }, [logs]);

  function handleRerun() {
    if (run) navigate(`/pipelines/${run.PipelineID}`);
  }

  async function handleStop() {
    if (!run) return;
    setStopping(true);
    try {
      await runsApi.cancel(run.ID);
    } catch {
      // ignore; the run will eventually finish
    } finally {
      setStopping(false);
    }
  }

  return (
    <Layout>
      <PageHeader
        title={run?.PipelineName ?? (loading ? "Loading…" : "Run Detail")}
        description={`Run #${id}`}
        action={
          <>
            {run && <Badge variant={statusVariant(run.Status)}>{run.Status}</Badge>}
            {run && (run.Status === "running" || running) && (
              <span className="text-xs text-zinc-500 font-mono">
                {duration(run.StartedAt, run.FinishedAt)}
              </span>
            )}
            {reconnecting && (
              <span className="inline-flex items-center gap-1.5 text-xs text-amber-300 bg-amber-950/40 border border-amber-800 rounded-full px-2 py-0.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Reconnecting…
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setLogViewerOpen(true)}
              disabled={logs.length === 0 && !running}
              title="Open logs in a large popup with filter and tail"
            >
              <Maximize2 className="h-3.5 w-3.5 mr-1.5" />
              Logs
            </Button>
            {run && (run.Status === "running" || run.Status === "queued") && (
              <Button size="sm" variant="destructive" onClick={handleStop} loading={stopping}>
                <StopCircle className="h-3.5 w-3.5 mr-1.5" />
                {run.Status === "queued" ? "Cancel" : "Stop"}
              </Button>
            )}
            {run && run.Status !== "running" && run.Status !== "queued" && (
              <Button size="sm" onClick={handleRerun}>
                <Play className="h-3.5 w-3.5 mr-1.5" />
                Re-run
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
          </>
        }
      />

      <div className="flex flex-col md:flex-row gap-4 md:gap-6 p-4 md:p-8 md:h-[calc(100vh-85px)]">
        {/* Left: metadata */}
        <div className="w-full md:w-72 flex-shrink-0 space-y-4 md:overflow-y-auto">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Run Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-zinc-500" />
                <div>
                  <p className="text-zinc-500 text-xs">Started</p>
                  <p className="text-zinc-200">{fmtDate(run?.StartedAt)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-zinc-500" />
                <div>
                  <p className="text-zinc-500 text-xs">Duration</p>
                  <p className="text-zinc-200 font-mono">{duration(run?.StartedAt, run?.FinishedAt)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {Object.keys(params).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Parameters Used</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {Object.entries(params).map(([key, val]) => (
                  <div key={key}>
                    <p className="text-xs text-zinc-500">{key}</p>
                    <p className="text-sm text-zinc-200 font-mono break-all">{String(val) || <span className="text-zinc-600 italic">empty</span>}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {loading && (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded-xl bg-zinc-900/60 border border-zinc-800 animate-pulse" />
              ))}
            </div>
          )}
        </div>

        {/* Right: failure summary + step replay / live stream */}
        <div className="flex-1 min-w-0 flex flex-col gap-4 min-h-[60vh] md:min-h-0 md:overflow-hidden">
          {queuedNotice && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              <div className="font-semibold">Queued</div>
              <div className="text-amber-200/80 mt-0.5">{queuedNotice}</div>
              <div className="text-amber-200/60 text-xs mt-2">
                This run will start automatically when another instance of this pipeline finishes.
              </div>
            </div>
          )}
          {exitInfo && exitInfo.code !== 0 && (
            <FailureSummary exitInfo={exitInfo} />
          )}

          <div className="flex-1 min-h-0 rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
                {run?.Status === "running" ? "Connecting to live stream…" : "Loading logs…"}
              </div>
            ) : pipeline ? (
              <StepTracker
                steps={pipeline.steps}
                messages={logs}
                running={running}
                defaultExpanded={true}
              />
            ) : (
              /* Pipeline definition gone — show raw logs fallback */
              <div className="p-6 font-mono text-xs space-y-0.5 overflow-y-auto h-full">
                {logs.length === 0 && running && (
                  <p className="text-zinc-500 italic">Waiting for output…</p>
                )}
                {logs.map((msg, i) => (
                  <div
                    key={msg.seq ?? i}
                    className={
                      msg.type === "step"   ? "text-cyan-400 font-semibold mt-3" :
                      msg.type === "stdout" ? "text-emerald-400" :
                      msg.type === "stderr" ? (isErrorLine(msg.data ?? "") ? "text-red-400" : "text-amber-400") :
                      msg.type === "error"  ? "text-red-500 font-semibold" :
                      "text-zinc-500 italic"
                    }
                  >
                    {msg.type === "step" ? `▶ ${msg.data}` :
                     msg.type === "exit" ? `Exit: ${msg.code}` :
                     msg.data}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <LogViewerModal
        logs={logs}
        open={logViewerOpen}
        onClose={() => setLogViewerOpen(false)}
        running={running}
      />
    </Layout>
  );
}
