import { Router } from "express";
import { requireAdmin, requireAuth } from "../middlewares/auth.js";
import { query, queryOne } from "../lib/db.js";

const router = Router();

router.post("/feedback", requireAuth, async (req, res) => {
  const { projectId, rating, comment } = req.body as {
    projectId?: number;
    rating?: string;
    comment?: string;
  };
  if (!projectId || !Number.isInteger(projectId) || projectId <= 0 || !rating || !["good", "bad"].includes(rating)) {
    res.status(400).json({ error: "projectId and rating (good|bad) required" });
    return;
  }
  try {
    const project = await queryOne<{ user_id: number }>(
      "SELECT user_id FROM projects WHERE id = $1", [projectId]
    );
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    if (project.user_id !== req.user!.id && req.user!.role !== "admin") {
      res.status(403).json({ error: "Not your project" });
      return;
    }
    const existing = await queryOne(
      "SELECT id FROM build_feedback WHERE project_id = $1 AND user_id = $2",
      [projectId, req.user!.id]
    );
    if (existing) {
      await queryOne(
        "UPDATE build_feedback SET rating = $1, comment = $2, created_at = now() WHERE project_id = $3 AND user_id = $4",
        [rating, comment || null, projectId, req.user!.id]
      );
    } else {
      await queryOne(
        "INSERT INTO build_feedback (project_id, user_id, rating, comment) VALUES ($1, $2, $3, $4)",
        [projectId, req.user!.id, rating, comment || null]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to save feedback" });
  }
});

router.get("/admin/feedback", requireAdmin, async (_req, res) => {
  try {
    const rows = await query(
      `SELECT bf.id, bf.rating, bf.comment, bf.created_at,
              p.name AS project_name,
              COALESCE(fu.email, pu.email) AS user_email
       FROM build_feedback bf
       JOIN projects p ON bf.project_id = p.id
       JOIN users pu ON p.user_id = pu.id
       LEFT JOIN users fu ON bf.user_id = fu.id
       ORDER BY bf.created_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load feedback" });
  }
});

router.get("/admin/prompt-history", requireAdmin, async (_req, res) => {
  try {
    const rows = await query(
      "SELECT id, member, suggested_prompt, rationale, approved, created_at FROM prompt_history ORDER BY created_at DESC LIMIT 50"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load prompt history" });
  }
});

router.post("/admin/prompt-history/:id/approve", requireAdmin, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }
  try {
    const row = await queryOne<{ member: string; suggested_prompt: string }>(
      "SELECT member, suggested_prompt FROM prompt_history WHERE id = $1",
      [id]
    );
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    await query(
      `CREATE TABLE IF NOT EXISTS system_prompts (
        member TEXT PRIMARY KEY,
        prompt TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`
    );
    await queryOne(
      `INSERT INTO system_prompts (member, prompt, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (member) DO UPDATE SET prompt = $2, updated_at = now()`,
      [row.member, row.suggested_prompt]
    );
    await queryOne("UPDATE prompt_history SET approved = TRUE WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to approve suggestion" });
  }
});

router.get("/admin/stats", requireAdmin, async (_req, res) => {
  try {
    const userCount = await queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
    const projCount = await queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM projects");
    const deployedCount = await queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM projects WHERE vercel_url IS NOT NULL");
    const monthCount = await queryOne<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM projects WHERE created_at >= NOW() - INTERVAL '30 days'"
    );
    const total = Number(projCount?.count ?? 0);
    const deployed = Number(deployedCount?.count ?? 0);
    const monthly = Number(monthCount?.count ?? 0);
    const costPerBuild = 0.12;
    res.json({
      users: Number(userCount?.count ?? 0),
      projects: total,
      deployed,
      successRate: total ? Math.round((deployed / total) * 100) : 0,
      monthlyBuilds: monthly,
      estimatedCost: (total * costPerBuild).toFixed(0),
      estimatedMonthlyCost: (monthly * costPerBuild).toFixed(2),
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to load stats" });
  }
});

router.get("/admin/builds-chart", requireAdmin, async (_req, res) => {
  try {
    const rows = await query<{ day: string; count: string }>(
      `SELECT created_at::date AS day, COUNT(*)::text AS count
       FROM projects
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY day ORDER BY day ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load chart data" });
  }
});

router.get("/admin/analytics", requireAdmin, async (_req, res) => {
  try {
    const today = await queryOne<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM projects WHERE created_at::date = CURRENT_DATE"
    );
    const week = await queryOne<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM projects WHERE created_at >= NOW() - INTERVAL '7 days'"
    );
    const month = await queryOne<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM projects WHERE created_at >= NOW() - INTERVAL '30 days'"
    );
    const topUsers = await query<{ email: string; count: string }>(
      `SELECT u.email, COUNT(p.id)::text AS count
       FROM users u JOIN projects p ON u.id = p.user_id
       GROUP BY u.email ORDER BY COUNT(p.id) DESC LIMIT 5`
    );
    res.json({
      today: Number(today?.count ?? 0),
      week: Number(week?.count ?? 0),
      month: Number(month?.count ?? 0),
      topUsers,
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to load analytics" });
  }
});

router.get("/admin/prompts", requireAdmin, async (_req, res) => {
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS system_prompts (
        member TEXT PRIMARY KEY,
        prompt TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`
    );
    const rows = await query("SELECT member, prompt, updated_at FROM system_prompts ORDER BY member");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load prompts" });
  }
});

router.post("/admin/prompts", requireAdmin, async (req, res) => {
  const { member, prompt } = req.body as { member?: string; prompt?: string };
  if (!member || typeof prompt !== "string") {
    res.status(400).json({ error: "member and prompt are required" });
    return;
  }
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS system_prompts (
        member TEXT PRIMARY KEY,
        prompt TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`
    );
    await queryOne(
      `INSERT INTO system_prompts (member, prompt, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (member) DO UPDATE SET prompt = $2, updated_at = now()`,
      [member, prompt]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to save prompt" });
  }
});

router.post("/admin/users/:id/block", requireAdmin, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid user ID" }); return; }
  if (id === req.user!.id) { res.status(400).json({ error: "Cannot block yourself" }); return; }
  try {
    const target = await queryOne<{ role: string }>("SELECT role FROM users WHERE id = $1", [id]);
    if (!target) { res.status(404).json({ error: "User not found" }); return; }
    if (target.role === "admin") {
      const adminCount = await queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM users WHERE role = 'admin'");
      if (Number(adminCount?.count ?? 0) <= 1) { res.status(400).json({ error: "Cannot block the last admin" }); return; }
    }
    await queryOne("UPDATE users SET role = 'blocked' WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to block user" });
  }
});

router.delete("/admin/users/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid user ID" }); return; }
  if (id === req.user!.id) { res.status(400).json({ error: "Cannot delete yourself" }); return; }
  try {
    const target = await queryOne<{ role: string }>("SELECT role FROM users WHERE id = $1", [id]);
    if (!target) { res.status(404).json({ error: "User not found" }); return; }
    if (target.role === "admin") {
      const adminCount = await queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM users WHERE role = 'admin'");
      if (Number(adminCount?.count ?? 0) <= 1) { res.status(400).json({ error: "Cannot delete the last admin" }); return; }
    }
    await queryOne("DELETE FROM projects WHERE user_id = $1", [id]);
    await queryOne("DELETE FROM users WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

router.post("/admin/users/:id/make-admin", requireAdmin, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid user ID" }); return; }
  try {
    const target = await queryOne<{ id: number }>("SELECT id FROM users WHERE id = $1", [id]);
    if (!target) { res.status(404).json({ error: "User not found" }); return; }
    await queryOne("UPDATE users SET role = 'admin' WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to promote user" });
  }
});

router.delete("/admin/projects/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid project ID" }); return; }
  try {
    await queryOne("DELETE FROM edit_history WHERE project_id = $1", [id]);
    await queryOne("DELETE FROM projects WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete project" });
  }
});

router.get("/admin/billing", requireAdmin, async (_req, res) => {
  try {
    const total = await queryOne<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM projects"
    );
    const done = await queryOne<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM projects WHERE vercel_url IS NOT NULL"
    );
    const monthCount = await queryOne<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM projects WHERE created_at >= NOW() - INTERVAL '30 days'"
    );
    const builds = Number(monthCount?.count ?? 0);
    const costPerBuild = 0.12;
    res.json({
      totalBuilds: Number(total?.count ?? 0),
      deployedBuilds: Number(done?.count ?? 0),
      monthlyBuilds: builds,
      estimatedMonthlyCost: (builds * costPerBuild).toFixed(2),
      breakdown: {
        claude: (builds * 0.08).toFixed(2),
        openai: (builds * 0.02).toFixed(2),
        replicate: (builds * 0.015).toFixed(2),
        recraft: (builds * 0.005).toFixed(2),
      },
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to load billing" });
  }
});

router.get("/admin/settings", requireAdmin, async (_req, res) => {
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`
    );
    const rows = await query<{ key: string; value: string }>(
      "SELECT key, value FROM admin_settings"
    );
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;
    settings["CUSTOM_DOMAIN"] = settings["CUSTOM_DOMAIN"] ?? process.env["CUSTOM_DOMAIN"] ?? "";
    settings["BUILD_TIMEOUT"] = settings["BUILD_TIMEOUT"] ?? "20";
    settings["MAX_FILES"] = settings["MAX_FILES"] ?? "30";
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: "Failed to load settings" });
  }
});

router.post("/admin/settings", requireAdmin, async (req, res) => {
  const body = req.body as Record<string, string>;
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`
    );
    for (const [key, value] of Object.entries(body)) {
      await queryOne(
        `INSERT INTO admin_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [key, value]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to save settings" });
  }
});

export default router;
