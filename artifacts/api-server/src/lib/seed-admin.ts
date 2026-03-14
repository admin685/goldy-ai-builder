import bcrypt from "bcryptjs";
import { queryOne } from "./db.js";

interface UserRow { id: number; email: string; role: string }

export async function seedAdmin(): Promise<void> {
  const email = process.env["ADMIN_EMAIL"];
  const password = process.env["ADMIN_PASSWORD"];
  if (!email || !password) {
    console.log("[seed] ADMIN_EMAIL or ADMIN_PASSWORD not set — skipping admin seed");
    return;
  }
  try {
    const existing = await queryOne<UserRow>("SELECT id, role FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing) {
      if (existing.role !== "admin") {
        await queryOne("UPDATE users SET role = 'admin' WHERE id = $1", [existing.id]);
        console.log(`[seed] Promoted ${email} to admin`);
      } else {
        console.log(`[seed] Admin ${email} already exists`);
      }
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    await queryOne(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')",
      [email.toLowerCase(), hash]
    );
    console.log(`[seed] Admin user created: ${email}`);
  } catch (e) {
    console.error("[seed] Admin seed failed:", e);
  }
}
