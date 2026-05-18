import { useEffect, useState } from "react";
import { apiKeysApi, type ApiKeyInfo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Key, Copy, Trash2, Plus, AlertTriangle } from "lucide-react";

// ApiKeysCard renders the self-service key manager for the signed-in user.
// The plaintext value is returned exactly once on creation — the UI
// surfaces it as a copy-once banner; revisiting the page only shows the
// prefix hint (idk_xxxxxxxx…).
export function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newExpiry, setNewExpiry] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const r = await apiKeysApi.listMine();
      setKeys(r.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    if (!newName.trim()) {
      setCreateError("Name is required.");
      return;
    }
    setCreating(true);
    try {
      const hours = newExpiry ? parseInt(newExpiry, 10) : undefined;
      const r = await apiKeysApi.createMine(newName.trim(), hours);
      setPlaintext(r.data.plaintext);
      setNewName("");
      setNewExpiry("");
      setShowCreate(false);
      await refresh();
    } catch (err: any) {
      setCreateError(err?.response?.data?.message ?? "Failed to create key.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: number) {
    if (!confirm("Revoke this key? Any system using it will immediately lose access.")) return;
    await apiKeysApi.revokeMine(id);
    await refresh();
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Key className="h-4 w-4" />
          API Keys
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-zinc-400">
          Long-lived bearer tokens for programmatic access. External systems
          and LLM agents authenticate with{" "}
          <code className="text-zinc-300">Authorization: Bearer idk_…</code>.
          Keys inherit your role and bypass TOTP. See{" "}
          <a href="/api/v1/openapi.json" className="text-cyan-400 underline">
            OpenAPI spec
          </a>{" "}
          for endpoint details.
        </p>

        {plaintext && (
          <div className="rounded-lg border border-emerald-700/50 bg-emerald-950/30 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-emerald-300">
                Copy this key now — it will not be shown again.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-zinc-900 text-zinc-200 px-2 py-1.5 rounded break-all">
                {plaintext}
              </code>
              <Button size="sm" variant="outline" onClick={() => copy(plaintext)}>
                <Copy className="h-3.5 w-3.5 mr-1" />
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <button
              onClick={() => setPlaintext(null)}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              I've saved it — dismiss
            </button>
          </div>
        )}

        {!showCreate && !plaintext && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            New API key
          </Button>
        )}

        {showCreate && (
          <form onSubmit={handleCreate} className="space-y-2 rounded-lg border border-zinc-700 p-3">
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Label</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. claude-agent or ci-runner"
                maxLength={64}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Expires in hours (optional)</label>
              <Input
                type="number"
                min={0}
                value={newExpiry}
                onChange={(e) => setNewExpiry(e.target.value)}
                placeholder="Leave blank for no expiry"
              />
            </div>
            {createError && <p className="text-xs text-red-400">{createError}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" loading={creating}>
                Generate
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowCreate(false);
                  setCreateError("");
                  setNewName("");
                  setNewExpiry("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="text-xs text-zinc-500">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-xs text-zinc-500">No keys yet.</p>
        ) : (
          <div className="space-y-2">
            {keys.map((k) => {
              const revoked = !!k.revoked_at;
              const expired = !!(k.expires_at && new Date(k.expires_at) < new Date());
              return (
                <div
                  key={k.id}
                  className="flex items-center justify-between rounded-lg border border-zinc-700 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-zinc-200 truncate">{k.name}</span>
                      {revoked && <Badge variant="error">revoked</Badge>}
                      {expired && !revoked && <Badge variant="warning">expired</Badge>}
                    </div>
                    <div className="text-xs text-zinc-500 font-mono mt-0.5">
                      {k.prefix_hint}…{" "}
                      <span className="text-zinc-600">
                        · created {new Date(k.created_at).toLocaleDateString()}
                        {k.last_used_at &&
                          ` · last used ${new Date(k.last_used_at).toLocaleString()}`}
                        {k.expires_at &&
                          ` · expires ${new Date(k.expires_at).toLocaleDateString()}`}
                      </span>
                    </div>
                  </div>
                  {!revoked && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRevoke(k.id)}
                      className="text-red-400 hover:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
