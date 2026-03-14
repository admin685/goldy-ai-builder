import { Router } from "express";
import bcrypt from "bcryptjs";
import { query, queryOne } from "../lib/db.js";
import { signToken, requireAuth } from "../middlewares/auth.js";

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  role: "admin" | "user";
  created_at: string;
}

const router = Router();

// POST /auth/register
router.post("/auth/register", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  try {
    const existing = await queryOne<UserRow>("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    const user = await queryOne<UserRow>(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user') RETURNING id, email, role",
      [email.toLowerCase(), hash]
    );
    if (!user) throw new Error("Failed to create user");
    const token = signToken({ id: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (e) {
    console.error("Register error:", e);
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /auth/login
router.post("/auth/login", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  try {
    const user = await queryOne<UserRow>(
      "SELECT id, email, password_hash, role FROM users WHERE email = $1",
      [email.toLowerCase()]
    );
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const token = signToken({ id: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (e) {
    console.error("Login error:", e);
    res.status(500).json({ error: "Login failed" });
  }
});

// GET /auth/me
router.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await queryOne<UserRow>(
      "SELECT id, email, role, created_at FROM users WHERE id = $1",
      [req.user!.id]
    );
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    res.json({ id: user.id, email: user.email, role: user.role, created_at: user.created_at });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// GET /auth/projects — user's own projects
router.get("/auth/projects", requireAuth, async (req, res) => {
  try {
    const projects = await query(
      "SELECT id, name, vercel_url, github_url, created_at FROM projects WHERE user_id = $1 ORDER BY created_at DESC",
      [req.user!.id]
    );
    res.json(projects);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

// GET /auth/admin/users — all users (admin only)
router.get("/auth/admin/users", requireAuth, async (req, res) => {
  if (req.user!.role !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }
  try {
    const users = await query("SELECT id, email, role, created_at FROM users ORDER BY created_at DESC");
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// GET /auth/admin/projects — all projects (admin only)
router.get("/auth/admin/projects", requireAuth, async (req, res) => {
  if (req.user!.role !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }
  try {
    const projects = await query(
      `SELECT p.id, p.name, p.vercel_url, p.github_url, p.created_at, u.email as user_email
       FROM projects p JOIN users u ON p.user_id = u.id
       ORDER BY p.created_at DESC`
    );
    res.json(projects);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

export default router;
