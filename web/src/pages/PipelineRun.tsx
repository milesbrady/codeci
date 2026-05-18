import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { pipelinesApi, runsApi, type Pipeline } from "@/lib/api";
import { createExecSocket, type WsMessage, type WsExitInfo } from "@/lib/ws";
import { Layout, PageHeader } from "@/components/Layout";
import { DynamicForm } from "@/components/DynamicForm";
import { StepTracker } from "@/components/StepTracker";
import { FailureSummary } from "@/components/FailureSummary";
import { LogViewerModal } from "@/components/LogViewerModal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, RotateCcw, Edit2, Trash2, Maximize2, Webhook } from "lucide-react";
import { useAuthStore } from "@/store/auth";

/** rAF-batched message buffer; mirrors useBatchedLogs in RunDetail. */
function useBatchedMessages() {
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const buffer = useRef<WsMessage[]>([]);
  const rafId = useRef<number | null>(null);

  const flush = useCallback(() => {
    rafId.current = null;
    if (buffer.current.length === 0) return;
    const pending = buffer.current;
    buffer.current = [];
    setMessages((prev) => prev.concat(pending));
  }, []);

  const append = useCallback((msg: WsMessage) => {
    buffer.current.push(msg);
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(flush);
    }
  }, [flush]);

  const reset = useCallback(() => {
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    buffer.current = [];
    setMessages([]);
  }, []);

  useEffect(() => () => {
    if (rafId.current != null) cancelAnimationFrame(rafId.current);
  }, []);

  return { messages, append, reset };
}

export function PipelineRun() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [loadingPipeline, setLoadingPipeline] = useState(true);
  const { messages, append, reset } = useBatchedMessages();
  const [running, setRunning] = useState(false);
  const [queuedNotice, setQueuedNotice] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeRunsCount, setActiveRunsCount] = useState(0);
  const [currentRunId, setCurrentRunId] = useState<number | null>(null);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const loadPipeline = async () => {
      try {
        const res = await pipelinesApi.get(id);
        if (!cancelled) setPipeline(res.data);
      } catch (err) {
        console.error("Failed to load pipeline", err);
      } finally {
        if (!cancelled) setLoadingPipeline(false);
      }
    };
    const checkActiveRuns = async () => {
      try {
        const res = await runsApi.list();
        if (cancelled) return;
        const active = res.data.filter(r => r.PipelineID === id && (r.Status === "running" || r.Status === "queued"));
        setActiveRunsCount(active.length);
      } catch (err) {
        console.error("Failed to check active runs", err);
      }
    };

    loadPipeline();
    checkActiveRuns();

    const interval = setInterval(checkActiveRuns, 5000);
    return () => {
      cancelled = true;
      wsRef.current?.close();
      clearInterval(interval);
    };
  }, [id]);

  async function checkActiveRunsNow() {
    if (!id) return;
    try {
      const res = await runsApi.list();
      const active = res.data.filter(r => r.PipelineID === id && (r.Status === "running" || r.Status === "queued"));
      setActiveRunsCount(active.length);
    } catch {
      // silent — interval will retry
    }
  }

  async function handleDelete() {
    if (!id) return;
    if (!confirm("Are you sure you want to delete this pipeline? This cannot be undone.")) return;
    setIsDeleting(true);
    try {
      await pipelinesApi.delete(id);
      navigate("/pipelines");
    } catch (err: any) {
      alert(err.response?.data?.message || "Failed to delete pipeline");
      setIsDeleting(false);
    }
  }

  function handleRun(params: Record<string, string>) {
    if (!id || running) return;
    reset();
    setExitCode(null);
    setQueuedNotice(null);
    setRunning(true);
    setCurrentRunId(null);
    setActiveRunsCount(prev => prev + 1);

    const ws = createExecSocket(
      id,
      params,
      (msg) => {
        if (msg.type === "init" && msg.run_id) {
          setCurrentRunId(msg.run_id);
        }
        if (msg.type === "queued") {
          setQueuedNotice(msg.data || "Queued — waiting for an open slot.");
          return;
        }
        // First non-queued message after a queued notice means the run was
        // dispatched. Clear the banner so the step tracker takes over.
        if (queuedNotice && msg.type !== "init") {
          setQueuedNotice(null);
        }
        append(msg);
        if (msg.type === "exit") {
          setExitCode(msg.code ?? 0);
          setRunning(false);
          checkActiveRunsNow();
        }
        if (msg.type === "error") {
          setRunning(false);
          checkActiveRunsNow();
        }
      },
      () => {
        setRunning(false);
        setQueuedNotice(null);
        checkActiveRunsNow();
      },
      undefined,
      // onOpen: clear stale state before any backlog arrives
      () => reset(),
    );
    wsRef.current = ws;
  }

  async function handleAbort() {
    if (currentRunId) {
      try {
        await runsApi.cancel(currentRunId);
      } catch (err) {
        console.error("Failed to cancel run via API", err);
      }
    }

    wsRef.current?.close();
    setRunning(false);
    append({ type: "error", data: "Execution aborted by user.\n" });
    checkActiveRunsNow();
  }

  function handleReset() {
    reset();
    setExitCode(null);
  }

  // Pull structured failure info if any.
  const exitInfo = useMemo<WsExitInfo | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === "exit" && messages[i].exit_info) return messages[i].exit_info!;
    }
    return null;
  }, [messages]);

  const statusBadge = () => {
    if (queuedNotice) return <Badge variant="warning">Queued</Badge>;
    if (running) return <Badge variant="running">Running</Badge>;
    if (exitCode === null) return null;
    if (exitCode === 0) return <Badge variant="success">Success</Badge>;
    return <Badge variant="error">Failed (exit {exitCode})</Badge>;
  };

  return (
    <Layout>
      <PageHeader
        title={pipeline?.name ?? (loadingPipeline ? "Loading…" : "Pipeline")}
        description={pipeline?.description}
        action={
          <>
            {statusBadge()}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLogViewerOpen(true)}
              disabled={messages.length === 0 && !running}
              title="Open logs in a large popup with filter and tail"
            >
              <Maximize2 className="h-3.5 w-3.5 mr-1.5" />
              Logs
            </Button>
            <Button variant="ghost" size="sm" onClick={() => id && navigate(`/pipelines/${id}/edit`)}>
              <Edit2 className="h-4 w-4 mr-1.5" />
              Edit
            </Button>
            {isAdmin && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => id && navigate(`/pipelines/${id}/trigger`)}
                title="Configure a GitHub or manual trigger for this pipeline"
              >
                <Webhook className="h-4 w-4 mr-1.5" />
                Trigger
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-red-400 hover:text-red-300 hover:bg-red-400/10"
              onClick={handleDelete}
              disabled={activeRunsCount > 0 || running || isDeleting}
              title={activeRunsCount > 0 ? "Cannot delete while jobs are running" : ""}
            >
              <Trash2 className="h-4 w-4 mr-1.5" />
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate("/pipelines")}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
          </>
        }
      />

      <div className="flex flex-col md:flex-row gap-4 md:gap-6 p-4 md:p-8 md:h-[calc(100vh-85px)]">
        {/* Left: Form */}
        <div className="w-full md:w-96 flex-shrink-0 md:overflow-y-auto">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
                <h2 className="text-sm font-semibold text-zinc-300 mb-4">Parameters</h2>
                {loadingPipeline ? (
                  <div className="space-y-4">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-10 rounded-md bg-zinc-800 animate-pulse" />
                    ))}
                  </div>
                ) : pipeline ? (
                  <>
                    <DynamicForm
                      parameters={pipeline.parameters}
                      onSubmit={handleRun}
                      loading={running}
                    />

                    {running && (
                      <Button
                        variant="destructive"
                        size="sm"
                        className="w-full mt-3"
                        onClick={handleAbort}
                      >
                        Abort
                      </Button>
                    )}
                    {!running && messages.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full mt-3"
                        onClick={handleReset}
                      >
                        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                        Clear &amp; Reset
                      </Button>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-red-400">Failed to load pipeline.</p>
                )}
              </div>
            </div>

            {/* Right: Animated step tracker (with optional failure banner) */}
            <div className="flex-1 min-w-0 flex flex-col gap-4 min-h-[60vh] md:min-h-0 md:overflow-hidden">
              {queuedNotice && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  <div className="font-semibold">Queued</div>
                  <div className="text-amber-200/80 mt-0.5">{queuedNotice}</div>
                  <div className="text-amber-200/60 text-xs mt-2">
                    Your run will start automatically when another instance of this pipeline finishes.
                  </div>
                </div>
              )}
              {exitInfo && exitInfo.code !== 0 && (
                <FailureSummary exitInfo={exitInfo} />
              )}
              <div className="flex-1 min-h-0 rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                {loadingPipeline ? (
                  <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
                    Loading pipeline…
                  </div>
                ) : pipeline ? (
                  <StepTracker
                    steps={pipeline.steps}
                    messages={messages}
                    running={running}
                  />
                ) : null}
              </div>
            </div>
      </div>

      <LogViewerModal
        logs={messages}
        open={logViewerOpen}
        onClose={() => setLogViewerOpen(false)}
        running={running}
      />
    </Layout>
  );
}
