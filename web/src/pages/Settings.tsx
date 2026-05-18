import { useEffect, useState } from "react";
import {
  adminApi,
  githubApi,
  groupsApi,
  settingsApi,
  type AppSettings,
  type CreateUserPayload,
  type GitHubStatus,
  type GroupInfo,
  type UserInfo,
} from "@/lib/api";
import { Layout, PageHeader } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuthStore } from "@/store/auth";
import { useAppConfigStore } from "@/store/appConfig";
import { GroupsCard } from "@/components/GroupsCard";
import { cn } from "@/lib/utils";
import {
  Users,
  Plus,
  Trash2,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  Shield,
  History,
  Timer,
  KeyRound,
  Cloud,
  Tag,
  Webhook,
  Link2,
  Link2Off,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";

type SettingsTab = "general" | "auth" | "github" | "users" | "groups";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: typeof Users }> = [
  { id: "general", label: "General",        icon: SlidersHorizontal },
  { id: "auth",    label: "Authentication", icon: Cloud },
  { id: "github",  label: "GitHub",         icon: Webhook },
  { id: "users",   label: "Users",          icon: Users },
  { id: "groups",  label: "Groups",         icon: ShieldCheck },
];

const PAGE_SIZE_KEY = "runHistory.pageSize";
const DEFAULT_PAGE_SIZE = 25;

type ModalMode = "create" | "edit" | null;

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
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} loading={loading}>
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}

function UserModal({
  mode,
  user,
  onClose,
  onDone,
}: {
  mode: ModalMode;
  user: UserInfo | null;
  onClose: () => void;
  onDone: () => void;
}) {
  // auth_provider is locked after creation — switching providers would orphan
  // the password hash or the email mapping.
  const initialProvider: "local" | "entra" = user?.auth_provider ?? "local";
  const [authProvider, setAuthProvider] = useState<"local" | "entra">(initialProvider);
  const [username, setUsername] = useState(user?.username ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">(user?.role ?? "user");
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [selectedGroupIDs, setSelectedGroupIDs] = useState<Set<number>>(new Set());
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Load groups + the user's current memberships once on open. For "create"
  // we still need the group list so the admin can pre-assign on creation;
  // selectedGroupIDs starts empty until the user toggles checkboxes.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [glist, mine] = await Promise.all([
          groupsApi.list(),
          mode === "edit" && user ? adminApi.getUserGroups(user.id) : Promise.resolve({ data: { group_ids: [] as number[] } }),
        ]);
        if (cancelled) return;
        setGroups(glist.data);
        setSelectedGroupIDs(new Set(mine.data.group_ids));
      } finally {
        if (!cancelled) setGroupsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [mode, user]);

  function toggleGroup(id: number) {
    const next = new Set(selectedGroupIDs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedGroupIDs(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      let targetUserID: number | null = user?.id ?? null;
      if (mode === "create") {
        if (!username) { setError("Username is required."); setLoading(false); return; }
        if (authProvider === "local") {
          if (!password) { setError("Password is required for local users."); setLoading(false); return; }
          if (password.length < 8) { setError("Password must be at least 8 characters."); setLoading(false); return; }
        } else {
          if (!email) { setError("Email is required for Entra users."); setLoading(false); return; }
        }
        const payload: CreateUserPayload = {
          username,
          role,
          auth_provider: authProvider,
        };
        if (authProvider === "local") payload.password = password;
        if (email) payload.email = email;
        const created = await adminApi.createUser(payload);
        targetUserID = created.data.id;
      } else if (mode === "edit" && user) {
        const updates: { role?: "admin" | "user"; password?: string; email?: string } = {};
        if (role !== user.role) updates.role = role;
        if (email !== user.email) updates.email = email;
        if (password) {
          if (user.auth_provider === "entra") {
            setError("Entra-managed accounts have no password to reset.");
            setLoading(false);
            return;
          }
          if (password.length < 8) { setError("Password must be at least 8 characters."); setLoading(false); return; }
          updates.password = password;
        }
        await adminApi.updateUser(user.id, updates);
      }
      // Always write group memberships — covers "create + assign" in one
      // round-trip from the admin's POV, and "edit + adjust groups" when
      // only the group set changed. Backend replaces the entire set.
      if (targetUserID != null) {
        await adminApi.setUserGroups(targetUserID, Array.from(selectedGroupIDs));
      }
      onDone();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Operation failed.");
    } finally {
      setLoading(false);
    }
  }

  const showPasswordField = authProvider === "local" && (mode === "create" || (user?.auth_provider !== "entra"));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-zinc-100">
          {mode === "create" ? "Create User" : `Edit ${user?.username}`}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "create" && (
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Auth method</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setAuthProvider("local")}
                  className={`flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    authProvider === "local"
                      ? "border-violet-600 bg-violet-600/20 text-violet-300"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-600"
                  }`}
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  Password + TOTP
                </button>
                <button
                  type="button"
                  onClick={() => setAuthProvider("entra")}
                  className={`flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    authProvider === "entra"
                      ? "border-sky-600 bg-sky-600/20 text-sky-300"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-600"
                  }`}
                >
                  <Cloud className="h-3.5 w-3.5" />
                  Microsoft Entra
                </button>
              </div>
            </div>
          )}

          {mode === "edit" && user && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
              Auth method:&nbsp;
              <span className="text-zinc-200">
                {user.auth_provider === "entra" ? "Microsoft Entra" : "Password + TOTP"}
              </span>
              <span className="text-zinc-600"> (cannot change)</span>
            </div>
          )}

          {mode === "create" && (
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Username</label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="john.doe"
                autoComplete="off"
              />
            </div>
          )}

          {(authProvider === "entra" || (mode === "edit" && user?.auth_provider === "entra")) && (
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Email (must match Microsoft account)</label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@company.com"
                autoComplete="off"
              />
            </div>
          )}

          {showPasswordField && (
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">
                {mode === "create" ? "Temporary password" : "Reset password (leave blank to keep current)"}
              </label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 8 characters"
                autoComplete="new-password"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Role</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setRole("user")}
                className={`flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  role === "user"
                    ? "border-violet-600 bg-violet-600/20 text-violet-300"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-600"
                }`}
              >
                <Users className="h-3.5 w-3.5" />
                User
              </button>
              <button
                type="button"
                onClick={() => setRole("admin")}
                className={`flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  role === "admin"
                    ? "border-amber-600 bg-amber-600/20 text-amber-300"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-600"
                }`}
              >
                <Shield className="h-3.5 w-3.5" />
                Admin
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400 flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              Groups
            </label>
            {groupsLoading ? (
              <p className="text-xs text-zinc-500">Loading…</p>
            ) : groups.length === 0 ? (
              <p className="text-xs text-zinc-500">No groups yet. Create one in the Groups tab.</p>
            ) : (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/40 divide-y divide-zinc-800">
                {groups.map((g) => (
                  <label
                    key={g.id}
                    className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-zinc-900 min-h-11"
                  >
                    <input
                      type="checkbox"
                      checked={selectedGroupIDs.has(g.id)}
                      onChange={() => toggleGroup(g.id)}
                      className="h-4 w-4 rounded border-zinc-600 bg-zinc-900"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-200 truncate flex items-center gap-2">
                        {g.name}
                        {g.is_system && <Badge variant="default" className="text-[9px]">system</Badge>}
                      </p>
                      {g.description && (
                        <p className="text-[11px] text-zinc-500 truncate">{g.description}</p>
                      )}
                    </div>
                    <span className="text-[10px] text-zinc-600 flex-shrink-0">
                      {g.operations.length} ops
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="text-[11px] text-zinc-500">
              Admins bypass groups, so memberships only affect non-admin users.
            </p>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
          {mode === "create" && authProvider === "local" && (
            <p className="text-xs text-zinc-500">
              User will be prompted to change their password on first login.
            </p>
          )}
          {mode === "create" && authProvider === "entra" && (
            <p className="text-xs text-zinc-500">
              No password is set. The user signs in via Microsoft using the email above.
            </p>
          )}
          <div className="flex gap-2 justify-end pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={loading}>
              {mode === "create" ? "Create" : "Save"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EntraSettingsCard({
  initial,
  onSaved,
}: {
  initial: AppSettings;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(initial.entra_enabled);
  const [clientId, setClientId] = useState(initial.entra_client_id);
  const [tenantId, setTenantId] = useState(initial.entra_tenant_id);
  const [redirectURL, setRedirectURL] = useState(initial.entra_redirect_url);
  const [secretInput, setSecretInput] = useState("");
  const [secretWasSet, setSecretWasSet] = useState(initial.entra_client_secret_set);
  const [revealSecret, setRevealSecret] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setError("");
    try {
      const payload: Parameters<typeof settingsApi.update>[0] = {
        entra_enabled: enabled,
        entra_client_id: clientId,
        entra_tenant_id: tenantId,
        entra_redirect_url: redirectURL,
      };
      // Only send secret if user typed a new value. Empty input means
      // "leave existing ciphertext alone" — backend mirrors that contract.
      if (secretInput) payload.entra_client_secret = secretInput;
      await settingsApi.update(payload);
      if (secretInput) setSecretWasSet(true);
      setSecretInput("");
      setRevealSecret(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Failed to save Entra settings.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Cloud className="h-4 w-4" />
          Microsoft Entra ID (SSO)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2 text-sm text-zinc-200">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-600 bg-zinc-900"
          />
          Enable "Sign in with Microsoft" on the login page
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Tenant ID</label>
            <Input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Client ID</label>
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400">Redirect URL</label>
          <Input
            value={redirectURL}
            onChange={(e) => setRedirectURL(e.target.value)}
            placeholder="https://your-host/api/auth/entra/callback"
            autoComplete="off"
          />
          <p className="text-xs text-zinc-500">
            Must exactly match the redirect URI registered in Azure Portal.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400">Client secret</label>
          {secretWasSet && !revealSecret && !secretInput ? (
            <div className="flex gap-2">
              <Input value="••••••••••••••••" disabled />
              <Button type="button" size="sm" variant="ghost" onClick={() => setRevealSecret(true)}>
                Replace
              </Button>
            </div>
          ) : (
            <Input
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder={secretWasSet ? "Enter new secret to replace" : "Paste client secret"}
              autoComplete="new-password"
            />
          )}
          <p className="text-xs text-zinc-500">
            Stored encrypted at rest. Leave blank to keep the existing secret.
          </p>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div>
          <Button size="sm" onClick={save}>{saved ? "Saved!" : "Save"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// GitHubSettingsCard mirrors the Entra card: a Save panel for the OAuth
// App credentials, then a Connect / Disconnect lifecycle button. The
// access token (the result of the OAuth dance) is owned by the server —
// the UI only shows "connected as @<login>".
function GitHubSettingsCard({
  initial,
  onSaved,
  banner,
}: {
  initial: AppSettings;
  onSaved: () => void;
  banner: string | null;
}) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [enabled, setEnabled] = useState(initial.github_enabled);
  const [clientId, setClientId] = useState(initial.github_client_id);
  const [secretInput, setSecretInput] = useState("");
  const [secretWasSet, setSecretWasSet] = useState(initial.github_client_secret_set);
  const [revealSecret, setRevealSecret] = useState(false);
  const [webhookInput, setWebhookInput] = useState("");
  const [webhookWasSet, setWebhookWasSet] = useState(initial.github_webhook_secret_set);
  const [revealWebhook, setRevealWebhook] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  async function fetchStatus() {
    try {
      const r = await githubApi.status();
      setStatus(r.data);
    } catch {
      // Settings page already handles auth failures via interceptor.
    }
  }
  useEffect(() => {
    fetchStatus();
  }, []);

  function generateWebhookSecret() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const b64 = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    setWebhookInput(b64);
    setRevealWebhook(true);
  }

  async function save() {
    setError("");
    try {
      const payload: Parameters<typeof settingsApi.update>[0] = {
        github_enabled: enabled,
        github_client_id: clientId,
      };
      if (secretInput) payload.github_client_secret = secretInput;
      if (webhookInput) payload.github_webhook_secret = webhookInput;
      await settingsApi.update(payload);
      if (secretInput) setSecretWasSet(true);
      if (webhookInput) setWebhookWasSet(true);
      setSecretInput("");
      setWebhookInput("");
      setRevealSecret(false);
      setRevealWebhook(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
      fetchStatus();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Failed to save GitHub settings.");
    }
  }

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const r = await githubApi.connect();
      window.location.href = r.data.authorize_url;
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Failed to start GitHub connect.");
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await githubApi.disconnect();
      setConfirmDisconnect(false);
      onSaved();
      await fetchStatus();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Disconnect failed.");
    } finally {
      setBusy(false);
    }
  }

  const callbackURL = status?.callback_url ?? "";
  const webhookURL = status?.webhook_url ?? "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Webhook className="h-4 w-4" />
          GitHub Integration
          {status?.connected && (
            <Badge variant="success" className="ml-2">
              Connected as @{status.connected_login}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {banner && (
          <div className="rounded-lg border border-emerald-700/60 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300">
            {banner === "connected"
              ? "GitHub connected successfully."
              : `GitHub returned: ${banner}`}
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-zinc-200">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-600 bg-zinc-900"
          />
          Enable GitHub webhook triggers
        </label>

        <p className="text-xs text-zinc-500">
          Create a GitHub OAuth App at{" "}
          <a
            href="https://github.com/settings/applications/new"
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:underline break-all"
          >
            github.com/settings/applications/new
          </a>{" "}
          with the callback URL below, then paste the Client ID / Client Secret.
        </p>

        {callbackURL && (
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Authorization callback URL</label>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 font-mono break-all">
              {callbackURL}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Client ID</label>
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Iv1.xxxxxxxxxxxx"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Client secret</label>
            {secretWasSet && !revealSecret && !secretInput ? (
              <div className="flex gap-2">
                <Input value="••••••••••••••••" disabled />
                <Button type="button" size="sm" variant="ghost" onClick={() => setRevealSecret(true)}>
                  Replace
                </Button>
              </div>
            ) : (
              <Input
                type="password"
                value={secretInput}
                onChange={(e) => setSecretInput(e.target.value)}
                placeholder={secretWasSet ? "Enter new secret to replace" : "Paste client secret"}
                autoComplete="new-password"
              />
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400">Webhook secret (HMAC)</label>
          {webhookWasSet && !revealWebhook && !webhookInput ? (
            <div className="flex flex-col sm:flex-row gap-2">
              <Input value="••••••••••••••••" disabled />
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setRevealWebhook(true)}>
                  Replace
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={generateWebhookSecret}>
                  <RefreshCw className="h-3 w-3 mr-1" /> Generate
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                type="text"
                value={webhookInput}
                onChange={(e) => setWebhookInput(e.target.value)}
                placeholder={webhookWasSet ? "Enter new webhook secret" : "Click Generate"}
                autoComplete="off"
              />
              <Button type="button" size="sm" variant="ghost" onClick={generateWebhookSecret}>
                <RefreshCw className="h-3 w-3 mr-1" /> Generate
              </Button>
            </div>
          )}
          <p className="text-xs text-zinc-500">
            Used by codeci to sign and verify every webhook delivery. Rotating it
            re-syncs hooks on next "Save trigger" but invalidates pending payloads
            in flight.
          </p>
        </div>

        {webhookURL && (
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Webhook payload URL</label>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 font-mono break-all">
              {webhookURL}
            </div>
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex flex-col sm:flex-row gap-2">
          <Button size="sm" onClick={save}>
            {saved ? "Saved!" : "Save"}
          </Button>
          {status?.connected ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDisconnect(true)}
              disabled={busy}
            >
              <Link2Off className="h-3.5 w-3.5 mr-1" /> Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={connect}
              disabled={busy || !enabled || !clientId || (!secretWasSet && !secretInput)}
            >
              <Link2 className="h-3.5 w-3.5 mr-1" /> Connect with GitHub
            </Button>
          )}
        </div>

        {confirmDisconnect && (
          <ConfirmDialog
            message="Disconnect GitHub? Every webhook codeci registered will be removed from GitHub. Pipeline triggers stay configured but will stop firing until you reconnect."
            onCancel={() => setConfirmDisconnect(false)}
            onConfirm={disconnect}
            loading={busy}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function Settings() {
  const { username: currentUsername } = useAuthStore();
  const setAppName = useAppConfigStore((s) => s.setName);
  // Tab state lives in the URL hash (#users / #groups / etc.) so an admin
  // can deep-link or refresh and land back where they were.
  const [tab, setTab] = useState<SettingsTab>(() => {
    const h = window.location.hash.replace("#", "");
    return (SETTINGS_TABS.find((t) => t.id === h)?.id ?? "general") as SettingsTab;
  });
  useEffect(() => {
    if (window.location.hash !== `#${tab}`) {
      window.history.replaceState({}, "", `#${tab}`);
    }
  }, [tab]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [selectedUser, setSelectedUser] = useState<UserInfo | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<UserInfo | null>(null);
  const [confirmAction, setConfirmAction] = useState<"delete" | "totp_disable" | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");

  const [histPageSize, setHistPageSize] = useState<string>(() => {
    const v = localStorage.getItem(PAGE_SIZE_KEY);
    return v ?? String(DEFAULT_PAGE_SIZE);
  });
  const [histSaved, setHistSaved] = useState(false);

  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [runnerTimeout, setRunnerTimeout] = useState<string>("60");
  const [runnerTimeoutSaved, setRunnerTimeoutSaved] = useState(false);
  const [runnerTimeoutError, setRunnerTimeoutError] = useState("");
  const [historyLimit, setHistoryLimit] = useState<string>("50");
  const [historyLimitSaved, setHistoryLimitSaved] = useState(false);
  const [historyLimitError, setHistoryLimitError] = useState("");
  const [appNameInput, setAppNameInput] = useState<string>("");
  const [appNameSaved, setAppNameSaved] = useState(false);
  const [appNameError, setAppNameError] = useState("");

  // ?github=connected|state_mismatch|... arrives from the OAuth callback redirect.
  // Read it once, render an inline banner inside the GitHub card, then strip
  // the query string so a refresh doesn't re-show it.
  const [githubBanner, setGithubBanner] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const v = url.searchParams.get("github");
    if (v) {
      setGithubBanner(v);
      url.searchParams.delete("github");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  function saveHistSettings() {
    const n = parseInt(histPageSize, 10);
    if (!isNaN(n) && n >= 5 && n <= 200) {
      localStorage.setItem(PAGE_SIZE_KEY, String(n));
      setHistSaved(true);
      setTimeout(() => setHistSaved(false), 2000);
    }
  }

  async function saveRunnerTimeout() {
    const n = parseInt(runnerTimeout, 10);
    if (isNaN(n) || n < 1 || n > 1440) {
      setRunnerTimeoutError("Must be between 1 and 1440 minutes.");
      return;
    }
    setRunnerTimeoutError("");
    try {
      await settingsApi.update({ runner_timeout_minutes: n });
      setRunnerTimeoutSaved(true);
      setTimeout(() => setRunnerTimeoutSaved(false), 2000);
    } catch {
      setRunnerTimeoutError("Failed to save.");
    }
  }

  async function saveHistoryLimit() {
    const n = parseInt(historyLimit, 10);
    if (isNaN(n) || n < 1 || n > 10000) {
      setHistoryLimitError("Must be between 1 and 10000.");
      return;
    }
    setHistoryLimitError("");
    try {
      await settingsApi.update({ pipeline_history_limit: n });
      setHistoryLimitSaved(true);
      setTimeout(() => setHistoryLimitSaved(false), 2000);
    } catch {
      setHistoryLimitError("Failed to save.");
    }
  }

  const fetchUsers = () => {
    adminApi.listUsers().then((r) => setUsers(r.data)).finally(() => setLoading(false));
  };

  const fetchSettings = () => {
    settingsApi.get()
      .then((r) => {
        setAppSettings(r.data);
        setRunnerTimeout(String(r.data.runner_timeout_minutes));
        setHistoryLimit(String(r.data.pipeline_history_limit || 50));
        setAppNameInput(r.data.application_name);
        setAppName(r.data.application_name);
      })
      .catch(() => {});
  };

  async function saveAppName() {
    const name = appNameInput.trim();
    if (!name) {
      setAppNameError("Application name cannot be empty.");
      return;
    }
    if (name.length > 64) {
      setAppNameError("Must be 64 characters or fewer.");
      return;
    }
    setAppNameError("");
    try {
      await settingsApi.update({ application_name: name });
      setAppName(name);
      setAppNameSaved(true);
      setTimeout(() => setAppNameSaved(false), 2000);
    } catch {
      setAppNameError("Failed to save.");
    }
  }

  useEffect(() => {
    fetchUsers();
    fetchSettings();
  }, []);

  function openEdit(user: UserInfo) {
    setSelectedUser(user);
    setModalMode("edit");
  }

  function openCreate() {
    setSelectedUser(null);
    setModalMode("create");
  }

  function openConfirm(user: UserInfo, action: "delete" | "totp_disable") {
    setConfirmTarget(user);
    setConfirmAction(action);
    setActionError("");
  }

  async function handleConfirm() {
    if (!confirmTarget || !confirmAction) return;
    setActionLoading(true);
    setActionError("");
    try {
      if (confirmAction === "delete") {
        await adminApi.deleteUser(confirmTarget.id);
      } else if (confirmAction === "totp_disable") {
        await adminApi.updateUser(confirmTarget.id, { totp_disable: true });
      }
      fetchUsers();
      setConfirmTarget(null);
      setConfirmAction(null);
    } catch (err: any) {
      setActionError(err?.response?.data?.message ?? "Action failed.");
    } finally {
      setActionLoading(false);
    }
  }

  const stats = {
    total: users.length,
    admins: users.filter((u) => u.role === "admin").length,
    totp: users.filter((u) => u.totp_enabled).length,
  };

  return (
    <Layout>
      <PageHeader
        title="Settings"
        description="Manage users and system configuration"
      />

      {/* Tab bar — horizontally scrollable on small screens. -mb-px so the
          active tab's border-bottom merges with the surrounding divider. */}
      <div className="border-b border-zinc-800 px-2 md:px-8">
        <div className="flex gap-1 overflow-x-auto -mb-px">
          {SETTINGS_TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-2 px-3 sm:px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors min-h-11",
                  active
                    ? "border-violet-500 text-violet-300"
                    : "border-transparent text-zinc-400 hover:text-zinc-200"
                )}
                aria-selected={active}
                role="tab"
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-4 md:p-8 space-y-6">
        {/* Stats — visible on all tabs as a quick at-a-glance summary. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { label: "Total Users", value: stats.total },
            { label: "Admins", value: stats.admins },
            { label: "2FA Enabled", value: stats.totp },
          ].map(({ label, value }) => (
            <Card key={label}>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-zinc-500">{label}</p>
                <p className="text-2xl font-bold text-zinc-100 mt-1">{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {tab === "general" && <>
        {/* Application Branding & Version */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Tag className="h-4 w-4" />
              Application
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5 max-w-md">
              <label className="text-xs text-zinc-400">Application name</label>
              <div className="flex gap-2">
                <Input
                  value={appNameInput}
                  onChange={(e) => { setAppNameInput(e.target.value); setAppNameSaved(false); setAppNameError(""); }}
                  placeholder="Codeci"
                  maxLength={64}
                />
                <Button size="sm" onClick={saveAppName}>
                  {appNameSaved ? "Saved!" : "Save"}
                </Button>
              </div>
              {appNameError && <p className="text-xs text-red-400">{appNameError}</p>}
              <p className="text-xs text-zinc-500">
                Shown in the sidebar, browser title, login page, and TOTP issuer label. Updates take effect immediately.
              </p>
            </div>
            <div className="space-y-1.5 max-w-md">
              <label className="text-xs text-zinc-400">Version</label>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-300 font-mono">
                {appSettings?.version || "—"}
              </div>
              <p className="text-xs text-zinc-500">
                Build version of the running server. Set at compile time via <code className="text-zinc-400">-ldflags "-X main.Version=..."</code>.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Pipeline History Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <History className="h-4 w-4" />
              Pipeline History
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5 max-w-xs">
              <label className="text-xs text-zinc-400">History limit (1–10000)</label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  max={10000}
                  value={historyLimit}
                  onChange={(e) => { setHistoryLimit(e.target.value); setHistoryLimitSaved(false); setHistoryLimitError(""); }}
                  placeholder="50"
                />
                <Button size="sm" onClick={saveHistoryLimit}>
                  {historyLimitSaved ? "Saved!" : "Save"}
                </Button>
              </div>
              {historyLimitError && <p className="text-xs text-red-400">{historyLimitError}</p>}
              <p className="text-xs text-zinc-500">
                Maximum completed runs retained per user. When a new run finishes, older runs beyond this limit are deleted. Default: 50.
              </p>
            </div>
            <div className="space-y-1.5 max-w-xs">
              <label className="text-xs text-zinc-400">Items per page (5–200)</label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={5}
                  max={200}
                  value={histPageSize}
                  onChange={(e) => { setHistPageSize(e.target.value); setHistSaved(false); }}
                  placeholder="25"
                />
                <Button size="sm" onClick={saveHistSettings}>
                  {histSaved ? "Saved!" : "Save"}
                </Button>
              </div>
              <p className="text-xs text-zinc-500">
                Controls how many runs appear per page in Run History. Changes take effect on next visit to Run History.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Runner Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Timer className="h-4 w-4" />
              Runner Execution
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5 max-w-xs">
              <label className="text-xs text-zinc-400">Runner timeout (minutes, 1–1440)</label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  value={runnerTimeout}
                  onChange={(e) => { setRunnerTimeout(e.target.value); setRunnerTimeoutSaved(false); setRunnerTimeoutError(""); }}
                  placeholder="60"
                />
                <Button size="sm" onClick={saveRunnerTimeout}>
                  {runnerTimeoutSaved ? "Saved!" : "Save"}
                </Button>
              </div>
              {runnerTimeoutError && <p className="text-xs text-red-400">{runnerTimeoutError}</p>}
              <p className="text-xs text-zinc-500">
                Maximum duration for a single pipeline run. Applies to new runs only. Default: 60 minutes.
              </p>
            </div>
          </CardContent>
        </Card>
        </>}

        {tab === "auth" && appSettings && (
          <EntraSettingsCard initial={appSettings} onSaved={fetchSettings} />
        )}

        {tab === "github" && appSettings && (
          <GitHubSettingsCard
            initial={appSettings}
            onSaved={fetchSettings}
            banner={githubBanner}
          />
        )}

        {tab === "groups" && <GroupsCard />}

        {tab === "users" && (
        /* User table */
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Users className="h-4 w-4" />
                User Management
              </CardTitle>
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add User
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
              {/* Mobile: card list */}
              <div className="md:hidden flex flex-col gap-2 p-3">
                {users.map((user) => (
                  <div
                    key={user.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3"
                  >
                    <div className="flex items-start gap-2">
                      <div className="h-8 w-8 rounded-full bg-violet-600/30 flex items-center justify-center flex-shrink-0">
                        <span className="text-xs font-medium text-violet-300">
                          {user.username[0]?.toUpperCase()}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-zinc-200 truncate">{user.username}</span>
                          {user.username === currentUsername && (
                            <span className="text-[10px] text-zinc-600">(you)</span>
                          )}
                        </div>
                        {user.email && (
                          <p className="text-xs text-zinc-500 truncate">{user.email}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      {user.auth_provider === "entra" ? (
                        <Badge variant="default">
                          <Cloud className="h-3 w-3 mr-1 inline" /> Entra
                        </Badge>
                      ) : (
                        <Badge variant="default">
                          <KeyRound className="h-3 w-3 mr-1 inline" /> Local
                        </Badge>
                      )}
                      <Badge variant={user.role === "admin" ? "warning" : "default"}>
                        {user.role}
                      </Badge>
                      {user.totp_enabled ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400 text-xs">
                          <ShieldCheck className="h-3.5 w-3.5" /> 2FA
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-zinc-600 text-xs">
                          <ShieldOff className="h-3.5 w-3.5" /> No 2FA
                        </span>
                      )}
                      {user.must_change_password ? (
                        <Badge variant="warning">pw reset</Badge>
                      ) : (
                        <Badge variant="success">active</Badge>
                      )}
                    </div>
                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-zinc-800">
                      <span className="text-[11px] text-zinc-500">
                        Created {new Date(user.created_at).toLocaleDateString()}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(user)}
                          title="Edit user"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                        {user.totp_enabled && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openConfirm(user, "totp_disable")}
                            title="Disable 2FA"
                          >
                            <ShieldOff className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {user.username !== currentUsername && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openConfirm(user, "delete")}
                            title="Delete user"
                            className="text-red-500 hover:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {actionError && confirmTarget?.id === user.id && (
                      <p className="text-xs text-red-400 mt-2">{actionError}</p>
                    )}
                  </div>
                ))}
              </div>

              {/* Desktop: table */}
              <div className="hidden md:block overflow-hidden rounded-b-xl">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-zinc-900/80">
                      <th className="px-4 py-3 text-left font-medium text-zinc-400">Username</th>
                      <th className="px-4 py-3 text-left font-medium text-zinc-400">Auth</th>
                      <th className="px-4 py-3 text-left font-medium text-zinc-400">Role</th>
                      <th className="px-4 py-3 text-left font-medium text-zinc-400">2FA</th>
                      <th className="px-4 py-3 text-left font-medium text-zinc-400">Status</th>
                      <th className="px-4 py-3 text-left font-medium text-zinc-400">Created</th>
                      <th className="px-4 py-3 w-40" />
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user, i) => (
                      <tr
                        key={user.id}
                        className={`border-b border-zinc-800/50 ${i === users.length - 1 ? "border-b-0" : ""}`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="h-7 w-7 rounded-full bg-violet-600/30 flex items-center justify-center">
                              <span className="text-xs font-medium text-violet-300">
                                {user.username[0]?.toUpperCase()}
                              </span>
                            </div>
                            <div className="flex flex-col leading-tight">
                              <span className="font-medium text-zinc-200">{user.username}</span>
                              {user.email && <span className="text-xs text-zinc-500">{user.email}</span>}
                            </div>
                            {user.username === currentUsername && (
                              <span className="text-xs text-zinc-600">(you)</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {user.auth_provider === "entra" ? (
                            <Badge variant="default">
                              <Cloud className="h-3 w-3 mr-1 inline" /> Entra
                            </Badge>
                          ) : (
                            <Badge variant="default">
                              <KeyRound className="h-3 w-3 mr-1 inline" /> Local
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={user.role === "admin" ? "warning" : "default"}>
                            {user.role}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          {user.totp_enabled ? (
                            <span className="flex items-center gap-1 text-emerald-400 text-xs">
                              <ShieldCheck className="h-3.5 w-3.5" /> Enabled
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-zinc-600 text-xs">
                              <ShieldOff className="h-3.5 w-3.5" /> Disabled
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {user.must_change_password ? (
                            <Badge variant="warning">pw reset</Badge>
                          ) : (
                            <Badge variant="success">active</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-zinc-500 text-xs">
                          {new Date(user.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 justify-end">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openEdit(user)}
                              title="Edit user"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                            {user.totp_enabled && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => openConfirm(user, "totp_disable")}
                                title="Disable 2FA"
                              >
                                <ShieldOff className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {user.username !== currentUsername && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => openConfirm(user, "delete")}
                                title="Delete user"
                                className="text-red-500 hover:text-red-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                          {actionError && confirmTarget?.id === user.id && (
                            <p className="text-xs text-red-400 mt-1">{actionError}</p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </CardContent>
        </Card>
        )}
      </div>

      {/* Create / Edit modal */}
      {modalMode && (
        <UserModal
          mode={modalMode}
          user={selectedUser}
          onClose={() => { setModalMode(null); setSelectedUser(null); }}
          onDone={fetchUsers}
        />
      )}

      {/* Confirm dialog */}
      {confirmTarget && confirmAction && (
        <ConfirmDialog
          message={
            confirmAction === "delete"
              ? `Delete user "${confirmTarget.username}"? This cannot be undone.`
              : `Disable 2FA for "${confirmTarget.username}"? They will be able to log in without a code.`
          }
          onConfirm={handleConfirm}
          onCancel={() => { setConfirmTarget(null); setConfirmAction(null); }}
          loading={actionLoading}
        />
      )}
    </Layout>
  );
}
