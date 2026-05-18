# Codeci — Programmatic API (v1)

The `/api/v1/*` surface lets external systems and LLM agents drive pipelines
without going through the browser UI. It mirrors the read/trigger paths the
web UI uses, but is designed to be discovered and consumed by an agent:

- Self-describing OpenAPI 3.0 schema at `GET /api/v1/openapi.json`
- Authentication via API keys (`Authorization: Bearer idk_…`)
- JSON responses include follow-up URLs (`logs_url`, `status_url`,
  `cancel_url`) so an agent can navigate the workflow without out-of-band
  knowledge

The legacy `/api/*` surface (used by the web UI) continues to require a JWT
session. Don't point agents at it — the contracts there are tuned for the
React app and may change without notice.

---

## Quick start

### 1. Mint an API key

Sign in to the web UI, open **Profile → API Keys**, click **New API key**,
give it a label (e.g. `claude-agent`), and copy the resulting `idk_…` value.
You only see it once — store it somewhere safe (a secrets manager, an env
var, etc.).

Admins can also mint keys for other users at
`POST /api/admin/api-keys` (see "Admin endpoints" below).

### 2. Verify the key works

```bash
export IDK="idk_…paste your key…"
export HOST="https://your-codeci-host"

curl -sS -H "Authorization: Bearer $IDK" "$HOST/api/v1/me"
# → {"user_id":1,"username":"alice","is_admin":true}
```

### 3. Discover pipelines

```bash
curl -sS -H "Authorization: Bearer $IDK" "$HOST/api/v1/pipelines" | jq
```

```json
{
  "pipelines": [
    { "id": "deploy-application", "name": "Deploy Application", "description": "…", "version": "1.0", "param_count": 4 }
  ]
}
```

### 4. Fetch a pipeline's parameter schema

```bash
curl -sS -H "Authorization: Bearer $IDK" "$HOST/api/v1/pipelines/deploy-application" | jq
```

The response includes each parameter's `id`, `label`, `type`,
`required`, `default`, and `options` (where applicable). LLM agents should
use this directly as their tool input schema.

### 5. Trigger a run

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $IDK" \
  -H "Content-Type: application/json" \
  -d '{"params":{"environment":"staging","branch":"main"}}' \
  "$HOST/api/v1/pipelines/deploy-application/runs"
```

```json
{
  "run_id": 42,
  "pipeline_id": "deploy-application",
  "pipeline_name": "Deploy Application",
  "status": "running",
  "started_at": "2026-05-11T14:32:01Z",
  "duration_ms": 80,
  "logs_url":   "/api/v1/runs/42/logs",
  "status_url": "/api/v1/runs/42",
  "cancel_url": "/api/v1/runs/42/cancel"
}
```

Required parameters are validated up-front; missing ones return 400 before
any run is created.

### 6. Poll status until done

```bash
while true; do
  STATUS=$(curl -sS -H "Authorization: Bearer $IDK" "$HOST/api/v1/runs/42" | jq -r .status)
  echo "status=$STATUS"
  [ "$STATUS" = "running" ] || break
  sleep 5
done
```

Terminal statuses: `success`, `failed`, `cancelled`, `timed_out`.

### 7. Fetch logs

Plain text (for piping into an LLM prompt):

```bash
curl -sS -H "Authorization: Bearer $IDK" \
  "$HOST/api/v1/runs/42/logs?format=text&tail=200"
```

Structured (for incremental polling — pass `next_since` back as
`since_seq`):

```bash
curl -sS -H "Authorization: Bearer $IDK" \
  "$HOST/api/v1/runs/42/logs?since_seq=0" | jq
```

```json
{
  "run_id": 42,
  "status": "success",
  "messages": [
    {"type":"step",   "data":"build",   "step":"build",   "seq":1, "time": 1715438000000 },
    {"type":"stdout", "data":"…",       "step":"build",   "seq":2, "time": 1715438000123 },
    {"type":"exit",   "code":0,                                          "seq":99 }
  ],
  "next_since": 99
}
```

### 8. (Optional) Wait inline

For short pipelines, pass `?wait=true` to block until completion. The
response then includes the terminal status, `exit_code`, and the duration.

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $IDK" \
  -H "Content-Type: application/json" \
  -d '{"params":{"environment":"staging"}}' \
  "$HOST/api/v1/pipelines/deploy-application/runs?wait=true&timeout_seconds=600"
```

`timeout_seconds` defaults to 300, max 3600. If the timeout elapses first
the run keeps going on the server — the response just shows the in-flight
state and the agent should switch to polling.

---

## LLM-agent workflow (skill outline)

A minimal skill definition for a Claude agent looks like:

```
Tool: list_pipelines        → GET  /api/v1/pipelines
Tool: get_pipeline_schema   → GET  /api/v1/pipelines/{id}
Tool: trigger_pipeline      → POST /api/v1/pipelines/{id}/runs   body: {params}
Tool: get_run_status        → GET  /api/v1/runs/{run_id}
Tool: get_run_logs          → GET  /api/v1/runs/{run_id}/logs?format=text&tail=N
Tool: cancel_run            → POST /api/v1/runs/{run_id}/cancel
```

Suggested system prompt instructions for the agent:

1. Always call `get_pipeline_schema` before `trigger_pipeline` to confirm
   the `required` parameters and their types.
2. Substitute `${param_id}` values exactly — the server rejects values
   containing `;`, `&&`, `||`, `` ` ``, `$(`, `${`, `\n`, `\r`.
3. After triggering, poll `get_run_status` every ~5 seconds until
   `status != "running"`.
4. On failure, fetch `get_run_logs?format=text&tail=200&include_stdout=false`
   to focus on stderr lines — `failure_reason` and `failed_step` from the
   status response usually pinpoint the problem.

---

## Authentication & authorization

| | |
|---|---|
| Header | `Authorization: Bearer idk_<hex>` (also accepts `X-API-Key: idk_<hex>`) |
| TOTP | Skipped — API keys are post-TOTP by design. The key issuance flow is the second factor. |
| Role | Inherits the issuing user's role. Admin keys see all runs; user keys see their own. |
| Revocation | Immediate — once a key is revoked, the next request 401s. |
| Hashing | SHA-256 hex digest is stored; the plaintext is never persisted. |
| Last used | Server records `last_used_at` (async) on every successful request. |

### Rotating a key

1. Mint a new key.
2. Switch the agent to the new key.
3. Revoke the old key.

There is no "rollover" period — keys are independent.

### Expiry

Pass `expires_in_hours` when minting to time-bound a key. After expiry the
key 401s automatically; revoke it explicitly if you don't want it to remain
listed.

---

## Endpoint reference

### Discovery (unauthenticated)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/health` | Health probe with version + UTC time. |
| GET | `/api/v1/openapi.json` | OpenAPI 3.0 spec for this surface. |

### Identity

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/me` | Returns the calling key's user (id, username, is_admin). |

### Pipelines

| Method | Path | Description |
|---|---|---|
| GET  | `/api/v1/pipelines` | List pipelines (summary). |
| GET  | `/api/v1/pipelines/{id}` | Pipeline detail + parameter schema. |
| POST | `/api/v1/pipelines/{id}/runs` | Trigger a run. Body: `{"params": {...}}`. Query: `wait`, `timeout_seconds`. |

### Runs

| Method | Path | Description |
|---|---|---|
| GET  | `/api/v1/runs` | List runs (paginated). Query: `page`, `limit` (≤200), `status`, `pipeline_id`. |
| GET  | `/api/v1/runs/{id}` | Get a single run. |
| GET  | `/api/v1/runs/{id}/logs` | Fetch logs. Query: `format=text\|json`, `since_seq`, `tail`, `include_stdout`. |
| POST | `/api/v1/runs/{id}/cancel` | Cancel an active run. |

### Scripts

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/scripts` | List user scripts (read-only on v1). |

### Self-service key management

These go via the regular `/api/*` JWT session (the UI uses them).

| Method | Path | Description |
|---|---|---|
| GET    | `/api/me/api-keys` | List the caller's own keys. |
| POST   | `/api/me/api-keys` | Create a new key. Body: `{name, expires_in_hours?}`. Plaintext returned once. |
| DELETE | `/api/me/api-keys/{id}` | Revoke one of the caller's keys. |

### Admin key management

Require an admin JWT session.

| Method | Path | Description |
|---|---|---|
| GET    | `/api/admin/api-keys?user_id=` | List all keys, optionally filtered. |
| POST   | `/api/admin/api-keys` | Mint a key on behalf of any user. Body: `{user_id, name, expires_in_hours?}`. |
| DELETE | `/api/admin/api-keys/{id}` | Revoke any key. |

---

## Status codes

| Code | Meaning |
|---|---|
| 200  | OK |
| 201  | Created (key generation) |
| 202  | Accepted (run started; agent should poll) |
| 400  | Bad request (missing required param, invalid body) |
| 401  | Missing/invalid/revoked/expired key |
| 403  | Authenticated but the key's user lacks access (rare on v1 — most resources are scoped per user automatically) |
| 404  | Pipeline or run not found |
| 5xx  | Server error — safe to retry |

---

## Limits & guarantees

- Maximum 200 results per `/runs` page.
- In-memory log ring is capped at 10,000 messages per active run; older
  lines are truncated with a synthetic marker so the agent can detect drop.
- LogsJSON column is capped at 5 MB on persistence; the same truncation
  marker is preserved.
- Pipeline run timeout is configurable in **Settings → Runner Timeout**.
  When the timeout fires, the run status becomes `timed_out`.
- API keys are validated on every request (no in-process caching), so
  revocation takes effect immediately.

---

## Security notes

- Treat API keys like passwords. They bypass TOTP.
- Prefer time-bound keys (`expires_in_hours`) for short-lived automation.
- Set `ALLOWED_ORIGIN` correctly — CORS only allows that origin's browser
  to call the API. API keys from server-to-server traffic bypass CORS,
  but this still matters for the UI.
- Revoke a key as soon as it's no longer needed; `last_used_at` lets you
  spot dormant keys.
