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

// ── Preview pipeline: Claude edits → temp Vercel deploy (no DB write) ─────

async function runEdit(
  project: ProjectRow,
  instruction: string,
  s: EditState
): Promise<void> {
  try {
    const files = JSON.parse(project.files_json!) as Record<string, string>;

    elog(s, "▶ Goldy is reading the current project...", "info");

    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

    const client = new Anthropic({ apiKey });

    const systemPrompt = `You are Goldy, an expert web developer editing an existing deployed project.
Apply the user's requested changes and return ALL project files (including unchanged ones).

RULES (follow exactly):
- Output ONLY valid JSON — no markdown fences, no backticks, no explanation.
- Return every file, even if unchanged — the full set replaces what's in the database.
- Keep all CSS and JS inline inside index.html — no external files or CDN links.
- Only change what the user asked for; preserve all other styling and functionality.

Return ONLY this JSON structure (start with { end with }, nothing else):
{"files":{"index.html":"...complete updated file...","README.md":"..."}}`;

    const userContent = `Current project files:\n${JSON.stringify(files, null, 2)}\n\nInstruction: ${instruction}`;

    elog(s, "▶ Goldy is thinking about your changes...", "info");

    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 12000,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    const rawText = response.content[0].type === "text" ? response.content[0].text : "";
    const clean = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Goldy did not return valid JSON — please try again");

    const parsed = JSON.parse(match[0]) as { files?: Record<string, string> };
    const updatedFiles = parsed.files;
    if (!updatedFiles || Object.keys(updatedFiles).length === 0) {
      throw new Error("Goldy returned empty files — please try a different instruction");
    }

    elog(s, `✓ Goldy updated ${Object.keys(updatedFiles).length} files`, "success");

    // Deploy to a TEMPORARY -preview Vercel project (no GitHub push, no DB write)
    let previewUrl = "";
    if (process.env["VERCEL_TOKEN"]) {
      try {
        const previewProjectName = `${project.name}-preview`;
        elog(s, `▶ Vasya is spinning up a preview at ${previewProjectName}...`, "info");
        const vercelResult = await deployToVercel(previewProjectName, updatedFiles);
        previewUrl = vercelResult.customUrl ?? vercelResult.url;
        elog(s, `✓ Preview ready at ${previewUrl}`, "success");
      } catch (e) {
        elog(s, `Vasya couldn't deploy preview: ${(e as Error).message}`, "warn");
      }
    }

    elog(s, "⏳ Waiting for your approval before going live...", "info");

    // Store pending changes — do NOT write to DB or GitHub yet
    s.pendingFiles = updatedFiles;
    s.pendingProject = project;
    s.status = "preview";
    s.result = { previewUrl: previewUrl || undefined };
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
