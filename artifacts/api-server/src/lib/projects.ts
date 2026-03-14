import { queryOne } from "./db.js";

export async function saveProject(opts: {
  userId: number;
  name: string;
  vercelUrl?: string;
  githubUrl?: string;
  files?: Record<string, string>;
}): Promise<number | null> {
  try {
    const row = await queryOne<{ id: number }>(
      `INSERT INTO projects (user_id, name, vercel_url, github_url, files_json)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        opts.userId,
        opts.name,
        opts.vercelUrl ?? null,
        opts.githubUrl ?? null,
        opts.files ? JSON.stringify(opts.files) : null,
      ]
    );
    return row?.id ?? null;
  } catch (e) {
    console.error("[projects] Failed to save project:", e);
    return null;
  }
}
