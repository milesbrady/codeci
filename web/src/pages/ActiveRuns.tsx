import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { runsApi, type ExecutionRun } from "@/lib/api";
import { Layout, PageHeader } from "@/components/Layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatElapsed } from "@/lib/utils";
import { ChevronRight, Activity, StopCircle } from "lucide-react";

function elapsed(start: string): string {
  return formatElapsed(Date.now() - new Date(start).getTime());
}

export function ActiveRuns() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);
  const [cancelling, setCancelling] = useState<Set<number>>(new Set());
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const fetchActive = async () => {
      try {
        const res = await runsApi.listActive();
        if (cancelledRef.current) return;
        setRuns(res.data);
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    };

    let pollId: number | null = null;
    let tickId: number | null = null;

    const start = () => {
      if (pollId == null) {
        fetchActive();
        pollId = window.setInterval(fetchActive, 3000);
      }
      if (tickId == null) {
        tickId = window.setInterval(() => setTick((t) => t + 1), 1000);
      }
    };
    const stop = () => {
      if (pollId != null) { clearInterval(pollId); pollId = null; }
      if (tickId != null) { clearInterval(tickId); tickId = null; }
    };

    // Pause polling when the tab is hidden — saves cycles and avoids a
    // thundering-herd of stale fetches when the user comes back.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    start();
    return () => {
      cancelledRef.current = true;
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, []);

  async function handleStop(e: React.MouseEvent, runId: number) {
    e.stopPropagation();
    setCancelling((prev) => new Set(prev).add(runId));
    try {
      await runsApi.cancel(runId);
      // Optimistically remove from list; poll will confirm
      setRuns((prev) => prev.filter((r) => r.ID !== runId));
    } catch {
      // If it fails, the poll will refresh the list
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    }
  }

  return (
    <Layout>
      <PageHeader
        title="Active Runs"
        description="Pipelines currently executing — click any row to watch live logs"
      />
      <div className="p-4 md:p-8">
        {loading && (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-14 rounded-lg bg-zinc-900/60 border border-zinc-800 animate-pulse"
              />
            ))}
          </div>
        )}

        {!loading && runs.length === 0 && (
          <div className="flex flex-col items-center py-24 text-center">
            <div className="h-16 w-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
              <Activity className="h-7 w-7 text-zinc-600" />
            </div>
            <h3 className="text-lg font-medium text-zinc-300">No active runs</h3>
            <p className="text-sm text-zinc-500 mt-1">
              Start a pipeline to see it here. Running and queued pipelines both appear in this list.
            </p>
          </div>
        )}

        {!loading && runs.length > 0 && (
          <>
          {/* Mobile: card list */}
          <div className="md:hidden flex flex-col gap-2">
            {runs.map((run) => (
              <div
                key={run.ID}
                onClick={() => navigate(`/runs/${run.ID}`)}
                className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 cursor-pointer hover:border-violet-700/50 hover:bg-zinc-900 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm text-zinc-200 truncate">{run.PipelineName}</p>
                    <p className="text-[11px] text-zinc-500 truncate">{run.PipelineID}</p>
                  </div>
                  <Badge variant={run.Status === "queued" ? "warning" : "running"}>{run.Status}</Badge>
                </div>
                <div className="flex items-center justify-between mt-2 text-xs">
                  <div className="text-zinc-400 truncate">
                    <span className="text-zinc-500">by </span>
                    {run.UserName || "—"}
                  </div>
                  <span className="font-mono text-violet-400">{elapsed(run.StartedAt)}</span>
                </div>
                <div
                  className="flex justify-end mt-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    size="sm"
                    variant="destructive"
                    loading={cancelling.has(run.ID)}
                    onClick={(e) => handleStop(e, run.ID)}
                  >
                    <StopCircle className="h-3.5 w-3.5 mr-1" />
                    Stop
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop: table */}
          <div className="hidden md:block rounded-xl border border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/80">
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">Pipeline</th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">Started by</th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">Started</th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">Elapsed</th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">Actions</th>
                  <th className="px-4 py-3 w-8" />
                </tr>
              </thead>
              <tbody>
                {runs.map((run, i) => (
                  <tr
                    key={run.ID}
                    onClick={() => navigate(`/runs/${run.ID}`)}
                    className={`border-b border-zinc-800/50 cursor-pointer hover:bg-zinc-800/50 transition-colors group ${
                      i === runs.length - 1 ? "border-b-0" : ""
                    }`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-zinc-200 group-hover:text-white transition-colors">
                        {run.PipelineName}
                      </p>
                      <p className="text-xs text-zinc-500">{run.PipelineID}</p>
                    </td>
                    <td className="px-4 py-3 text-zinc-400 text-xs">
                      {run.UserName || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={run.Status === "queued" ? "warning" : "running"}>{run.Status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-zinc-400">
                      {new Date(run.StartedAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-violet-400 font-mono text-xs">
                      {elapsed(run.StartedAt)}
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        variant="destructive"
                        loading={cancelling.has(run.ID)}
                        onClick={(e) => handleStop(e, run.ID)}
                        title="Force stop this run"
                      >
                        <StopCircle className="h-3.5 w-3.5 mr-1" />
                        Stop
                      </Button>
                    </td>
                    <td className="px-4 py-3">
                      <ChevronRight className="h-4 w-4 text-zinc-600 group-hover:text-zinc-300 transition-colors" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </Layout>
  );
}
