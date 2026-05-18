import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { runsApi, type ExecutionRun } from "@/lib/api";
import { Layout, PageHeader } from "@/components/Layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatElapsed } from "@/lib/utils";
import { History, ChevronRight, Search, Trash2, AlertTriangle, ChevronLeft } from "lucide-react";

const PAGE_SIZE_KEY = "runHistory.pageSize";
const DEFAULT_PAGE_SIZE = 25;

function getPageSize(): number {
  const v = localStorage.getItem(PAGE_SIZE_KEY);
  const n = v ? parseInt(v, 10) : NaN;
  return isNaN(n) || n < 1 ? DEFAULT_PAGE_SIZE : n;
}

function statusVariant(status: string): "success" | "error" | "running" | "warning" | "default" {
  switch (status) {
    case "success":    return "success";
    case "failed":     return "error";
    case "running":    return "running";
    case "superseded": return "default";
    default:           return "warning";
  }
}

function fmtDate(d: string) {
  return new Date(d).toLocaleString();
}

function duration(start: string, end?: string) {
  if (!end) return "—";
  return formatElapsed(new Date(end).getTime() - new Date(start).getTime());
}

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  loading,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-zinc-200">{message}</p>
        </div>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} loading={loading}>
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RunHistory() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(getPageSize);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<ExecutionRun | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchPage = useCallback((p: number) => {
    setLoading(true);
    runsApi.listPaginated(p, pageSize)
      .then((res) => {
        // Filter out running and queued runs — those belong in Active Runs
        const completed = res.data.runs.filter((r) => r.Status !== "running" && r.Status !== "queued");
        setRuns(completed);
        setTotal(res.data.total);
        setPages(res.data.pages);
      })
      .finally(() => setLoading(false));
  }, [pageSize]);

  useEffect(() => { fetchPage(page); }, [fetchPage, page]);

  const filtered = runs.filter((r) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      r.PipelineName.toLowerCase().includes(q) ||
      r.PipelineID.toLowerCase().includes(q) ||
      r.Status.toLowerCase().includes(q)
    );
  });

  async function handleDelete(run: ExecutionRun) {
    setActionLoading(true);
    try {
      await runsApi.delete(run.ID);
      setConfirmDelete(null);
      fetchPage(page);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleClearAll() {
    setActionLoading(true);
    try {
      await runsApi.clearAll();
      setConfirmClearAll(false);
      setPage(1);
      fetchPage(1);
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <Layout>
      <PageHeader
        title="Run History"
        description="Completed pipeline executions — click any row to view logs"
        action={
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmClearAll(true)}
            disabled={runs.length === 0}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Clear All
          </Button>
        }
      />
      <div className="p-4 md:p-8">
        <div className="relative mb-6 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            placeholder="Search by pipeline or status…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 pl-9 pr-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-violet-600 focus:border-violet-600 transition-colors"
          />
        </div>

        {loading && (
          <div className="space-y-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-14 rounded-lg bg-zinc-900/60 border border-zinc-800 animate-pulse" />
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center py-24 text-center">
            <div className="h-16 w-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
              {query ? (
                <Search className="h-7 w-7 text-zinc-600" />
              ) : (
                <History className="h-7 w-7 text-zinc-600" />
              )}
            </div>
            {query ? (
              <>
                <h3 className="text-lg font-medium text-zinc-300">No matches for "{query}"</h3>
                <p className="text-sm text-zinc-500 mt-1">Try a different search term.</p>
              </>
            ) : (
              <>
                <h3 className="text-lg font-medium text-zinc-300">No runs yet</h3>
                <p className="text-sm text-zinc-500 mt-1">Run a pipeline to see history here.</p>
              </>
            )}
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <>
            {/* Mobile: card list */}
            <div className="md:hidden flex flex-col gap-2">
              {filtered.map((run) => (
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
                    <Badge variant={statusVariant(run.Status)}>{run.Status}</Badge>
                  </div>
                  <div className="flex items-center justify-between mt-2 text-xs">
                    <div className="text-zinc-400">
                      <span className="text-zinc-500">Started </span>
                      {fmtDate(run.StartedAt)}
                    </div>
                    <span className="font-mono text-zinc-400">
                      {duration(run.StartedAt, run.FinishedAt)}
                    </span>
                  </div>
                  <div
                    className="flex justify-end mt-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-zinc-500 hover:text-red-400"
                      onClick={() => setConfirmDelete(run)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Delete
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
                    <th className="px-4 py-3 text-left font-medium text-zinc-400">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-zinc-400">Started</th>
                    <th className="px-4 py-3 text-left font-medium text-zinc-400">Duration</th>
                    <th className="px-4 py-3 w-16" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((run, i) => (
                    <tr
                      key={run.ID}
                      onClick={() => navigate(`/runs/${run.ID}`)}
                      className={`border-b border-zinc-800/50 cursor-pointer hover:bg-zinc-800/50 transition-colors group ${
                        i === filtered.length - 1 ? "border-b-0" : ""
                      }`}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-zinc-200 group-hover:text-white transition-colors">{run.PipelineName}</p>
                        <p className="text-xs text-zinc-500">{run.PipelineID}</p>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={statusVariant(run.Status)}>{run.Status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-zinc-400">{fmtDate(run.StartedAt)}</td>
                      <td className="px-4 py-3 text-zinc-400 font-mono text-xs">
                        {duration(run.StartedAt, run.FinishedAt)}
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => setConfirmDelete(run)}
                            title="Delete this run"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                          <ChevronRight className="h-4 w-4 text-zinc-600 group-hover:text-zinc-300 transition-colors" />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {pages > 1 && (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4">
                <p className="text-xs text-zinc-500">
                  {total} total runs · page {page} of {pages}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Prev
                  </Button>
                  {/* Two page-number lists: 7-wide on sm+, 3-wide on mobile. */}
                  {([7, 3] as const).map((window) => (
                    <div
                      key={window}
                      className={cn(
                        "gap-1",
                        window === 7 ? "hidden sm:flex" : "flex sm:hidden"
                      )}
                    >
                      {Array.from({ length: Math.min(pages, window) }, (_, i) => {
                        let p: number;
                        if (pages <= window) {
                          p = i + 1;
                        } else if (page <= Math.ceil(window / 2)) {
                          p = i + 1;
                        } else if (page >= pages - Math.floor(window / 2)) {
                          p = pages - window + 1 + i;
                        } else {
                          p = page - Math.floor(window / 2) + i;
                        }
                        return (
                          <button
                            key={p}
                            onClick={() => setPage(p)}
                            className={`w-8 h-8 rounded text-xs font-medium transition-colors ${
                              p === page
                                ? "bg-violet-600 text-white"
                                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                            }`}
                          >
                            {p}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page >= pages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          message={`Delete run #${confirmDelete.ID} (${confirmDelete.PipelineName})? This cannot be undone.`}
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
          loading={actionLoading}
        />
      )}

      {confirmClearAll && (
        <ConfirmDialog
          message="Clear all completed run history? This permanently deletes all records and cannot be undone."
          onConfirm={handleClearAll}
          onCancel={() => setConfirmClearAll(false)}
          loading={actionLoading}
        />
      )}
    </Layout>
  );
}
