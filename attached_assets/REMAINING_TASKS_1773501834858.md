# Goldy Builds — Remaining Tasks

## Task #17 — Fix Replit Deployment (CRITICAL)

### What & Why
The deployment keeps failing because the run command looks for `dist/index.cjs` but the build creates `dist/index.mjs`. This blocks the platform from running 24/7 outside of Replit dev mode.

### Done looks like
- `npm run start` successfully starts the server
- Port 8080 opens within 10 seconds
- `GET /api/status` returns `{"status":"idle"}`
- Deployment shows green "Running" status

### Tasks
1. Open `.replit` file — find the `run` field under `[deployment]` section, change `node artifacts/api-server/dist/index.cjs` to `node artifacts/api-server/dist/index.mjs`
2. Open root `package.json` — verify `start` script says `node artifacts/api-server/dist/index.mjs`
3. Open `artifacts/api-server/package.json` — verify `start` script says `node dist/index.mjs`
4. Run build: `cd artifacts/api-server && npm run build` — confirm `dist/index.mjs` is created
5. Redeploy and confirm green status

### Relevant files
- `.replit`
- `package.json`
- `artifacts/api-server/package.json`

---

## Task #18 — Fix Landing Page Hero

### What & Why
The landing page hero has too much empty dark space at the top and the FLUX background image is not loading. The hero needs proper spacing and a CSS gradient fallback.

### Done looks like
- Hero content starts close to navbar (60px padding-top)
- Background is a deep green gradient, not flat black
- FLUX image loads if available, gradient fallback if not
- Goldy mascot is fully visible on the right, not cropped
- Both buttons on same line, green gradient primary

### Tasks
1. Set `#hero { padding-top: 60px }` — remove empty top space
2. Replace FLUX background with CSS gradient fallback:
   ```css
   #hero {
     background: linear-gradient(135deg, #0A1A12 0%, #111C1A 40%, #0D2018 100%);
   }
   ```
   Keep FLUX image URL as `background-image` override if it loads
3. Add dark overlay: `#hero::before { background: rgba(10,22,18,0.65) }`
4. Ensure `.hero-mascot img { height: 440px; width: auto; object-fit: contain; }`
5. Screenshot and verify

### Relevant files
- `artifacts/api-server/public/landing.html`

---

## Task #19 — Editor Preview from Database

### What & Why
The editor iframe tries to load the live Vercel URL which fails due to `X-Frame-Options: deny`. Preview should load HTML directly from the database so it works instantly without X-Frame issues.

### Done looks like
- Editor right panel shows the actual HTML rendered in iframe
- No X-Frame-Options errors
- Preview updates within 2 seconds after each edit
- "Open live site →" button opens goldy.team URL in new tab
- "Deploy to goldy.team →" green button triggers GitHub + Vercel deploy on click only

### Tasks
1. Add `GET /api/preview/:projectId` route — reads `files_json` from DB, returns `index.html` content as `text/html`. No auth required.
2. In `editor.html` — change iframe `src` from Vercel URL to `/api/preview/{projectId}`
3. After each edit completes — reload iframe src to `/api/preview/{projectId}` to show updated HTML
4. Add "Open live site →" button that opens `project.vercel_url` in new tab
5. Add "Deploy to goldy.team →" green button — calls new `POST /api/deploy/:projectId` which triggers GitHub push + Vercel deploy only when clicked. Remove auto-deploy from edit route.
6. Add `POST /api/deploy/:projectId` route — auth protected, runs existing `pushFilesToGitHub` + `deployToVercel` functions

### Relevant files
- `artifacts/api-server/src/routes/edit.ts`
- `artifacts/api-server/src/routes/build.ts` (reuse deploy functions)
- `artifacts/api-server/public/editor.html`

---

## Task #20 — Full Admin Dashboard

### What & Why
The current `/admin` page shows only a basic table. It needs a full sidebar navigation with all sections as specified, matching the Deep Forest design system.

### Done looks like
- Sidebar with 10 menu items
- Overview page with 4 stat cards + builds chart + AI costs breakdown + recent builds table
- Users page with search, filter, actions
- Projects page with filter by status
- Build Logs — live scrolling log
- AI Settings — editable prompts per crew member
- Billing — API costs per service
- Settings — system config

### Layout
```
[SIDEBAR 220px] | [MAIN CONTENT]
```

Sidebar menu items:
1. 📊 Overview (default)
2. 👥 Users
3. 🏗️ Projects
4. 🚀 Deployments
5. 📈 Analytics
6. 📋 Build Logs
7. 🌐 Domains
8. 🤖 AI Settings
9. 💰 Billing
10. ⚙️ Settings

### Tasks
1. Rewrite `admin.html` with sidebar layout — Dark #111C1A, green #34D399 accents, Inter+Syne fonts
2. Overview section:
   - 4 stat cards: Total Users, Total Projects, Success Rate, Monthly AI Cost
   - Bar chart (Chart.js): builds per day last 30 days
   - AI cost breakdown: Goldy/Boris/Masha/Ivan percentages
   - Recent builds table: project name, user, status, URL, time
   - Reset stuck build button (calls `POST /api/admin/reset-build`)
3. Users section: table with email, joined date, projects count, role, actions (block/delete/make admin)
4. Projects section: table with name, owner, URL, status, files count, actions (open/edit/delete)
5. Build Logs section: real-time log feed polling `GET /api/status` every 2s
6. AI Settings section: editable textarea for each crew member's system prompt. Save button calls new `POST /api/admin/prompts` endpoint
7. Billing section: show estimated costs from env vars (calls per day × token cost)
8. Settings section: form for CUSTOM_DOMAIN, build timeout, max files per project

### Relevant files
- `artifacts/api-server/public/admin.html`
- `artifacts/api-server/src/routes/build.ts` (reset-build endpoint exists)

---

## Task #21 — Fix GitHub Token for Public Repos

### What & Why
The current GitHub token is a fine-grained PAT scoped only to `admin685`'s repos. Importing third-party public repos (e.g. `github.com/bradtraversy/50projects50days`) returns 404.

### Done looks like
- Importing `https://github.com/bradtraversy/50projects50days` works
- Any public GitHub repo can be imported
- Private repos still work with auth header

### Tasks
1. In `fetchGitHubZip()` in `import.ts` — if authenticated request returns 404, retry WITHOUT `Authorization` header
2. Public repos don't need auth — unauthenticated GitHub API allows 60 requests/hour for public repos
3. Add fallback logic:
   ```javascript
   // First try with auth
   let response = await fetch(url, { headers: { Authorization: `token ${token}` } })
   // If 404, retry without auth (public repo)
   if (response.status === 404) {
     response = await fetch(url)
   }
   ```
4. Test with `https://github.com/bradtraversy/50projects50days`

### Relevant files
- `artifacts/api-server/src/routes/import.ts`

---

## Task #22 — Self-Improving System (AI Learning)

### What & Why
After each build, the system should save quality metrics. Claude reviews builds weekly and improves prompts automatically. This makes the platform get better over time.

### Done looks like
- Every build saves: idea, files generated, user rating (👍👎), deploy success
- Weekly Claude job analyzes all builds and suggests prompt improvements
- Admin can see prompt history and approve/reject changes
- Good builds (👍) reinforce current prompts
- Bad builds (👎) trigger prompt revision

### Tasks
1. Add `build_feedback` table to PostgreSQL:
   ```sql
   CREATE TABLE build_feedback (
     id SERIAL PRIMARY KEY,
     project_id INT REFERENCES projects(id),
     rating VARCHAR(4), -- 'good' or 'bad'
     comment TEXT,
     created_at TIMESTAMP DEFAULT now()
   );
   ```
2. Add 👍 👎 buttons to result card in `index.html` — calls `POST /api/feedback` with `{projectId, rating}`
3. Add `POST /api/feedback` route — saves to `build_feedback` table
4. Add `GET /api/admin/feedback` route — returns all feedback with project details
5. Add weekly analysis job — every Sunday at midnight, Claude reads last 7 days of builds + feedback and returns suggested prompt improvements. Save to `prompt_history` table.
6. Add Feedback section to admin dashboard — shows ratings, comments, and suggested improvements

### Relevant files
- `artifacts/api-server/src/lib/db.ts`
- `artifacts/api-server/src/routes/build.ts`
- `artifacts/api-server/public/index.html` (result card)
- `artifacts/api-server/public/admin.html`

---

## Task #23 — Mobile Responsive Design

### What & Why
The platform is not tested on mobile. Landing page, builder app, and editor need to work on phones.

### Done looks like
- Landing page: single column on mobile, hamburger menu, mascot hidden on small screens
- Builder app: full width textarea, large touch-friendly buttons
- Editor: on mobile shows only chat panel (no split screen), "Preview" tab to switch
- Dashboard: cards stack vertically

### Tasks
1. `landing.html` — verify mobile breakpoints work: nav collapses to hamburger, hero goes single column, features grid goes 1-column
2. `index.html` — ensure textarea and buttons are full width on mobile, touch-friendly (min 44px tap targets)
3. `editor.html` — on screens < 768px: hide iframe panel, show only chat. Add "Preview" button that shows iframe in a modal overlay
4. `dashboard.html` — project cards go to single column
5. Test on 375px (iPhone) and 768px (iPad) viewport

### Relevant files
- `artifacts/api-server/public/landing.html`
- `artifacts/api-server/public/index.html`
- `artifacts/api-server/public/editor.html`
- `artifacts/api-server/public/dashboard.html`

---

## Priority Order

| Priority | Task | Effort | Impact |
|----------|------|--------|--------|
| 🔴 1 | #17 Fix Deployment | 30 min | Critical — platform must run 24/7 |
| 🔴 2 | #18 Fix Landing Hero | 15 min | First impression |
| 🟡 3 | #19 Editor Preview from DB | 2 hours | Core editor feature |
| 🟡 4 | #20 Full Admin Dashboard | 4 hours | Platform management |
| 🟡 5 | #21 Fix GitHub Import | 30 min | Import feature |
| 🟢 6 | #22 Self-Improving System | 3 hours | Long-term value |
| 🟢 7 | #23 Mobile Responsive | 2 hours | User experience |

---

*Start with Task #17 — without stable deployment nothing else matters.*
