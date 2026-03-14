import { queryOne } from "./db.js";

export async function saveProject(opts: {
  userId: number;
  name: string;
  vercelUrl?: string;
  githubUrl?: string;
  files?: Record<string, string>;
}): Promise<void> {
  try {
    await queryOne(
      `INSERT INTO projects (user_id, name, vercel_url, github_url, files_json)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        opts.userId,
        opts.name,
        opts.vercelUrl ?? null,
        opts.githubUrl ?? null,
        opts.files ? JSON.stringify(opts.files) : null,
      ]
    );
  } catch (e) {
    console.error("[projects] Failed to save project:", e);
  }
}
