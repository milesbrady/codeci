import axios from "axios";

const http = axios.create({ baseURL: "/api" });

http.interceptors.request.use((config) => {
  const token = sessionStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto-logout on 401: any expired/invalid JWT trips this and bounces the user
// to /login?expired=1 so the page can show a clear "your session has expired"
// notice. Skipped when we're already on /login to avoid redirect loops.
http.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = err?.response?.status;
    if (status === 401 && !window.location.pathname.startsWith("/login")) {
      try {
        sessionStorage.removeItem("token");
        sessionStorage.removeItem("must_change_password");
      } catch {
        // sessionStorage may be unavailable in some test contexts
      }
      window.location.href = "/login?expired=1";
    }
    return Promise.reject(err);
  }
);

export interface PipelineSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  param_count: number;
}

export interface PipelineOption {
  label: string;
  value: string;
}

export interface PipelineParameter {
  id: string;
  label: string;
  type: "text" | "select" | "checkbox" | "password";
  required: boolean;
  readonly?: boolean;
  default?: string | boolean;
  placeholder?: string;
  options?: PipelineOption[];
  source?: string;
}

export interface CodeBuildStepConfig {
  project: string;
  source_version?: string;
  env?: Record<string, string>;
  buildspec_override?: string;
  timeout_minutes?: number;
}

export interface PipelineStep {
  name: string;
  run?: string;
  runner?: "docker" | "codebuild";
  codebuild?: CodeBuildStepConfig;
}

export interface Pipeline {
  id: string;
  name: string;
  description: string;
  version: string;
  parameters: PipelineParameter[];
  steps: PipelineStep[];
}

export interface ExecutionRun {
  ID: number;
  PipelineID: string;
  PipelineName: string;
  UserID: number;
  UserName: string;
  Status: string;
  StartedAt: string;
  FinishedAt?: string;
  ParamsJSON: string;
}

export interface UserInfo {
  id: number;
  username: string;
  email: string;
  auth_provider: "local" | "entra";
  role: "admin" | "user";
  totp_enabled: boolean;
  must_change_password: boolean;
  created_at: string;
}

export interface MeInfo {
  id: number;
  username: string;
  email: string;
  auth_provider: "local" | "entra";
  role: "admin" | "user";
  totp_enabled: boolean;
  must_change_password: boolean;
}

export const authApi = {
  setupStatus: () =>
    http.get<{ registration_open: boolean }>("/auth/setup"),

  register: (username: string, password: string) =>
    http.post("/auth/register", { username, password }),

  login: (username: string, password: string) =>
    http.post<{ token: string; totp_enabled: boolean; must_change_password: boolean }>("/auth/login", {
      username,
      password,
    }),

  totpSetup: () =>
    http.post<{ qr_image: string; otpauth_url: string }>("/auth/totp/setup"),

  totpVerify: (code: string) =>
    http.post<{ token: string }>("/auth/totp/verify", { code }),

  totpDisable: () =>
    http.delete("/auth/totp"),

  changePassword: (current_password: string, new_password: string) =>
    http.put("/auth/password", { current_password, new_password }),
};

export interface PipelineImportResult {
  filename: string;
  status: "imported" | "renamed" | "error";
  id?: string;
  saved?: string;
  error?: string;
}

export interface PipelineImportResponse {
  imported: number;
  renamed: number;
  errors: number;
  results: PipelineImportResult[];
}

export const pipelinesApi = {
  list: () => http.get<PipelineSummary[]>("/pipelines"),
  get: (id: string) => http.get<Pipeline>(`/pipelines/${id}`),
  getRaw: (id: string) => http.get<{ raw: string }>(`/pipelines/${id}/raw`),
  create: (name: string, raw: string) => http.post<{ id: string; message: string }>("/pipelines", { name, raw }),
  update: (id: string, raw: string) => http.put(`/pipelines/${id}`, { raw }),
  delete: (id: string) => http.delete(`/pipelines/${id}`),
  exportZip: () => http.get("/pipelines/export", { responseType: "blob" }),
  importFiles: (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    return http.post<PipelineImportResponse>("/pipelines/import", fd, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
};

export const gitApi = {
  branches: (repo: string) =>
    http.get<PipelineOption[]>("/git/branches", { params: { repo } }),
};

export interface ScriptSummary {
  id: string;
  name: string;
}

export interface ScriptDetail {
  id: string;
  name: string;
  content: string;
}

export const scriptsApi = {
  list: () => http.get<ScriptSummary[]>("/scripts"),
  get: (id: string) => http.get<ScriptDetail>(`/scripts/${id}`),
  create: (name: string, content: string) =>
    http.post<{ id: string; message: string }>("/scripts", { name, content }),
  update: (id: string, content: string) =>
    http.put(`/scripts/${id}`, { content }),
  delete: (id: string) => http.delete(`/scripts/${id}`),
  exportZip: () => http.get("/scripts/export", { responseType: "blob" }),
};

export interface RunsPage {
  runs: ExecutionRun[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export const runsApi = {
  list: () => http.get<ExecutionRun[]>("/runs"),
  /** Lean polling endpoint — returns only currently-running runs without
   *  the heavy LogsJSON / ParamsJSON columns. Used by Layout badge and
   *  the Active Runs page. */
  listActive: () => http.get<ExecutionRun[]>("/runs/active"),
  listPaginated: (page: number, limit: number) =>
    http.get<RunsPage>("/runs", { params: { page, limit } }),
  get: (id: number) => http.get<ExecutionRun>(`/runs/${id}`),
  getLogs: (id: number) => http.get<import("@/lib/ws").WsMessage[]>(`/runs/${id}/logs`),
  cancel: (id: number) => http.post(`/runs/${id}/cancel`),
  delete: (id: number) => http.delete(`/runs/${id}`),
  clearAll: () => http.delete("/runs"),
};

export const meApi = {
  get: () => http.get<MeInfo>("/me"),
};

export interface DailyBucket {
  date: string;
  total: number;
  success: number;
  failed: number;
}

export interface TopPipeline {
  pipeline_id: string;
  pipeline_name: string;
  count: number;
}

export interface DashboardStats {
  total_pipelines: number;
  total_runs: number;
  success_count: number;
  failed_count: number;
  cancelled_count: number;
  running_count: number;
  success_rate: number;
  avg_duration_seconds: number;
  runs_7_days: DailyBucket[];
  top_pipelines: TopPipeline[];
  recent_runs: ExecutionRun[];
}

export const statsApi = {
  get: () => http.get<DashboardStats>("/stats"),
};

export const favoritesApi = {
  list: () => http.get<string[]>("/me/favorites"),
  add: (id: string) => http.post(`/me/favorites/${encodeURIComponent(id)}`),
  remove: (id: string) => http.delete(`/me/favorites/${encodeURIComponent(id)}`),
};

export interface CreateUserPayload {
  username: string;
  role: "admin" | "user";
  auth_provider: "local" | "entra";
  password?: string;
  email?: string;
}

export const adminApi = {
  listUsers: () => http.get<UserInfo[]>("/admin/users"),
  createUser: (payload: CreateUserPayload) =>
    http.post<UserInfo>("/admin/users", payload),
  updateUser: (
    id: number,
    data: {
      role?: "admin" | "user";
      password?: string;
      email?: string;
      totp_disable?: boolean;
    }
  ) => http.put(`/admin/users/${id}`, data),
  deleteUser: (id: number) => http.delete(`/admin/users/${id}`),
};

export interface AppSettings {
  application_name: string;
  version: string;
  runner_timeout_minutes: number;
  pipeline_history_limit: number;
  entra_enabled: boolean;
  entra_client_id: string;
  entra_tenant_id: string;
  entra_redirect_url: string;
  entra_client_secret_set: boolean;
  github_enabled: boolean;
  github_provider: "oauth_app" | "github_app";
  github_client_id: string;
  github_client_secret_set: boolean;
  github_webhook_secret_set: boolean;
  github_connected: boolean;
  github_connected_login: string;
  github_connected_at?: string;
}

export interface SettingsUpdatePayload {
  application_name?: string;
  runner_timeout_minutes?: number;
  pipeline_history_limit?: number;
  entra_enabled?: boolean;
  entra_client_id?: string;
  entra_tenant_id?: string;
  entra_redirect_url?: string;
  entra_client_secret?: string;
  github_enabled?: boolean;
  github_client_id?: string;
  github_client_secret?: string;
  github_webhook_secret?: string;
}

export const settingsApi = {
  get: () => http.get<AppSettings>("/admin/settings"),
  update: (data: SettingsUpdatePayload) => http.put("/admin/settings", data),
};

export interface PublicAuthConfig {
  entra_enabled: boolean;
  registration_open: boolean;
}

export interface PublicAppConfig {
  name: string;
  version: string;
  terminal_enabled: boolean;
  webhook_base_url: string;
}

export const configApi = {
  getAuth: () => http.get<PublicAuthConfig>("/config/auth"),
  getApp: () => http.get<PublicAppConfig>("/config/app"),
};

export const terminalApi = {
  status: () => http.get<{ active: boolean }>("/terminal/status").then((r) => r.data),
};

export interface ApiKeyInfo {
  id: number;
  user_id: number;
  username?: string;
  name: string;
  prefix_hint: string;
  created_at: string;
  last_used_at?: string;
  revoked_at?: string;
  expires_at?: string;
}

export interface ApiKeyCreateResponse {
  key: ApiKeyInfo;
  plaintext: string;
  warning: string;
}

export interface GitHubStatus {
  enabled: boolean;
  provider: "oauth_app" | "github_app";
  client_id: string;
  client_secret_set: boolean;
  webhook_secret_set: boolean;
  connected: boolean;
  connected_login: string;
  connected_at?: string;
  callback_url: string;
  webhook_url: string;
}

export interface GitHubRepo {
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}

export const githubApi = {
  status: () => http.get<GitHubStatus>("/admin/github/status"),
  connect: () => http.post<{ authorize_url: string }>("/admin/github/connect"),
  disconnect: () => http.post<{ message: string }>("/admin/github/disconnect"),
  listRepos: (q?: string, page = 1) =>
    http.get<GitHubRepo[]>("/admin/github/repos", { params: { q, page } }),
  listBranches: (owner: string, repo: string) =>
    http.get<string[]>("/admin/github/branches", { params: { owner, repo } }),
};

export interface PipelineTrigger {
  id: number;
  pipeline_id: string;
  provider: "github" | "manual";
  repo_owner: string;
  repo_name: string;
  branch: string;
  events: string[];
  active: boolean;
  default_params: Record<string, string>;
  github_hook_id?: number;
  manual_secret_hint?: string;
  manual_url?: string;
  last_fired_at?: string;
  created_at: string;
}

export interface PipelineTriggerInput {
  provider: "github" | "manual";
  repo_owner?: string;
  repo_name?: string;
  branch?: string;
  events?: string[];
  active?: boolean;
  default_params: Record<string, string>;
  regenerate_secret?: boolean;
}

export const triggersApi = {
  get: (pipelineId: string) =>
    http.get<PipelineTrigger | null>(`/pipelines/${pipelineId}/trigger`),
  put: (pipelineId: string, body: PipelineTriggerInput) =>
    http.put<PipelineTrigger>(`/pipelines/${pipelineId}/trigger`, body),
  remove: (pipelineId: string) =>
    http.delete(`/pipelines/${pipelineId}/trigger`),
  test: (pipelineId: string) =>
    http.post<{ run_id: number }>(`/pipelines/${pipelineId}/trigger/test`),
};

export const apiKeysApi = {
  listMine: () => http.get<ApiKeyInfo[]>("/me/api-keys"),
  createMine: (name: string, expiresInHours?: number) =>
    http.post<ApiKeyCreateResponse>("/me/api-keys", {
      name,
      expires_in_hours: expiresInHours ?? 0,
    }),
  revokeMine: (id: number) => http.delete(`/me/api-keys/${id}`),
  adminList: (userId?: number) =>
    http.get<ApiKeyInfo[]>("/admin/api-keys", {
      params: userId ? { user_id: userId } : undefined,
    }),
  adminCreate: (userId: number, name: string, expiresInHours?: number) =>
    http.post<ApiKeyCreateResponse>("/admin/api-keys", {
      user_id: userId,
      name,
      expires_in_hours: expiresInHours ?? 0,
    }),
  adminRevoke: (id: number) => http.delete(`/admin/api-keys/${id}`),
};
