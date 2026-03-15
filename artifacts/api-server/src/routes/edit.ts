import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "../middlewares/auth.js";
import { query, queryOne } from "../lib/db.js";
import { pushFilesToGitHub, deployToVercel } from "./build.js";

const router = Router();

// ── Per-project edit state ────────────────────────────────────────────────

interface EditLog {
  ts: number;
  msg: string;
  type: "info" | "success" | "error" | "warn";
}

interface ProjectRow {
  id: number;
  user_id: number;
  name: string;
  vercel_url: string | null;
  github_url: string | null;
  files_json: string | null;
}

interface EditState {
  status: "idle" | "editing" | "preview" | "confirming" | "done" | "error";
  logs: EditLog[];
  error?: string;
  result?: { previewUrl?: string; productionUrl?: string; repoUrl?: string };
  // Pending changes waiting for user approval
  pendingFiles?: Record<string, string>;
  pendingProject?: ProjectRow;
}

interface HistoryRow {
  id: number;
  role: "user" | "goldy";
  message: string;
  created_at: string;
}

const editStates = new Map<number, EditState>();

function getEditState(projectId: number): EditState {
  if (!editStates.has(projectId)) {
    editStates.set(projectId, { status: "idle", logs: [] });
  }
  return editStates.get(projectId)!;
}

function elog(s: EditState, msg: string, type: EditLog["type"] = "info") {
  s.logs.push({ ts: Date.now(), msg, type });
  console.log(`[Edit][${type.toUpperCase()}] ${msg}`);
}

// ── Preview pipeline: Claude edits → save to DB → preview ready ───────────

async function runEdit(
  project: ProjectRow,
  instruction: string,
  s: EditState
): Promise<void> {
  try {
    const files = JSON.parse(project.files_json!) as Record<string, string>;

    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    const client = new Anthropic({ apiKey });

    // Step 1 — identify which files need to change (tiny call, ~500 tokens out)
    elog(s, "▶ Goldy is reviewing your changes...", "info");
    const fileList = Object.keys(files).join(", ");
    const planRes = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 400,
      system: `You are Goldy, an expert web developer. Given a user's edit instruction and the list of project files, identify which files need to be modified to fulfill the instruction.
Return ONLY valid JSON — no markdown, no explanation:
{"files_to_edit": ["index.html"]}
Only list files that genuinely need changing. Max 8 files.`,
      messages: [{
        role: "user",
        content: `Project files: ${fileList}\n\nInstruction: ${instruction}`,
      }],
    });

    const planText = planRes.content[0].type === "text" ? planRes.content[0].text : "";
    const planMatch = planText.match(/\{[\s\S]*\}/);
    if (!planMatch) throw new Error("Goldy could not plan the edit — please try again");
    const plan = JSON.parse(planMatch[0]) as { files_to_edit?: string[] };
    const filesToEdit = (plan.files_to_edit ?? []).filter((f) => f in files);
    if (filesToEdit.length === 0) throw new Error("Goldy couldn't identify which files to change — please be more specific");

    elog(s, `✓ Goldy will edit: ${filesToEdit.join(", ")}`, "success");

    // Step 2 — edit each file individually (8000 tokens each, never truncated)
    const updatedFiles = { ...files };
    for (const fileName of filesToEdit) {
      elog(s, `  ▶ Editing ${fileName}...`, "info");

      const contextSnippets = Object.entries(updatedFiles)
        .filter(([n]) => n !== fileName)
        .map(([n, c]) => `=== ${n} ===\n${c.slice(0, 600)}`)
        .join("\n\n");

      const editRes = await client.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 8000,
        system: `You are Goldy, an expert web developer applying a targeted edit to one file of a deployed project.
Output ONLY the complete new content of the file — no markdown fences, no backticks, no explanation.
Write the COMPLETE file from top to bottom. Do NOT truncate or use placeholder comments like "rest of code unchanged".`,
        messages: [{
          role: "user",
          content: `Edit instruction: ${instruction}

Current content of ${fileName}:
${files[fileName]}

Other project files (context only — do not regenerate these):
${contextSnippets}`,
        }],
      });

      const editText = editRes.content[0].type === "text" ? editRes.content[0].text : "";
      updatedFiles[fileName] = editText.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim();
      elog(s, `  ✓ ${fileName} updated (${updatedFiles[fileName].length} chars)`, "success");
    }

    elog(s, `✓ Goldy updated ${filesToEdit.length} file${filesToEdit.length !== 1 ? "s" : ""}`, "success");

    console.log('Saving files to DB, count:', Object.keys(updatedFiles).length);
    try {
      await queryOne(
        "UPDATE projects SET files_json = $1 WHERE id = $2",
        [JSON.stringify(updatedFiles), project.id]
      );
      console.log('DB SAVE: project', project.id, 'files:', Object.keys(updatedFiles));
      console.log('DB SAVE: index.html length:', updatedFiles['index.html']?.length);
      elog(s, "✓ Changes saved to database", "success");
    } catch (dbErr) {
      console.error("Failed to save files_json to DB:", dbErr);
      elog(s, "⚠ Could not save to database — preview still available", "warn");
    }

    elog(s, "✓ Preview ready — check the panel on the right.", "success");
    elog(s, "⏳ Waiting for your approval before going live...", "info");

    s.pendingFiles = updatedFiles;
    s.pendingProject = project;
    s.status = "preview";
    s.result = {};
  } catch (err) {
    s.status = "error";
    s.error = (err as Error).message;
    elog(s, `Edit failed: ${(err as Error).message}`, "error");

    try {
      await queryOne(
        "INSERT INTO edit_history (project_id, role, message) VALUES ($1, 'goldy', $2)",
        [project.id, `Error: ${(err as Error).message}`]
      );
    } catch { /* non-fatal */ }
  }
}

// ── Confirm pipeline: GitHub push → production deploy → DB save ───────────

async function runConfirm(s: EditState): Promise<void> {
  const project = s.pendingProject!;
  const updatedFiles = s.pendingFiles!;

  try {
    let repoUrl = project.github_url ?? "";
    let deployUrl = project.vercel_url ?? "";

    // Push to GitHub
    if (process.env["GITHUB_TOKEN"] && project.github_url) {
      try {
        const repoName = project.github_url.replace(/\/$/, "").split("/").pop()!;
        elog(s, `▶ Petya is updating the warehouse: ${repoName}`, "info");
        await pushFilesToGitHub(repoName, updatedFiles);
        repoUrl = project.github_url;
        elog(s, "✓ Petya packed the warehouse", "success");
      } catch (e) {
        elog(s, `Petya had a snag (non-fatal): ${(e as Error).message}`, "warn");
      }
    }

    // Deploy to production Vercel project
    if (process.env["VERCEL_TOKEN"]) {
      try {
        elog(s, `▶ Vasya is deploying to production...`, "info");
        const vercelResult = await deployToVercel(project.name, updatedFiles);
        deployUrl = vercelResult.customUrl ?? vercelResult.url;
        elog(s, `✓ Vasya delivered — LIVE at ${deployUrl}`, "success");
      } catch (e) {
        elog(s, `Vasya couldn't deploy (non-fatal): ${(e as Error).message}`, "warn");
      }
    }

    // Save to DB
    await queryOne(
      "UPDATE projects SET files_json = $1, vercel_url = $2, github_url = $3 WHERE id = $4",
      [JSON.stringify(updatedFiles), deployUrl || null, repoUrl || null, project.id]
    );

    // Save Goldy message to history
    const doneMsg = deployUrl
      ? `Your changes are live at ${deployUrl}`
      : "Your changes have been deployed to production.";
    await queryOne(
      "INSERT INTO edit_history (project_id, role, message) VALUES ($1, 'goldy', $2)",
      [project.id, doneMsg]
    );

    elog(s, "✓ All done! Your site is live.", "success");

    s.status = "done";
    s.result = { productionUrl: deployUrl || undefined, repoUrl: repoUrl || undefined };

    // Clear pending
    s.pendingFiles = undefined;
    s.pendingProject = undefined;
  } catch (err) {
    s.status = "error";
    s.error = (err as Error).message;
    elog(s, `Deployment failed: ${(err as Error).message}`, "error");
  }
}

// ── Preview route — serve HTML from DB (no auth, used by iframe) ──────────

function findHtmlContent(files: Record<string, string>): string | null {
  const htmlKey = Object.keys(files).find(k => k === "index.html")
    || Object.keys(files).find(k => k.endsWith(".html"));
  return htmlKey ? files[htmlKey] : null;
}

function parseFilesJson(raw: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const files: Record<string, string> = {};
      for (const f of parsed) files[f.path || f.name] = f.content;
      return files;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Inline local CSS/JS into HTML so preview is self-contained.
// CDN URLs (containing "://") are left untouched.
function inlineAssets(html: string, files: Record<string, string>): string {
  const isLocal = (url: string) => !/^https?:\/\/|^\/\//.test(url);
  const resolve = (href: string) => href.replace(/^\.\//, "");

  // <link rel="stylesheet" href="local.css"> — rel before href
  html = html.replace(
    /<link\b([^>]*)\brel=["']stylesheet["']([^>]*)\bhref=["']([^"']+)["']([^>]*)>/gi,
    (match, b, c, href, d) => {
      if (!isLocal(href)) return match;
      const content = files[resolve(href)];
      if (content == null) return match;
      return `<style>/* inlined: ${resolve(href)} */\n${content}\n</style>`;
    }
  );

  // <link href="local.css" rel="stylesheet"> — href before rel
  html = html.replace(
    /<link\b([^>]*)\bhref=["']([^"']+)["']([^>]*)\brel=["']stylesheet["']([^>]*)>/gi,
    (match, b, href, c, d) => {
      if (!isLocal(href)) return match;
      const content = files[resolve(href)];
      if (content == null) return match;
      return `<style>/* inlined: ${resolve(href)} */\n${content}\n</style>`;
    }
  );

  // <script src="local.js"></script>
  html = html.replace(
    /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi,
    (match, before, src, after) => {
      if (!isLocal(src)) return match;
      const content = files[resolve(src)];
      if (content == null) return match;
      return `<script${before}${after}>/* inlined: ${resolve(src)} */\n${content}\n</script>`;
    }
  );

  return html;
}

const PLACEHOLDER_HTML = (msg: string) =>
  `<!DOCTYPE html><html><body style='font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;color:#888'><p>${msg}</p></body></html>`;

// Helper: load files from pending state or DB
async function resolveFiles(projectId: number, usePending: boolean): Promise<Record<string, string> | null> {
  if (usePending) {
    const s = editStates.get(projectId);
    if (s?.pendingFiles) return s.pendingFiles;
  }
  const project = await queryOne<{ files_json: string | null }>(
    "SELECT files_json FROM projects WHERE id = $1",
    [projectId]
  );
  if (!project?.files_json) return null;
  return parseFilesJson(project.files_json);
}

// GET /preview/:projectId — returns self-contained HTML with inlined CSS/JS
router.get("/preview/:projectId", async (req, res) => {
  const projectId = Number(req.params["projectId"]);
  if (!projectId) { res.status(400).send("Invalid project ID"); return; }

  res.setHeader("Content-Type", "text/html");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  try {
    const pending = req.query["pending"] === "1";

    // First try pending state; fall through to DB
    let files: Record<string, string> | null = null;
    if (pending) {
      const s = editStates.get(projectId);
      files = s?.pendingFiles ?? null;
    }
    if (!files) {
      const project = await queryOne<{ files_json: string | null }>(
        "SELECT files_json FROM projects WHERE id = $1",
        [projectId]
      );
      if (!project) { res.status(404).send("Project not found"); return; }
      if (!project.files_json) { res.send(PLACEHOLDER_HTML("No files yet — send an edit to get started.")); return; }
      files = parseFilesJson(project.files_json);
    }

    if (!files) { res.status(500).send("Failed to parse project files"); return; }

    console.log('PREVIEW REQUEST: projectId:', projectId, 'pending:', pending);
    console.log('PREVIEW: files keys:', Object.keys(files).slice(0, 5));
    console.log('PREVIEW: index.html length:', files['index.html']?.length);

    const rawHtml = findHtmlContent(files);
    if (!rawHtml) { res.send(PLACEHOLDER_HTML("No HTML file found in this project.")); return; }

    const html = inlineAssets(rawHtml, files);
    res.send(html);
  } catch (e) {
    console.error("Preview route error:", e);
    res.status(500).send("Server error");
  }
});

// GET /preview/:projectId/:filename — serve individual files (CSS, JS, etc.) from files_json
router.get("/preview/:projectId/:filename", async (req, res) => {
  const projectId = Number(req.params["projectId"]);
  const filename = req.params["filename"];
  if (!projectId || !filename) { res.status(400).send("Invalid params"); return; }

  const CONTENT_TYPES: Record<string, string> = {
    css: "text/css",
    js: "application/javascript",
    mjs: "application/javascript",
    json: "application/json",
    svg: "image/svg+xml",
    txt: "text/plain",
    html: "text/html",
  };

  try {
    const pending = req.query["pending"] === "1";
    const files = await resolveFiles(projectId, pending);
    if (!files) { res.status(404).send("Project not found"); return; }

    const content = files[filename];
    if (content == null) { res.status(404).send(`File not found: ${filename}`); return; }

    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "text/plain");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(content);
  } catch (e) {
    console.error("Preview file route error:", e);
    res.status(500).send("Server error");
  }
});

// ── Deploy route — manual GitHub push + Vercel deploy ─────────────────────

router.post("/deploy/:projectId", requireAuth, async (req, res) => {
  const projectId = Number(req.params["projectId"]);
  if (!projectId) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  try {
    const project = await queryOne<ProjectRow>(
      "SELECT id, user_id, name, vercel_url, github_url, files_json FROM projects WHERE id = $1",
      [projectId]
    );

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (project.user_id !== req.user!.id && req.user!.role !== "admin") {
      res.status(403).json({ error: "You don't own this project" });
      return;
    }
    if (!project.files_json) {
      res.status(400).json({ error: "No files to deploy" });
      return;
    }

    let files: Record<string, string>;
    try {
      const parsed = JSON.parse(project.files_json);
      if (Array.isArray(parsed)) {
        files = {};
        for (const f of parsed) files[f.path || f.name] = f.content;
      } else {
        files = parsed;
      }
    } catch {
      res.status(500).json({ error: "Failed to parse project files" });
      return;
    }

    let repoUrl = project.github_url ?? "";
    let deployUrl = project.vercel_url ?? "";

    if (process.env["GITHUB_TOKEN"]) {
      try {
        if (project.github_url) {
          const repoName = project.github_url.replace(/\/$/, "").split("/").pop()!;
          await pushFilesToGitHub(repoName, files);
          repoUrl = project.github_url;
        }
      } catch (e) {
        console.warn("Deploy route: GitHub push failed:", (e as Error).message);
      }
    }

    if (process.env["VERCEL_TOKEN"]) {
      try {
        const vercelResult = await deployToVercel(project.name, files);
        deployUrl = vercelResult.customUrl ?? vercelResult.url;
      } catch (e) {
        console.warn("Deploy route: Vercel deploy failed:", (e as Error).message);
      }
    }

    if (deployUrl !== (project.vercel_url ?? "") || repoUrl !== (project.github_url ?? "")) {
      await queryOne(
        "UPDATE projects SET vercel_url = $1, github_url = $2 WHERE id = $3",
        [deployUrl || null, repoUrl || null, projectId]
      );
    }

    res.json({ ok: true, vercelUrl: deployUrl || null, repoUrl: repoUrl || null });
  } catch (e) {
    console.error("Deploy route error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────

// POST /edit — start edit pipeline (Claude + preview deploy)
router.post("/edit", requireAuth, async (req, res) => {
  const { projectId, instruction } = req.body as {
    projectId?: number;
    instruction?: string;
  };

  if (!projectId || !instruction?.trim()) {
    res.status(400).json({ error: "projectId and instruction are required" });
    return;
  }

  try {
    const project = await queryOne<ProjectRow>(
      "SELECT id, user_id, name, vercel_url, github_url, files_json FROM projects WHERE id = $1",
      [projectId]
    );

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (project.user_id !== req.user!.id && req.user!.role !== "admin") {
      res.status(403).json({ error: "You don't own this project" });
      return;
    }
    if (!project.files_json) {
      res.status(400).json({ error: "This project has no editable files stored" });
      return;
    }

    const s = getEditState(projectId);
    if (s.status === "editing" || s.status === "confirming") {
      res.status(409).json({ error: "This project is already being edited — please wait" });
      return;
    }

    // Reset state
    s.status = "editing";
    s.logs = [];
    s.error = undefined;
    s.result = undefined;
    s.pendingFiles = undefined;
    s.pendingProject = undefined;

    // Save user message to history immediately
    await queryOne(
      "INSERT INTO edit_history (project_id, role, message) VALUES ($1, 'user', $2)",
      [projectId, instruction.trim()]
    );

    res.json({ ok: true, message: "Edit started" });

    // Fire and forget — client polls /edit/status
    void runEdit(project, instruction.trim(), s);
  } catch (e) {
    console.error("Edit route error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /edit/confirm — approve preview → push to GitHub + deploy to production + save DB
router.post("/edit/confirm", requireAuth, async (req, res) => {
  const { projectId } = req.body as { projectId?: number };

  if (!projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }

  try {
    const project = await queryOne<{ id: number; user_id: number }>(
      "SELECT id, user_id FROM projects WHERE id = $1",
      [projectId]
    );
    if (!project || (project.user_id !== req.user!.id && req.user!.role !== "admin")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const s = getEditState(projectId);
    if (s.status !== "preview" || !s.pendingFiles) {
      res.status(409).json({ error: "No pending preview to confirm" });
      return;
    }

    // Switch to confirming
    s.status = "confirming";
    s.logs = [];
    s.error = undefined;

    res.json({ ok: true, message: "Deploying to production..." });

    void runConfirm(s);
  } catch (e) {
    console.error("Confirm route error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /edit/discard — discard pending preview, reset to idle
router.post("/edit/discard", requireAuth, async (req, res) => {
  const { projectId } = req.body as { projectId?: number };

  if (!projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }

  try {
    const project = await queryOne<{ id: number; user_id: number }>(
      "SELECT id, user_id FROM projects WHERE id = $1",
      [projectId]
    );
    if (!project || (project.user_id !== req.user!.id && req.user!.role !== "admin")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const s = getEditState(projectId);
    s.status = "idle";
    s.logs = [];
    s.error = undefined;
    s.result = undefined;
    s.pendingFiles = undefined;
    s.pendingProject = undefined;

    res.json({ ok: true });
  } catch (e) {
    console.error("Discard route error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /edit/status?projectId=N
router.get("/edit/status", requireAuth, async (req, res) => {
  const projectId = Number(req.query["projectId"]);
  if (!projectId) {
    res.status(400).json({ error: "projectId query param required" });
    return;
  }

  try {
    const project = await queryOne<{ id: number; user_id: number }>(
      "SELECT id, user_id FROM projects WHERE id = $1",
      [projectId]
    );
    if (!project || (project.user_id !== req.user!.id && req.user!.role !== "admin")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const s = getEditState(projectId);
    res.json({ status: s.status, logs: s.logs, error: s.error, result: s.result });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET /edit/history?projectId=N
router.get("/edit/history", requireAuth, async (req, res) => {
  const projectId = Number(req.query["projectId"]);
  if (!projectId) {
    res.status(400).json({ error: "projectId query param required" });
    return;
  }

  try {
    const project = await queryOne<{ id: number; user_id: number }>(
      "SELECT id, user_id FROM projects WHERE id = $1",
      [projectId]
    );
    if (!project || (project.user_id !== req.user!.id && req.user!.role !== "admin")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const history = await query<HistoryRow>(
      "SELECT id, role, message, created_at FROM edit_history WHERE project_id = $1 ORDER BY created_at ASC",
      [projectId]
    );
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
