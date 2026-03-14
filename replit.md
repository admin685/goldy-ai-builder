# Goldy Builds — AI Project Builder

## Overview

**Goldy Builds** is an autonomous AI platform. Users describe any software project idea, and the system generates full working code via a 6-crew AI pipeline (Claude + GPT-4o + FLUX + Recraft), pushes to GitHub, deploys to Vercel, and returns a live `{name}.goldy.team` URL.

pnpm workspace monorepo using TypeScript and Express.

## Pages

- `/` — landing page
- `/app` — builder (new project prompt)
- `/dashboard` — user's projects list
- `/editor?id={projectId}` — split-screen editor (chat left + preview iframe right)
- `/login`, `/register` — auth pages
- `/admin` — admin panel (users + all projects)

## Stack

- **Runtime**: Node.js 24, TypeScript 5.9
- **Framework**: Express 5
- **Database**: PostgreSQL (Replit-managed), direct `pg` pool queries
- **Auth**: JWT (7-day), bcryptjs, `requireAuth` / `requireAdmin` middleware
- **AI**: Anthropic Claude (`claude-opus-4-5`), OpenAI GPT-4o, Replicate FLUX, Recraft v3
- **Deploy targets**: GitHub API + Vercel API
- **Custom domain**: `goldy.team` (env var `CUSTOM_DOMAIN`)

## Structure

```
artifacts/api-server/
├── src/
│   ├── index.ts           — port binding, seedAdmin
│   ├── app.ts             — Express setup, static HTML routes, /api mount
│   ├── middlewares/
│   │   └── auth.ts        — JWT parse, requireAuth, requireAdmin, signToken
│   ├── lib/
│   │   ├── db.ts          — pg Pool, query/queryOne helpers
│   │   ├── projects.ts    — saveProject() INSERT
│   │   └── seed-admin.ts  — creates admin user on first boot
│   └── routes/
│       ├── index.ts       — mounts all routers
│       ├── auth.ts        — /register, /login, /auth/projects, /auth/admin/*
│       ├── build.ts       — 5-stage build pipeline + /build, /status, /domain, /admin/reset-build
│       ├── import.ts      — /import (ZIP / GitHub / Replit) with per-file rebuild
│       ├── edit.ts        — /edit, /edit/confirm, /edit/discard, /edit/status, /edit/history
│       └── health.ts      — /healthz
├── public/
│   ├── index.html         — landing page
│   ├── app.html           — builder UI
│   ├── dashboard.html     — project dashboard
│   ├── editor.html        — split-screen editor (40% chat / 60% preview)
│   ├── login.html
│   ├── register.html
│   └── admin.html
```

## DB Schema (PostgreSQL)

```sql
users        (id SERIAL PK, email TEXT UNIQUE, password_hash TEXT, role TEXT default 'user', created_at)
projects     (id SERIAL PK, user_id INT FK, name TEXT, vercel_url TEXT, github_url TEXT, files_json TEXT, created_at)
edit_history (id SERIAL PK, project_id INT FK, role TEXT, message TEXT, created_at)
```

`files_json` is a JSON string of `Record<string, string>` — all project file paths and their contents. The project list API deliberately does NOT select this column (too large). The editor fetches it separately.

## Build Pipeline (build.ts) — 5 stages

All state lives in one in-memory `BuildState` object, exported and shared with import.ts.

1. **ANALYZE** (Claude, ≤600 tokens out) — returns `{project_name, description, files_to_generate: [...]}`. No code.
2. **DESIGN** (parallel: GPT-4o CSS ≤3000 tokens, Recraft logo URL, FLUX hero image URL) — all non-fatal.
3. **CODE** (Claude, per-file: one call per file, each ≤8000 tokens, ordered CSS → JS → HTML → README) — each call gets CSS class summary + previously-generated files for consistency.
4. **ASSEMBLE** (no AI) — prepend Boris's CSS to `style.css`; replace `<!-- GOLDY_LOGO -->` and `<!-- GOLDY_HERO -->` placeholders in all HTML files.
5. **DEPLOY** — `createGitHubRepo` + `pushFilesToGitHub` (Petya), then `deployToVercel` with custom domain mapping (Vasya). Saves to DB via `saveProject()`.

### Stuck-build protection
- `BuildState` has `startedAt?: number` (set in `resetState`).
- `clearIfTimedOut()` — if `status === "building"` and `Date.now() - startedAt > 20min`, resets to idle. Called at the top of `POST /build` and `POST /import` guards.
- `POST /api/admin/reset-build` (admin-only JWT) — force-resets state to idle immediately; returns `{ok:true, previous}`.
- Server restart always resets state to idle (module-level init).

## Import Pipeline (import.ts)

Same per-file approach as build, not a single JSON blob:
1. Fetch ZIP from GitHub API (`/zipball/HEAD` with auth), Replit export, or direct upload.
2. Extract with `adm-zip`; skip binaries/node_modules (max 60 files, 100KB each).
3. Run design pipeline (Boris, Masha, Ivan) based on project hint.
4. **Analyze** (Claude, ≤600 tokens) — returns project name + description + files_to_generate.
5. **Per-file generation** (Claude, ≤8000 tokens each) — each file receives source file snippets as context.
6. **Assemble** — same CSS/logo/hero injection as build.
7. **Deploy** — GitHub + Vercel.

**GitHub token note**: The `GITHUB_TOKEN` is a fine-grained PAT scoped to `admin685`'s repos only. Importing third-party public repos returns 404. Import works for any repo the token has access to.

## Editor / Edit Pipeline (edit.ts)

Per-project edit state in a `Map<number, EditState>`. Statuses: `idle → editing → preview → confirming → done | error`.

### `POST /edit` (start edit)
Two-step targeted approach (no single-blob JSON):
1. **Identify** (Claude, ≤400 tokens) — given file list + instruction, returns `{files_to_edit: ["index.html"]}`.
2. **Per-file edit** (Claude, ≤8000 tokens each) — edits only the identified files; others are preserved unchanged. Each call receives the full current file content + snippets of other files for context.
3. **Preview deploy** — deploys to `{name}-preview` Vercel project (no DB write, no GitHub push).
4. State moves to `preview`; client sees two buttons.

### `POST /edit/confirm`
Pushes to GitHub (SHA-based update) + deploys to production Vercel project + UPDATE DB `files_json` + saves to `edit_history`.

### `POST /edit/discard`
Resets state to idle, clears pending files/project.

## API Routes Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/register | — | Create user, returns JWT |
| POST | /api/auth/login | — | Returns JWT |
| GET | /api/auth/projects | user | Own projects (no files_json) |
| GET | /api/auth/admin/users | admin | All users |
| GET | /api/auth/admin/projects | admin | All projects |
| POST | /api/build | user | Start 5-stage build |
| GET | /api/status | — | Poll build status |
| POST | /api/admin/reset-build | admin | Force-reset stuck build |
| POST | /api/import | user | Import from ZIP/GitHub/Replit |
| POST | /api/edit | user | Start per-file edit |
| GET | /api/edit/status | user | Poll edit status |
| POST | /api/edit/confirm | user | Deploy preview to production |
| POST | /api/edit/discard | user | Discard pending preview |
| GET | /api/edit/history | user | Chat history for project |
| POST | /api/domain | — | Add custom domain to Vercel |
| GET | /api/domain/check | — | Check domain verification |

## Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `PORT` | ✅ | Set by Replit |
| `DATABASE_URL` | ✅ | Set by Replit |
| `JWT_SECRET` | ✅ | Manual secret |
| `ANTHROPIC_API_KEY` | ✅ | Claude API |
| `OPENAI_API_KEY` | ✅ | GPT-4o (Boris CSS) |
| `GITHUB_TOKEN` | ✅ | Fine-grained PAT for admin685 repos |
| `VERCEL_TOKEN` | ✅ | Vercel deploy API |
| `REPLICATE_API_TOKEN` | ✅ | FLUX hero images |
| `RECRAFT_API_KEY` | ✅ | Recraft v3 logos |
| `CUSTOM_DOMAIN` | ✅ | `goldy.team` |
| `ADMIN_EMAIL` | ✅ | Seed admin account |
| `ADMIN_PASSWORD` | ✅ | Seed admin account |

## Running Locally

```bash
pnpm --filter @workspace/api-server run dev
```

Server listens on `$PORT`. All HTML pages served at `/api/{page}` via explicit Express routes.
