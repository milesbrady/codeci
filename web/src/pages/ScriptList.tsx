import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { scriptsApi, type ScriptSummary } from "@/lib/api";
import { Layout, PageHeader } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Plus, Search, Terminal, Play, Pencil, Trash2, Download } from "lucide-react";
import { downloadBlob } from "@/lib/utils";

export function ScriptList() {
  const navigate = useNavigate();
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const res = await scriptsApi.exportZip();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      downloadBlob(res.data as Blob, `scripts-${stamp}.zip`);
    } catch {
      alert("Failed to export scripts.");
    } finally {
      setExporting(false);
    }
  }

  function load() {
    scriptsApi.list()
      .then((res) => setScripts(res.data))
      .catch(() => setError("Failed to load scripts."))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  const filtered = scripts.filter((s) =>
    s.name.toLowerCase().includes(query.toLowerCase())
  );

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete script "${name}"? This cannot be undone.`)) return;
    setDeleting(id);
    try {
      await scriptsApi.delete(id);
      setScripts((prev) => prev.filter((s) => s.id !== id));
    } catch {
      alert("Failed to delete script.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Layout>
      <PageHeader
        title="Scripts"
        description="Manage and run reusable shell scripts"
        action={
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={handleExport}
              disabled={exporting || scripts.length === 0}
              className="gap-2"
              title="Export all scripts as a zip"
            >
              <Download className="h-4 w-4" />
              {exporting ? "Exporting…" : "Export"}
            </Button>
            <Button onClick={() => navigate("/scripts/create")} className="gap-2">
              <Plus className="h-4 w-4" />
              New Script
            </Button>
          </div>
        }
      />

      <div className="p-8">
        <div className="relative mb-6 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            placeholder="Search scripts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 pl-9 pr-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-violet-600 focus:border-violet-600 transition-colors"
          />
        </div>

        {loading && (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 rounded-lg bg-zinc-900/60 border border-zinc-800 animate-pulse" />
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-950/50 border border-red-800 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="flex flex-col gap-2">
            {filtered.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 group"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-600/20">
                  <Terminal className="h-3.5 w-3.5 text-emerald-400" />
                </div>

                <div className="flex-1 min-w-0">
                  <span className="font-medium text-sm text-zinc-100">{s.name}</span>
                  <p className="text-xs text-zinc-500 mt-0.5 font-mono">{s.id}.sh</p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 border-emerald-800/50 text-emerald-400 hover:border-emerald-600 hover:text-emerald-300"
                    onClick={() => navigate(`/scripts/${s.id}/run`)}
                  >
                    <Play className="h-3 w-3" />
                    Run
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => navigate(`/scripts/${s.id}/edit`)}
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 border-red-900/50 text-red-400 hover:border-red-700 hover:text-red-300"
                    onClick={() => handleDelete(s.id, s.name)}
                    disabled={deleting === s.id}
                  >
                    <Trash2 className="h-3 w-3" />
                    {deleting === s.id ? "Deleting…" : "Delete"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="h-16 w-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
              {query ? (
                <Search className="h-7 w-7 text-zinc-600" />
              ) : (
                <Terminal className="h-7 w-7 text-zinc-600" />
              )}
            </div>
            {query ? (
              <>
                <h3 className="text-lg font-medium text-zinc-300">No matches for "{query}"</h3>
                <p className="text-sm text-zinc-500 mt-1">Try a different search term.</p>
              </>
            ) : (
              <>
                <h3 className="text-lg font-medium text-zinc-300">No scripts yet</h3>
                <p className="text-sm text-zinc-500 mt-1 max-w-xs">
                  Create a script and reuse it across pipelines or run it directly.
                </p>
                <Button className="mt-4 gap-2" onClick={() => navigate("/scripts/create")}>
                  <Plus className="h-4 w-4" />
                  New Script
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
