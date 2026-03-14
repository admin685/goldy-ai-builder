import Anthropic from "@anthropic-ai/sdk";
import { query, queryOne } from "./db.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function shouldRun(): Promise<boolean> {
  try {
    const row = await queryOne<{ value: string }>(
      "SELECT value FROM admin_settings WHERE key = 'last_weekly_run'"
    );
    if (!row) return true;
    const lastRun = new Date(row.value).getTime();
    return Date.now() - lastRun >= WEEK_MS;
  } catch {
    return true;
  }
}

async function markRun(): Promise<void> {
  await queryOne(
    `INSERT INTO admin_settings (key, value, updated_at)
     VALUES ('last_weekly_run', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [new Date().toISOString()]
  );
}

async function runPromptImprovement(): Promise<void> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    console.log("[Goldy] [WeeklyJob] No ANTHROPIC_API_KEY, skipping prompt improvement");
    return;
  }

  const feedback = await query<{
    rating: string;
    comment: string | null;
    project_name: string;
  }>(
    `SELECT bf.rating, bf.comment, p.name AS project_name
     FROM build_feedback bf
     JOIN projects p ON bf.project_id = p.id
     WHERE bf.created_at >= NOW() - INTERVAL '7 days'
     ORDER BY bf.created_at DESC
     LIMIT 50`
  );

  if (feedback.length === 0) {
    console.log("[Goldy] [WeeklyJob] No feedback in last 7 days, skipping");
    await markRun();
    return;
  }

  const goodCount = feedback.filter(f => f.rating === "good").length;
  const badCount = feedback.filter(f => f.rating === "bad").length;

  const feedbackSummary = feedback.map(f =>
    `- ${f.project_name}: ${f.rating}${f.comment ? ` — "${f.comment}"` : ""}`
  ).join("\n");

  const members = ["Goldy", "Boris", "Masha", "Ivan"];
  const currentPrompts = await query<{ member: string; prompt: string }>(
    "SELECT member, prompt FROM system_prompts ORDER BY member"
  );
  const promptMap: Record<string, string> = {};
  currentPrompts.forEach(p => { promptMap[p.member] = p.prompt; });

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: `You are an AI system optimizer. You review user feedback on AI-generated websites and suggest improvements to the system prompts used by each crew member.

Crew members:
- Goldy (Claude): analyzes project ideas, generates HTML/JS code files
- Boris (GPT-4o): generates CSS design systems
- Masha (Recraft): generates SVG logos
- Ivan (FLUX): generates hero background images

Return ONLY a JSON array of objects, one per crew member that needs improvement:
[{"member": "Name", "suggested_prompt": "improved prompt text", "rationale": "why this change helps"}]

If a member's prompt is fine, omit them. If no improvements needed, return [].
No markdown fences, just JSON.`,
    messages: [{
      role: "user",
      content: `Last 7 days feedback (${goodCount} good, ${badCount} bad):\n${feedbackSummary}\n\nCurrent prompts:\n${members.map(m => `${m}: ${promptMap[m] || "(default/hardcoded)"}`).join("\n\n")}\n\nSuggest prompt improvements based on the feedback patterns.`
    }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "[]";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    console.log("[Goldy] [WeeklyJob] No valid JSON in response");
    await markRun();
    return;
  }

  let suggestions: Array<{ member: string; suggested_prompt: string; rationale: string }>;
  try {
    suggestions = JSON.parse(match[0]);
    if (!Array.isArray(suggestions)) {
      console.log("[Goldy] [WeeklyJob] Parsed value is not an array");
      await markRun();
      return;
    }
  } catch (parseErr) {
    console.error("[Goldy] [WeeklyJob] JSON parse error:", parseErr);
    await markRun();
    return;
  }

  let saved = 0;
  for (const s of suggestions) {
    if (members.includes(s.member) && s.suggested_prompt) {
      await queryOne(
        `INSERT INTO prompt_history (member, suggested_prompt, rationale)
         VALUES ($1, $2, $3)`,
        [s.member, s.suggested_prompt, s.rationale || ""]
      );
      saved++;
    }
  }

  console.log(`[Goldy] [WeeklyJob] Saved ${saved} prompt suggestions`);
  await markRun();
}

export async function startWeeklyJob(): Promise<void> {
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS build_feedback (
        id SERIAL PRIMARY KEY,
        project_id INT REFERENCES projects(id) ON DELETE CASCADE,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        rating VARCHAR(4) CHECK (rating IN ('good', 'bad')),
        comment TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )`
    );
    await query(
      `CREATE TABLE IF NOT EXISTS prompt_history (
        id SERIAL PRIMARY KEY,
        member TEXT NOT NULL,
        suggested_prompt TEXT NOT NULL,
        rationale TEXT,
        approved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT now()
      )`
    );
    await query(
      `CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`
    );
    await query(
      `CREATE TABLE IF NOT EXISTS system_prompts (
        member TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`
    );
  } catch (e) {
    console.error("[Goldy] [WeeklyJob] Table creation error:", e);
  }

  const run = async () => {
    try {
      if (await shouldRun()) {
        console.log("[Goldy] [WeeklyJob] Running weekly prompt improvement...");
        await runPromptImprovement();
      } else {
        console.log("[Goldy] [WeeklyJob] Skipping — last run < 7 days ago");
      }
    } catch (e) {
      console.error("[Goldy] [WeeklyJob] Error:", e);
    }
  };

  setTimeout(run, 10_000);
  setInterval(run, WEEK_MS);
}
