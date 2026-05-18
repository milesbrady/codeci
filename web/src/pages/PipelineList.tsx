import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { pipelinesApi, favoritesApi, type PipelineSummary, type PipelineImportResponse } from "@/lib/api";
import { Layout, PageHeader } from "@/components/Layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Play, SlidersHorizontal, LayoutList, LayoutGrid, Search, Plus, Download, Upload, Pencil, X, CheckCircle2, AlertCircle, FileWarning, Star } from "lucide-react";
import { cn, downloadBlob } from "@/lib/utils";

type ViewMode = "list" | "grid";

export function PipelineList() {
  const navigate = useNavigate();
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<ViewMode>("list");
  const [query, setQuery] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());

  async function handleExport() {
    setExporting(true);
    try {
      const res = await pipelinesApi.exportZip();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      downloadBlob(res.data as Blob, `pipelines-${stamp}.zip`);
    } catch {
      alert("Failed to export pipelines.");
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    pipelinesApi.list()
      .then((res) => setPipelines(res.data))
      .catch(() => setError("Failed to load pipelines."))
      .finally(() => setLoading(false));
    // Favorites are best-effort — a failure here shouldn't block the list.
    favoritesApi.list()
      .then((res) => setFavorites(new Set(res.data ?? [])))
      .catch(() => { /* ignore */ });
  }, []);

  async function toggleFavorite(id: string) {
    const wasFav = favorites.has(id);
    const next = new Set(favorites);
    wasFav ? next.delete(id) : next.add(id);
    setFavorites(next);
    try {
      if (wasFav) {
        await favoritesApi.remove(id);
      } else {
        await favoritesApi.add(id);
      }
    } catch {
      // revert on failure
      setFavorites((prev) => {
        const r = new Set(prev);
        wasFav ? r.add(id) : r.delete(id);
        return r;
      });
    }
  }

  const filtered = pipelines.filter((p) => {
    const q = query.toLowerCase();
    return p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q);
  });
  const favPipelines = filtered.filter((p) => favorites.has(p.id));
  const restPipelines = filtered.filter((p) => !favorites.has(p.id));
  const showSections = favPipelines.length > 0 && restPipelines.length > 0;

  const viewToggle = (
    <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
      <button
        onClick={() => setView("list")}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
          view === "list"
            ? "bg-zinc-700 text-zinc-100"
            : "text-zinc-500 hover:text-zinc-300"
        )}
        title="List view"
      >
        <LayoutList className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => setView("grid")}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
          view === "grid"
            ? "bg-zinc-700 text-zinc-100"
            : "text-zinc-500 hover:text-zinc-300"
        )}
        title="Grid view"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  const reloadList = () => {
    pipelinesApi.list()
      .then((res) => setPipelines(res.data))
      .catch(() => setError("Failed to load pipelines."));
  };

  const actions = (
    <div className="flex items-center gap-2 md:gap-3">
      {viewToggle}
      <Button
        variant="outline"
        onClick={() => setImportOpen(true)}
        className="gap-2"
        title="Import pipelines from a zip or YAML files"
        aria-label="Import pipelines"
      >
        <Upload className="h-4 w-4" />
        <span className="hidden md:inline">Import</span>
      </Button>
      <Button
        variant="outline"
        onClick={handleExport}
        disabled={exporting || pipelines.length === 0}
        className="gap-2"
        title="Export all pipelines as a zip"
        aria-label="Export pipelines"
      >
        <Download className="h-4 w-4" />
        <span className="hidden md:inline">{exporting ? "Exporting…" : "Export"}</span>
      </Button>
      <Button
        onClick={() => navigate("/pipelines/create")}
        className="gap-2"
        title="Create a new pipeline"
        aria-label="New pipeline"
      >
        <Plus className="h-4 w-4" />
        <span className="hidden md:inline">New Pipeline</span>
      </Button>
    </div>
  );

  function renderGridCard(p: PipelineSummary, isFav: boolean) {
    return (
      <Card
        key={p.id}
        className="cursor-pointer hover:border-violet-700/50 hover:bg-zinc-900 transition-all duration-200 group relative"
        onClick={() => navigate(`/pipelines/${p.id}`)}
      >
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600/20 group-hover:bg-violet-600/30 transition-colors">
              <SlidersHorizontal className="h-4 w-4 text-violet-400" />
            </div>
            <div className="flex items-center gap-2">
              <FavoriteButton id={p.id} active={isFav} onToggle={toggleFavorite} />
              <Badge>{p.version || "v1.0"}</Badge>
            </div>
          </div>
          <CardTitle className="mt-3">{p.name}</CardTitle>
          <CardDescription>{p.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">{p.param_count} parameter{p.param_count !== 1 ? "s" : ""}</span>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity hidden md:inline-flex"
                onClick={(e) => { e.stopPropagation(); navigate(`/pipelines/${p.id}/edit`); }}
                title="Edit pipeline"
              >
                <Pencil className="h-3 w-3" />
                Edit
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 group-hover:border-violet-600/50 group-hover:text-violet-300">
                <Play className="h-3 w-3" />
                <span className="hidden sm:inline">Configure &amp; Run</span>
                <span className="sm:hidden">Run</span>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  function renderListRow(p: PipelineSummary, isFav: boolean) {
    return (
      <div
        key={p.id}
        className="flex items-center gap-3 md:gap-4 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 md:px-4 py-3 cursor-pointer hover:border-violet-700/50 hover:bg-zinc-900 transition-all duration-200 group"
        onClick={() => navigate(`/pipelines/${p.id}`)}
      >
        <FavoriteButton id={p.id} active={isFav} onToggle={toggleFavorite} />
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-violet-600/20 group-hover:bg-violet-600/30 transition-colors">
          <SlidersHorizontal className="h-3.5 w-3.5 text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-zinc-100 truncate">{p.name}</span>
            <Badge className="shrink-0">{p.version || "v1.0"}</Badge>
          </div>
          {p.description && (
            <p className="text-xs text-zinc-500 truncate mt-0.5">{p.description}</p>
          )}
        </div>
        <span className="hidden md:inline text-xs text-zinc-500 shrink-0">{p.param_count} param{p.param_count !== 1 ? "s" : ""}</span>
        <Button
          size="sm"
          variant="ghost"
          className="hidden md:inline-flex shrink-0 gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => { e.stopPropagation(); navigate(`/pipelines/${p.id}/edit`); }}
          title="Edit pipeline"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </Button>
      </div>
    );
  }

  return (
    <Layout>
      <PageHeader
        title="Pipelines"
        description="Select a pipeline to configure and run"
        action={actions}
      />
      <div className="p-4 md:p-8">
        <div className="relative mb-6 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            placeholder="Search pipelines…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 pl-9 pr-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-violet-600 focus:border-violet-600 transition-colors"
          />
        </div>
        {loading && (
          view === "grid" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-40 rounded-xl bg-zinc-900/60 border border-zinc-800 animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded-lg bg-zinc-900/60 border border-zinc-800 animate-pulse" />
              ))}
            </div>
          )
        )}
        {error && (
          <div className="rounded-lg bg-red-950/50 border border-red-800 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}
        {!loading && !error && view === "grid" && (
          <div className="space-y-6">
            {favPipelines.length > 0 && (
              <section>
                {showSections && <SectionHeading icon="star">Favorites</SectionHeading>}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {favPipelines.map((p) => renderGridCard(p, true))}
                </div>
              </section>
            )}
            {restPipelines.length > 0 && (
              <section>
                {showSections && <SectionHeading>All Pipelines</SectionHeading>}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {restPipelines.map((p) => renderGridCard(p, false))}
                </div>
              </section>
            )}
          </div>
        )}
        {!loading && !error && view === "list" && (
          <div className="space-y-6">
            {favPipelines.length > 0 && (
              <section>
                {showSections && <SectionHeading icon="star">Favorites</SectionHeading>}
                <div className="flex flex-col gap-2">
                  {favPipelines.map((p) => renderListRow(p, true))}
                </div>
              </section>
            )}
            {restPipelines.length > 0 && (
              <section>
                {showSections && <SectionHeading>All Pipelines</SectionHeading>}
                <div className="flex flex-col gap-2">
                  {restPipelines.map((p) => renderListRow(p, false))}
                </div>
              </section>
            )}
          </div>
        )}
        {importOpen && (
          <ImportDialog
            onClose={() => setImportOpen(false)}
            onImported={reloadList}
          />
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="h-16 w-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
              {query ? (
                <Search className="h-7 w-7 text-zinc-600" />
              ) : (
                <SlidersHorizontal className="h-7 w-7 text-zinc-600" />
              )}
            </div>
            {query ? (
              <>
                <h3 className="text-lg font-medium text-zinc-300">No matches for "{query}"</h3>
                <p className="text-sm text-zinc-500 mt-1">Try a different search term.</p>
              </>
            ) : (
              <>
                <h3 className="text-lg font-medium text-zinc-300">No pipelines found</h3>
                <p className="text-sm text-zinc-500 mt-1 max-w-xs">
                  Add <code className="text-violet-400">.yaml</code> files to the <code className="text-violet-400">pipelines/</code> directory.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}

function FavoriteButton({ id, active, onToggle }: { id: string; active: boolean; onToggle: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(id); }}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md transition-colors shrink-0",
        active
          ? "text-amber-400 hover:bg-amber-400/10"
          : "text-zinc-600 hover:text-amber-400 hover:bg-zinc-800"
      )}
      title={active ? "Remove from favorites" : "Add to favorites"}
      aria-label={active ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={active}
    >
      <Star className={cn("h-4 w-4", active && "fill-amber-400")} />
    </button>
  );
}

function SectionHeading({ children, icon }: { children: React.ReactNode; icon?: "star" }) {
  return (
    <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-3">
      {icon === "star" && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />}
      {children}
    </h2>
  );
}

function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<PipelineImportResponse | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [err, setErr] = useState("");

  function accept(list: FileList | File[]) {
    const next: File[] = [];
    for (const f of Array.from(list)) {
      const lower = f.name.toLowerCase();
      if (lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".zip")) {
        next.push(f);
      }
    }
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + ":" + f.size));
      const merged = [...prev];
      for (const f of next) {
        const key = f.name + ":" + f.size;
        if (!seen.has(key)) {
          merged.push(f);
          seen.add(key);
        }
      }
      return merged;
    });
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit() {
    if (files.length === 0) return;
    setErr("");
    setSubmitting(true);
    try {
      const res = await pipelinesApi.importFiles(files);
      setResult(res.data);
      if (res.data.imported + res.data.renamed > 0) {
        onImported();
      }
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setErr(msg || "Import failed");
    } finally {
      setSubmitting(false);
    }
  }

  function closeAndMaybeReload() {
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) closeAndMaybeReload(); }}
    >
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-zinc-700 bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Import pipelines</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Upload a <code className="text-violet-400">.zip</code> archive or individual{" "}
              <code className="text-violet-400">.yaml</code>/<code className="text-violet-400">.yml</code> files.
              Files are validated against the pipeline schema before being saved.
            </p>
          </div>
          <button
            onClick={closeAndMaybeReload}
            className="rounded p-1 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {!result && (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (e.dataTransfer.files?.length) accept(e.dataTransfer.files);
                }}
                onClick={() => inputRef.current?.click()}
                className={cn(
                  "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed py-12 cursor-pointer transition-colors",
                  dragOver
                    ? "border-violet-500 bg-violet-500/10"
                    : "border-zinc-700 hover:border-violet-600 hover:bg-zinc-800/40"
                )}
              >
                <Upload className="h-7 w-7 text-zinc-500" />
                <p className="text-sm text-zinc-300">
                  Drag &amp; drop files here, or <span className="text-violet-400 underline">browse</span>
                </p>
                <p className="text-xs text-zinc-500">.yaml, .yml, .zip · multiple allowed</p>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept=".yaml,.yml,.zip,application/zip,application/x-zip-compressed"
                  className="hidden"
                  onChange={(e) => { if (e.target.files) accept(e.target.files); e.currentTarget.value = ""; }}
                />
              </div>

              {files.length > 0 && (
                <div className="rounded-lg border border-zinc-800">
                  <div className="px-3 py-2 border-b border-zinc-800 text-xs text-zinc-400">
                    {files.length} file{files.length !== 1 ? "s" : ""} selected
                  </div>
                  <ul className="divide-y divide-zinc-800 max-h-48 overflow-y-auto">
                    {files.map((f, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs text-zinc-400 truncate font-mono">{f.name}</span>
                          <span className="text-[10px] text-zinc-600 shrink-0">{Math.ceil(f.size / 1024)} KB</span>
                        </div>
                        <button
                          onClick={() => removeFile(i)}
                          className="text-zinc-500 hover:text-red-400 transition-colors"
                          title="Remove"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {err && (
                <div className="rounded-lg bg-red-950/50 border border-red-800 px-3 py-2 text-xs text-red-400">
                  {err}
                </div>
              )}
            </>
          )}

          {result && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="px-2 py-1 rounded-md bg-emerald-950/50 border border-emerald-800 text-emerald-300">
                  Imported: {result.imported}
                </span>
                {result.renamed > 0 && (
                  <span className="px-2 py-1 rounded-md bg-amber-950/50 border border-amber-800 text-amber-300">
                    Renamed: {result.renamed}
                  </span>
                )}
                {result.errors > 0 && (
                  <span className="px-2 py-1 rounded-md bg-red-950/50 border border-red-800 text-red-300">
                    Errors: {result.errors}
                  </span>
                )}
              </div>
              <ul className="rounded-lg border border-zinc-800 divide-y divide-zinc-800 max-h-72 overflow-y-auto">
                {result.results.map((r, i) => (
                  <li key={i} className="px-3 py-2 flex items-start gap-2 text-xs">
                    {r.status === "imported" || r.status === "renamed" ? (
                      r.status === "imported"
                        ? <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                        : <FileWarning className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <p className="font-mono text-zinc-300 truncate">{r.filename}</p>
                      {r.status === "imported" && r.saved && (
                        <p className="text-zinc-500">Saved as <code className="text-emerald-400">{r.saved}</code></p>
                      )}
                      {r.status === "renamed" && r.saved && (
                        <p className="text-amber-300">Saved as <code>{r.saved}</code> (a pipeline with the original name already existed)</p>
                      )}
                      {r.status === "error" && (
                        <p className="text-red-400">{r.error}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-6 py-3">
          {!result ? (
            <>
              <Button variant="ghost" size="sm" onClick={closeAndMaybeReload} disabled={submitting}>Cancel</Button>
              <Button size="sm" onClick={submit} loading={submitting} disabled={files.length === 0}>
                Import {files.length > 0 ? `(${files.length})` : ""}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={closeAndMaybeReload}>Done</Button>
          )}
        </div>
      </div>
    </div>
  );
}
