# Codeci

A lightweight self-hosted DevOps web UI for running pipelines defined as YAML, with live log streaming and per-run isolation.

## What it does

- **Define pipelines as YAML.** Drop a file in `pipelines/` and the UI picks it up — no restart, no rebuild.
- **Run them from the browser.** Each pipeline gets a typed form (text, select, checkbox, password, dynamic git-branch dropdowns) generated from its parameter schema.
- **Watch them execute live.** Logs stream over WebSockets with step-by-step progress, colour-coded output, and an animated step tracker.
- **Run more than one at a time.** Multiple pipelines can execute in parallel without blocking each other.
- **Pick up where you left off.** Closing your browser doesn't kill a run. Re-open the page and the full log replays before live output resumes.

## Highlights

- **Ephemeral runners** — every pipeline runs in its own short-lived Docker container, then cleans itself up.
- **Active runs view** — a dedicated sidebar section showing every in-flight pipeline with a live elapsed timer.
- **Run history** — full searchable log of every completed execution, with stored output.
- **Authentication** — local accounts with bcrypt + TOTP two-factor, or Microsoft Entra ID single sign-on. Both can be used on the same instance.
- **Admin recovery CLI** — same binary, different mode: reset TOTP, list users, toggle Entra, all from a `docker exec` on the running container.
- **Programmatic API** — `/api/v1/*` surface designed for CI systems and LLM agents. Authenticate with an API key minted in Profile → API Keys; full spec at `GET /api/v1/openapi.json`. See [docs/api.md](docs/api.md).

## Tech stack

- **Backend** — Go, Echo, GORM, PostgreSQL
- **Frontend** — React, TypeScript, Vite, Tailwind
- **Realtime** — WebSockets
- **Execution** — Docker (ephemeral containers per run)

## Repo layout

```
pipelines/    YAML pipeline definitions
server/       Go backend
web/          React frontend
runner/       Runner container image
user-scripts/        user shell scripts
```

## Pipeline example

```yaml
name: Deploy service
description: Deploys a service from a git branch
version: "1.0"

parameters:
  - id: repo
    label: Repository URL
    type: text
    required: true
  - id: branch
    label: Branch
    type: select
    source: git-branches:repo
    default: main

steps:
  - name: Clone
    run: git clone --branch ${branch} ${repo} /tmp/work
  - name: Deploy
    run: cd /tmp/work && ./deploy.sh
```

That's the whole contract. Save it, refresh the UI, the pipeline appears with a typed form and a branch dropdown that auto-populates from the repo URL.

## Running locally

Requires Docker, Go 1.25, Node 24, and PostgreSQL.

```bash
# Backend
cd server
DATABASE_URL=postgres://devops:devops@localhost:5432/devops?sslmode=disable \
JWT_SECRET=... TOTP_ENCRYPTION_KEY=... \
go run main.go

# Frontend
cd web && npm run dev
```

Backend on `:8080`, frontend on `:5173`.

## License

Internal project.
