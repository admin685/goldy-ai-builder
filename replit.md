# Goldy Builds — AI Project Builder

## Overview

**Goldy Builds** is an AI-powered project builder hub. Users describe any software project idea, and the system autonomously generates full working code via Claude, pushes it to a GitHub repo, and deploys it to Vercel — all in minutes.

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server serving both the Goldy Builds chat UI and the builder backend.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — serves HTML at `/api`, mounts API routes at `/api`, serves static files from `public/`
- Routes:
  - `src/routes/health.ts` — `GET /healthz`
  - `src/routes/build.ts` — `POST /build`, `GET /status`, `POST /domain`, `GET /domain/check`, `POST /callback` — exports shared pipeline functions
  - `src/routes/import.ts` — `POST /import` — ZIP upload, GitHub URL, or Replit URL import + rebuild via Claude
- Static: `public/index.html` — the Goldy Builds chat UI (dark theme, canvas animation, build log, tab switcher)
- Depends on: `@workspace/db`, `@workspace/api-zod`, `@anthropic-ai/sdk`, `adm-zip`, `multer`

**Required environment variables:**
- `ANTHROPIC_API_KEY` — Claude API key for code generation + assembly
- `GITHUB_TOKEN` — GitHub personal access token (scopes: `repo`) for creating repos
- `VERCEL_TOKEN` — Vercel API token for deployment
- `OPENAI_API_KEY` — GPT-4o for premium CSS generation in the multi-AI design pipeline
- `REPLICATE_API_TOKEN` — FLUX Schnell via Replicate for hero image generation
- `RECRAFT_API_KEY` — Recraft v3 for SVG logo generation
- `SECRET_CALLBACK_TOKEN` — optional token to secure the `/callback` endpoint

**Orchestration engine (5-stage sequential pipeline):**
Claude first outputs a JSON task plan (`[{id, agent, task}]`). A task runner then executes each step sequentially, saving to `BuildState.stageData` after each:
1. **ANALYZE** (Claude, ≤400 tokens out) — `project_name`, `description`, `files_to_generate`. No code.
2. **DESIGN** (parallel: GPT-4o CSS ≤1500 tokens, Recraft logo URL, FLUX hero image URL) — all non-fatal; results saved to `stageData`.
3. **CODE** (Claude, ≤4000 tokens out) — receives compact context: description + file list + CSS class-name summary (not full CSS) + URL strings. Emits `<!-- GOLDY_CSS -->`, `<!-- GOLDY_LOGO -->`, `<!-- GOLDY_HERO -->` placeholders.
4. **ASSEMBLE** (string-replace, no AI) — injects GPT-4o CSS, Recraft logo `<img>`, FLUX `background-image` URL via placeholder replacement on `index.html`.
5. **DEPLOY** — same GitHub + Vercel logic as before.

`BuildState` now has `stage: string` (current task label) and `stageData: Partial<StageData>` (accumulated results). `GET /api/status` returns `stage` field.

**CSS class-name summary:** After GPT-4o generates CSS, `extractCssClassSummary(css)` runs a regex to extract up to 40 unique class names (max 300 chars). This summary is what Claude CODE receives instead of the full CSS string.

**UI:** `public/landing.html` has been completely rewritten with clean, readable hand-crafted CSS (single `<style>` block). `public/index.html` had Google Fonts `<link>` tags added. No AI-generated CSS on either page.

**Import & Rebuild flow:**
1. `POST /api/import` — three modes:
   - `multipart/form-data` with `file` field — ZIP file upload
   - JSON `{mode:"github", url}` — fetches `/zipball/HEAD` from GitHub API
   - JSON `{mode:"replit", url}` — fetches `{url}.zip` from Replit public export
2. ZIP parsed with `adm-zip`; binary/large/node_modules files filtered out (max 60 files, 100KB each)
3. All file contents sent to Claude: "Analyze this project, rebuild as clean static HTML/CSS/JS"
4. Rebuilt files go through the same GitHub + Vercel pipeline as Build New
5. Same `GET /api/status` polling, same result card + domain connection panel

**Domain connection:**
- `POST /api/domain` — adds a domain to the Vercel project, returns exact DNS records (A or CNAME)
- `GET /api/domain/check` — polls Vercel for domain verification status

- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
