import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  configApi,
  githubApi,
  pipelinesApi,
  triggersApi,
  type GitHubRepo,
  type GitHubStatus,
  type Pipeline,
  type PipelineTrigger,
  type PipelineTriggerInput,
} from "@/lib/api";
import { Layout, PageHeader } from "@/components/Layout";
import { DynamicForm } from "@/components/DynamicForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import {
  ArrowLeft,
  GitBranch,
  Webhook,
  Trash2,
  PlayCircle,
  Copy,
  RefreshCw,
} from "lucide-react";

const ALL_EVENTS = [
  { value: "push", label: "push — commit pushed to branch" },
  { value: "pull_request", label: "pull_request — opened / updated" },
  { value: "release", label: "release — published" },
];

type Provider = "github" | "manual";

export function PipelineTriggerConfig() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [trigger, setTrigger] = useState<PipelineTrigger | null>(null);
  const [ghStatus, setGhStatus] = useState<GitHubStatus | null>(null);
  const [webhookBase, setWebhookBase] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const [provider, setProvider] = useState<Provider>("github");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoFullName, setRepoFullName] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branch, setBranch] = useState("");
  const [events, setEvents] = useState<string[]>(["push"]);
  const [active, setActive] = useState(true);
  const [savedDefaults, setSavedDefaults] = useState<Record<string, string>>({});

  // The manual-mode plaintext secret is only present in the response right
  // after creation / regeneration. We show it once with a copy button.
  const [revealedManualSecret, setRevealedManualSecret] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [testRunID, setTestRunID] = useState<number | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      try {
        const [pl, tr, ghs, app] = await Promise.all([
          pipelinesApi.get(id!),
          triggersApi.get(id!),
          githubApi.status().catch(() => null),
          configApi.getApp(),
        ]);
        if (cancelled) return;
        setPipeline(pl.data);
        setWebhookBase(app.data.webhook_base_url);
        setGhStatus(ghs?.data ?? null);
        if (tr.data) {
          const t = tr.data;
          setTrigger(t);
          setProvider(t.provider);
          setRepoFullName(t.repo_owner && t.repo_name ? `${t.repo_owner}/${t.repo_name}` : "");
          setBranch(t.branch);
          setEvents(t.events.length ? t.events : ["push"]);
          setActive(t.active);
          setSavedDefaults(t.default_params ?? {});
        } else {
          // Pre-fill defaults from the pipeline parameter defaults so the
          // admin only has to override values that aren't already set.
          const seeded: Record<string, string> = {};
          for (const p of pl.data.parameters) {
            if (p.default !== undefined && p.default !== null) seeded[p.id] = String(p.default);
          }
          setSavedDefaults(seeded);
        }
      } catch (e: any) {
        setError(e?.response?.data?.message ?? "Failed to load pipeline / trigger");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Fetch repos once GitHub is connected and the github provider is picked.
  useEffect(() => {
    if (provider !== "github" || !ghStatus?.connected) return;
    let cancelled = false;
    setReposLoading(true);
    githubApi
      .listRepos()
      .then((r) => {
        if (!cancelled) setRepos(r.data);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.message ?? "Failed to list repos");
      })
      .finally(() => {
        if (!cancelled) setReposLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, ghStatus?.connected]);

  // Branch list refreshes whenever the user picks a different repo.
  useEffect(() => {
    if (provider !== "github" || !repoFullName) {
      setBranches([]);
      return;
    }
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) return;
    let cancelled = false;
    setBranchesLoading(true);
    githubApi
      .listBranches(owner, repo)
      .then((r) => {
        if (cancelled) return;
        setBranches(r.data);
        if (!branch) {
          const found = repos.find((x) => x.full_name === repoFullName);
          if (found?.default_branch) setBranch(found.default_branch);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.message ?? "Failed to list branches");
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // branch left out of deps intentionally — we only auto-pick the default
    // once when branch is empty; subsequent user edits should stick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, repoFullName, repos]);

  const repoOptions = useMemo(
    () => repos.map((r) => ({ label: r.full_name, value: r.full_name })),
    [repos]
  );

  function toggleEvent(ev: string) {
    setEvents((curr) => (curr.includes(ev) ? curr.filter((x) => x !== ev) : [...curr, ev]));
  }

  async function handleSaveDefaults(values: Record<string, string>) {
    setSavedDefaults(values);
    await persist(values, false);
  }

  async function persist(defaults: Record<string, string>, regenerateSecret: boolean) {
    if (!pipeline) return;
    setSaving(true);
    setError("");
    setRevealedManualSecret(null);
    try {
      const body: PipelineTriggerInput = {
        provider,
        default_params: defaults,
        active,
      };
      if (provider === "github") {
        const [owner, repo] = repoFullName.split("/");
        if (!owner || !repo) {
          throw new Error("Pick a repository first.");
        }
        if (!events.length) throw new Error("Pick at least one event.");
        body.repo_owner = owner;
        body.repo_name = repo;
        body.branch = branch;
        body.events = events;
      } else {
        body.regenerate_secret = regenerateSecret;
      }
      const r = await triggersApi.put(pipeline.id, body);
      setTrigger(r.data);
      setActive(r.data.active);
      if (r.data.provider === "manual" && r.data.manual_secret_hint && (regenerateSecret || !trigger)) {
        // First-time creation or explicit regenerate: the response carries
        // the plaintext secret in the same field. Show it once.
        setRevealedManualSecret(r.data.manual_secret_hint);
      }
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!pipeline) return;
    if (!confirm("Delete this trigger? The corresponding GitHub webhook will be removed.")) return;
    setSaving(true);
    try {
      await triggersApi.remove(pipeline.id);
      navigate(`/pipelines/${pipeline.id}`);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Delete failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive() {
    if (!trigger) return;
    setActive(!active);
    await persist(savedDefaults, false);
  }

  async function handleTest() {
    if (!pipeline) return;
    setTestRunID(null);
    setError("");
    try {
      const r = await triggersApi.test(pipeline.id);
      setTestRunID(r.data.run_id);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Test fire failed.");
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard may be unavailable on http (non-localhost); ignore
    }
  }

  if (loading) {
    return (
      <Layout>
        <PageHeader title="Configure trigger" />
        <div className="p-4 md:p-8 text-sm text-zinc-400">Loading…</div>
      </Layout>
    );
  }
  if (!pipeline) {
    return (
      <Layout>
        <PageHeader title="Configure trigger" />
        <div className="p-4 md:p-8 text-sm text-red-400">{error || "Pipeline not found."}</div>
      </Layout>
    );
  }

  const githubReady = !!ghStatus?.connected;
  const manualURL =
    trigger?.provider === "manual" && trigger?.manual_url
      ? trigger.manual_url
      : trigger?.provider === "manual" && trigger?.id
      ? `${webhookBase}/api/webhooks/manual/${trigger.id}`
      : "";

  return (
    <Layout>
      <PageHeader
        title={`Trigger · ${pipeline.name}`}
        description={`Auto-run this pipeline from GitHub events or a signed HTTP POST.`}
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate(`/pipelines/${pipeline.id}`)}
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        }
      />

      <div className="p-4 md:p-8 max-w-2xl mx-auto w-full space-y-6">
        {/* Source picker */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Webhook className="h-4 w-4" />
              Source
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                size="sm"
                variant={provider === "github" ? "default" : "outline"}
                onClick={() => setProvider("github")}
              >
                <GitBranch className="h-4 w-4 mr-1" /> GitHub
              </Button>
              <Button
                size="sm"
                variant={provider === "manual" ? "default" : "outline"}
                onClick={() => setProvider("manual")}
              >
                <Webhook className="h-4 w-4 mr-1" /> Manual webhook URL
              </Button>
            </div>
            {provider === "github" && !githubReady && (
              <p className="text-xs text-amber-400">
                GitHub is not connected.{" "}
                <Link to="/settings" className="underline">
                  Connect it in Settings
                </Link>{" "}
                first.
              </p>
            )}
          </CardContent>
        </Card>

        {/* GitHub repo + branch + events */}
        {provider === "github" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <GitBranch className="h-4 w-4" />
                Repository &amp; events
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">Repository</label>
                <Combobox
                  options={repoOptions}
                  value={repoFullName}
                  onChange={(v) => {
                    setRepoFullName(v);
                    setBranch("");
                  }}
                  loading={reposLoading}
                  disabled={!githubReady}
                  placeholder={githubReady ? "Pick a repository…" : "Connect GitHub first"}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">Branch</label>
                <select
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  disabled={!repoFullName || branchesLoading}
                  className="flex h-10 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="">{branchesLoading ? "Loading…" : "Any branch"}</option>
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-zinc-500">
                  Leave blank to fire on every branch (push events only).
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">Events</label>
                <div className="flex flex-col gap-2">
                  {ALL_EVENTS.map((ev) => (
                    <label key={ev.value} className="flex items-center gap-2 text-sm text-zinc-200">
                      <input
                        type="checkbox"
                        checked={events.includes(ev.value)}
                        onChange={() => toggleEvent(ev.value)}
                        className="h-4 w-4 rounded border-zinc-600 bg-zinc-900"
                      />
                      <span>{ev.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Default parameters — required */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Default parameters</CardTitle>
          </CardHeader>
          <CardContent>
            {pipeline.parameters.length === 0 ? (
              <p className="text-xs text-zinc-500">
                This pipeline has no parameters — no defaults needed.
              </p>
            ) : (
              <>
                <p className="text-xs text-zinc-500 mb-3">
                  Webhook deliveries are non-interactive, so every required parameter
                  needs a default. The form below will refuse to submit until all are
                  filled.
                </p>
                <DynamicForm
                  parameters={pipeline.parameters}
                  onSubmit={handleSaveDefaults}
                  loading={saving}
                  submitLabel={savedAt ? "Saved!" : "Save trigger"}
                  initialValues={savedDefaults}
                />
              </>
            )}
            {pipeline.parameters.length === 0 && (
              <div className="mt-4">
                <Button size="sm" onClick={() => persist({}, false)} loading={saving}>
                  {savedAt ? "Saved!" : "Save trigger"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Status + actions — only meaningful once the trigger exists */}
        {trigger && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2 justify-between">
                <span>Status</span>
                {active ? (
                  <Badge variant="success">Active</Badge>
                ) : (
                  <Badge variant="warning">Paused</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {trigger.last_fired_at && (
                <p className="text-xs text-zinc-400">
                  Last fired: {new Date(trigger.last_fired_at).toLocaleString()}
                </p>
              )}
              {trigger.provider === "github" && trigger.github_hook_id && (
                <p className="text-xs text-zinc-400">
                  GitHub hook ID: <code className="font-mono">{trigger.github_hook_id}</code>
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={handleToggleActive} disabled={saving}>
                  {active ? "Pause" : "Resume"}
                </Button>
                <Button size="sm" variant="outline" onClick={handleTest} disabled={saving}>
                  <PlayCircle className="h-4 w-4 mr-1" /> Test trigger
                </Button>
                <Button size="sm" variant="destructive" onClick={handleDelete} disabled={saving}>
                  <Trash2 className="h-4 w-4 mr-1" /> Delete
                </Button>
              </div>
              {testRunID !== null && (
                <p className="text-xs text-emerald-400">
                  Test run started — run #{testRunID}.{" "}
                  <Link to={`/runs/${testRunID}`} className="underline">
                    View
                  </Link>
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Manual webhook URL — visible only for the manual provider */}
        {provider === "manual" && trigger && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Webhook className="h-4 w-4" />
                Manual webhook URL
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">POST URL</label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <div className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 font-mono break-all">
                    {manualURL}
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => copyToClipboard(manualURL)}>
                    <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">Authorization header</label>
                {revealedManualSecret ? (
                  <>
                    <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200 font-mono break-all">
                      X-Codeci-Token: {revealedManualSecret}
                    </div>
                    <p className="text-xs text-amber-300">
                      This is the only time the token will be shown. Save it somewhere
                      safe — you can regenerate it below if you lose it.
                    </p>
                  </>
                ) : (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400 font-mono">
                    X-Codeci-Token: {trigger.manual_secret_hint || "????"}… (hidden)
                  </div>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => persist(savedDefaults, true)}
                disabled={saving}
              >
                <RefreshCw className="h-4 w-4 mr-1" /> Regenerate token
              </Button>
              <pre className="text-xs text-zinc-500 bg-zinc-950/40 border border-zinc-800 rounded-lg p-3 overflow-x-auto">
{`curl -X POST \\
  -H "X-Codeci-Token: <token>" \\
  ${manualURL}`}
              </pre>
            </CardContent>
          </Card>
        )}

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>
    </Layout>
  );
}
