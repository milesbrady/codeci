import { useEffect, useMemo, useState } from "react";
import {
  groupsApi,
  pipelinesApi,
  scriptsApi,
  type GroupInfo,
  type GroupWritePayload,
  type PipelineSummary,
  type ScriptSummary,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2, Pencil, ShieldCheck, Users, Search } from "lucide-react";
import { cn } from "@/lib/utils";

// Human-readable labels for the canonical operation tokens. The set MUST
// stay in sync with auth.AllOperations on the backend; the UI degrades
// gracefully (token shown verbatim) when an unknown op arrives, so adding
// a new operation server-side is a non-breaking change.
const OPERATION_LABELS: Record<string, { label: string; group: "Pipelines" | "Scripts" | "Runs" | "API Keys" }> = {
  "pipelines:read":    { label: "View pipelines",         group: "Pipelines" },
  "pipelines:run":     { label: "Run pipelines",          group: "Pipelines" },
  "pipelines:write":   { label: "Create / edit pipelines", group: "Pipelines" },
  "pipelines:delete":  { label: "Delete pipelines",       group: "Pipelines" },
  "scripts:read":      { label: "View scripts",           group: "Scripts" },
  "scripts:run":       { label: "Run scripts",            group: "Scripts" },
  "scripts:write":     { label: "Create / edit scripts",  group: "Scripts" },
  "scripts:delete":    { label: "Delete scripts",         group: "Scripts" },
  "runs:read_all":     { label: "See all users' runs",    group: "Runs" },
  "apikeys:issue_self": { label: "Issue own API keys",    group: "API Keys" },
};

function opLabel(op: string): string {
  return OPERATION_LABELS[op]?.label ?? op;
}

// Group operations by category for the editor's checkbox grid.
function groupOps(allOps: string[]) {
  const buckets: Record<string, string[]> = {};
  for (const op of allOps) {
    const cat = OPERATION_LABELS[op]?.group ?? "Other";
    if (!buckets[cat]) buckets[cat] = [];
    buckets[cat].push(op);
  }
  return Object.entries(buckets);
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
        <p className="text-sm text-zinc-200">{message}</p>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={loading}>Cancel</Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} loading={loading}>Confirm</Button>
        </div>
      </div>
    </div>
  );
}

// ResourcePicker is the toggleable "all / selected" + multi-select used for
// both pipelines and scripts inside the group editor. Selected mode shows a
// search box and a virtualised-ish scroll list of checkboxes; the search
// filters by ID and name in real time.
function ResourcePicker<T extends { id: string; name: string }>({
  label,
  mode,
  setMode,
  items,
  selected,
  setSelected,
  loading,
}: {
  label: string;
  mode: "all" | "selected";
  setMode: (m: "all" | "selected") => void;
  items: T[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  loading: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return items;
    return items.filter((i) => i.id.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
  }, [items, query]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function selectAll() {
    const next = new Set(selected);
    for (const i of filtered) next.add(i.id);
    setSelected(next);
  }

  function clearAll() {
    const next = new Set(selected);
    for (const i of filtered) next.delete(i.id);
    setSelected(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <label className="text-xs text-zinc-400 uppercase tracking-wide">{label}</label>
        <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 text-xs w-fit">
          <button
            type="button"
            onClick={() => setMode("all")}
            className={cn(
              "px-3 py-1.5 rounded-md transition-colors min-h-9",
              mode === "all" ? "bg-violet-600/30 text-violet-200" : "text-zinc-400 hover:text-zinc-200"
            )}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setMode("selected")}
            className={cn(
              "px-3 py-1.5 rounded-md transition-colors min-h-9",
              mode === "selected" ? "bg-violet-600/30 text-violet-200" : "text-zinc-400 hover:text-zinc-200"
            )}
          >
            Only selected ({selected.size})
          </button>
        </div>
      </div>

      {mode === "all" ? (
        <p className="text-xs text-zinc-500">
          Group members can see every {label.toLowerCase()} on the system.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Filter ${label.toLowerCase()}…`}
                className="pl-9"
              />
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={selectAll}>
              Add visible
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={clearAll}>
              Remove visible
            </Button>
          </div>

          <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/40 divide-y divide-zinc-800">
            {loading ? (
              <p className="text-xs text-zinc-500 p-3">Loading…</p>
            ) : filtered.length === 0 ? (
              <p className="text-xs text-zinc-500 p-3">No matches.</p>
            ) : (
              filtered.map((item) => {
                const isSel = selected.has(item.id);
                return (
                  <label
                    key={item.id}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 cursor-pointer min-h-11",
                      isSel ? "bg-violet-600/10" : "hover:bg-zinc-900"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggle(item.id)}
                      className="h-4 w-4 rounded border-zinc-600 bg-zinc-900"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-200 truncate">{item.name}</p>
                      <p className="text-[11px] text-zinc-500 truncate">{item.id}</p>
                    </div>
                  </label>
                );
              })
            )}
          </div>

          {selected.size === 0 && (
            <p className="text-xs text-amber-500/80">
              No items selected — members of this group will see no {label.toLowerCase()}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function GroupEditor({
  group,
  pipelines,
  scripts,
  loadingResources,
  allOperations,
  onClose,
  onSaved,
}: {
  group: GroupInfo | null;
  pipelines: PipelineSummary[];
  scripts: ScriptSummary[];
  loadingResources: boolean;
  allOperations: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!group;
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [pipelineMode, setPipelineMode] = useState<"all" | "selected">(group?.pipeline_mode ?? "all");
  const [scriptMode, setScriptMode] = useState<"all" | "selected">(group?.script_mode ?? "all");
  const [ops, setOps] = useState<Set<string>>(new Set(group?.operations ?? ["pipelines:read", "pipelines:run", "scripts:read", "scripts:run", "apikeys:issue_self"]));
  const [pipelineIDs, setPipelineIDs] = useState<Set<string>>(new Set(group?.pipeline_ids ?? []));
  const [scriptIDs, setScriptIDs] = useState<Set<string>>(new Set(group?.script_ids ?? []));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function toggleOp(op: string) {
    const next = new Set(ops);
    if (next.has(op)) next.delete(op);
    else next.add(op);
    setOps(next);
  }

  async function save() {
    setError("");
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const payload: GroupWritePayload = {
      name: name.trim(),
      description: description.trim(),
      pipeline_mode: pipelineMode,
      script_mode: scriptMode,
      operations: Array.from(ops).sort(),
      pipeline_ids: pipelineMode === "selected" ? Array.from(pipelineIDs).sort() : [],
      script_ids: scriptMode === "selected" ? Array.from(scriptIDs).sort() : [],
    };
    setSaving(true);
    try {
      if (isEdit && group) {
        await groupsApi.update(group.id, payload);
      } else {
        await groupsApi.create(payload);
      }
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Failed to save group.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4">
      <div className="w-full max-w-2xl rounded-xl border border-zinc-700 bg-zinc-900 p-4 sm:p-6 space-y-5 max-h-[95vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-violet-400" />
          {isEdit ? `Edit ${group?.name ?? ""}` : "Create group"}
          {group?.is_system && (
            <Badge variant="default" className="text-[10px]">system</Badge>
          )}
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Release engineers"
              disabled={group?.is_system}
              autoComplete="off"
            />
            {group?.is_system && (
              <p className="text-[11px] text-zinc-500">System group name is fixed.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Description</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-xs text-zinc-400 uppercase tracking-wide mb-2">Permissions</p>
            <p className="text-[11px] text-zinc-500 mb-3">
              What members of this group are allowed to do. Operations are
              additive across all of a user's groups.
            </p>
          </div>
          {groupOps(allOperations).map(([cat, opList]) => (
            <div key={cat}>
              <p className="text-[11px] text-zinc-500 mb-2 uppercase tracking-wide">{cat}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {opList.map((op) => (
                  <label
                    key={op}
                    className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/30 px-3 py-2 cursor-pointer hover:border-zinc-700 min-h-11"
                  >
                    <input
                      type="checkbox"
                      checked={ops.has(op)}
                      onChange={() => toggleOp(op)}
                      className="h-4 w-4 rounded border-zinc-600 bg-zinc-900"
                    />
                    <span className="text-sm text-zinc-200">{opLabel(op)}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <ResourcePicker
          label="Pipelines"
          mode={pipelineMode}
          setMode={setPipelineMode}
          items={pipelines.map((p) => ({ id: p.id, name: p.name }))}
          selected={pipelineIDs}
          setSelected={setPipelineIDs}
          loading={loadingResources}
        />
        <ResourcePicker
          label="Scripts"
          mode={scriptMode}
          setMode={setScriptMode}
          items={scripts.map((s) => ({ id: s.id, name: s.name }))}
          selected={scriptIDs}
          setSelected={setScriptIDs}
          loading={loadingResources}
        />

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex flex-col sm:flex-row gap-2 sm:justify-end pt-2 border-t border-zinc-800">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={save} loading={saving}>
            {isEdit ? "Save changes" : "Create group"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function GroupsCard() {
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<GroupInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GroupInfo | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([]);
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(true);

  const allOperations = useMemo(
    () => Object.keys(OPERATION_LABELS),
    []
  );

  async function refresh() {
    setLoading(true);
    try {
      const r = await groupsApi.list();
      setGroups(r.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    Promise.all([pipelinesApi.list(), scriptsApi.list()])
      .then(([p, s]) => {
        setPipelines(p.data);
        setScripts(s.data);
      })
      .finally(() => setResourcesLoading(false));
  }, []);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await groupsApi.remove(deleteTarget.id);
      setDeleteTarget(null);
      refresh();
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              User Groups
            </CardTitle>
            <p className="text-xs text-zinc-500 mt-1">
              Bundles of permissions and pipeline / script visibility. A user's
              effective access is the union of every group they belong to.
              Admins bypass groups.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Create group
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-6 space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 rounded-lg bg-zinc-800/50 animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            {/* Mobile cards */}
            <div className="md:hidden flex flex-col gap-2 p-3">
              {groups.map((g) => (
                <div key={g.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-200 truncate flex items-center gap-2">
                        {g.name}
                        {g.is_system && <Badge variant="default" className="text-[9px]">system</Badge>}
                      </p>
                      {g.description && (
                        <p className="text-xs text-zinc-500 mt-0.5">{g.description}</p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(g)} aria-label="Edit group">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {!g.is_system && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget(g)}
                          className="text-red-500 hover:text-red-400"
                          aria-label="Delete group"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    <Badge variant="default">
                      <Users className="h-3 w-3 mr-1 inline" />
                      {g.member_count} {g.member_count === 1 ? "member" : "members"}
                    </Badge>
                    <Badge variant="default">
                      pipelines: {g.pipeline_mode === "all" ? "all" : `${g.pipeline_ids.length} selected`}
                    </Badge>
                    <Badge variant="default">
                      scripts: {g.script_mode === "all" ? "all" : `${g.script_ids.length} selected`}
                    </Badge>
                    <Badge variant="default">
                      {g.operations.length} ops
                    </Badge>
                  </div>
                </div>
              ))}
              {groups.length === 0 && (
                <p className="text-sm text-zinc-500 p-4 text-center">No groups yet.</p>
              )}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-900/80">
                    <th className="px-4 py-3 text-left font-medium text-zinc-400">Group</th>
                    <th className="px-4 py-3 text-left font-medium text-zinc-400">Members</th>
                    <th className="px-4 py-3 text-left font-medium text-zinc-400">Pipelines</th>
                    <th className="px-4 py-3 text-left font-medium text-zinc-400">Scripts</th>
                    <th className="px-4 py-3 text-left font-medium text-zinc-400">Permissions</th>
                    <th className="px-4 py-3 w-32" />
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g, i) => (
                    <tr
                      key={g.id}
                      className={cn("border-b border-zinc-800/50", i === groups.length - 1 && "border-b-0")}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-zinc-200">{g.name}</span>
                          {g.is_system && (
                            <Badge variant="default" className="text-[10px]">system</Badge>
                          )}
                        </div>
                        {g.description && (
                          <p className="text-xs text-zinc-500 mt-0.5">{g.description}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-300">{g.member_count}</td>
                      <td className="px-4 py-3 text-zinc-300">
                        {g.pipeline_mode === "all" ? "All" : `${g.pipeline_ids.length} selected`}
                      </td>
                      <td className="px-4 py-3 text-zinc-300">
                        {g.script_mode === "all" ? "All" : `${g.script_ids.length} selected`}
                      </td>
                      <td className="px-4 py-3 text-zinc-300">{g.operations.length}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(g)} aria-label="Edit group">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {!g.is_system && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeleteTarget(g)}
                              className="text-red-500 hover:text-red-400"
                              aria-label="Delete group"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {groups.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-zinc-500 text-sm">
                        No groups yet — click "Create group" to add one.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>

      {(creating || editing) && (
        <GroupEditor
          group={editing}
          pipelines={pipelines}
          scripts={scripts}
          loadingResources={resourcesLoading}
          allOperations={allOperations}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={refresh}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          message={`Delete group "${deleteTarget.name}"? Members will lose any access granted by this group. This cannot be undone.`}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
          loading={deleteLoading}
        />
      )}
    </Card>
  );
}
