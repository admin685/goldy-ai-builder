import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { requireAuth, requireAdmin } from "../middlewares/auth.js";
import { saveProject } from "../lib/projects.js";
import { queryOne } from "../lib/db.js";

const router: IRouter = Router();

async function getPrompt(member: string, fallback: string): Promise<string> {
  try {
    const row = await queryOne<{ prompt: string }>(
      "SELECT prompt FROM system_prompts WHERE member = $1",
      [member]
    );
    return (row?.prompt && row.prompt.trim()) ? row.prompt : fallback;
  } catch {
    return fallback;
  }
}

// ── Multi-AI Design Pipeline ───────────────────────────────────────────────

interface DesignAssets {
  css: string;
  heroImageUrl: string;
  logoSvg: string;
}

async function generateCSSWithGPT(idea: string, projectName: string): Promise<string> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    log("Boris is off duty — no API key to design the CSS", "warn");
    return "";
  }

  log("▶ Boris is designing the interior...", "info");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 3000,
      messages: [
        {
          role: "system",
          content: await getPrompt("Boris", `You are a world-class CSS designer. Generate premium, production-ready CSS for a web project. 
Output ONLY raw CSS — no markdown, no explanation, no backticks. 
Use CSS custom properties (variables). Create a cohesive design system with:
- A distinctive color palette (dark theme, rich accent colors matching the project's purpose)
- Custom Google Font pairings using @import
- Smooth transitions and hover effects
- Clean card/container styles
- A .hero section with a large background image via var(--hero-bg)
- A .navbar with logo area
- Responsive layout utilities
- Subtle animations with @keyframes`),
        },
        {
          role: "user",
          content: `Project: "${projectName}"\nDescription: ${idea}\n\nGenerate premium CSS for this project.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    log(`Boris hit a wall: ${err.slice(0, 200)}`, "warn");
    return "";
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const css = data.choices[0]?.message?.content?.trim() ?? "";
  log("✓ Boris finished the interior design", "success");
  return css;
}

async function generateHeroImageWithFLUX(idea: string): Promise<string> {
  const token = process.env["REPLICATE_API_TOKEN"];
  if (!token) {
    log("Ivan is off duty — no API key for site photos", "warn");
    return "";
  }

  log("▶ Ivan is taking photos of the site...", "info");

  const prompt = `Professional hero image for a web app: ${idea}. Cinematic lighting, modern UI aesthetic, dark atmospheric background, photorealistic, 4k quality, no text, no UI elements.`;

  const createRes = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait=30",
    },
    body: JSON.stringify({
      input: {
        prompt,
        num_outputs: 1,
        aspect_ratio: "16:9",
        output_format: "webp",
        output_quality: 80,
      },
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    log(`Ivan dropped his camera: ${err.slice(0, 200)}`, "warn");
    return "";
  }

  const prediction = (await createRes.json()) as {
    id: string;
    status: string;
    output?: string[];
    urls?: { get: string };
  };

  // If not completed yet, poll for result
  if (prediction.status !== "succeeded" && prediction.urls?.get) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollRes = await fetch(prediction.urls.get, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const polled = (await pollRes.json()) as {
        status: string;
        output?: string[];
      };
      if (polled.status === "succeeded" && polled.output?.[0]) {
        log("✓ Ivan got the perfect shot", "success");
        return polled.output[0];
      }
      if (polled.status === "failed") {
        log("Ivan's camera failed — moving on", "warn");
        return "";
      }
    }
    log("Ivan's shoot ran too long — moving on", "warn");
    return "";
  }

  const imageUrl = prediction.output?.[0] ?? "";
  if (imageUrl) log("✓ Ivan got the perfect shot", "success");
  return imageUrl;
}

async function generateLogoWithRecraft(projectName: string, idea: string): Promise<string> {
  const apiKey = process.env["RECRAFT_API_KEY"];
  if (!apiKey) {
    log("Masha is off duty — no API key for the artwork", "warn");
    return "";
  }

  log("▶ Masha is painting the logo...", "info");

  const prompt = `minimalist flat vector logo icon for ${projectName}, single geometric shape, bold, professional, no text, clean`;

  const res = await fetch("https://external.api.recraft.ai/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      style: "vector_illustration",
      response_format: "url",
      n: 1,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    log(`Masha spilled the paint: ${err.slice(0, 200)}`, "warn");
    return "";
  }

  const data = (await res.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };

  const imageUrl = data.data?.[0]?.url ?? "";
  if (imageUrl) {
    log("✓ Masha finished the logo", "success");
    return imageUrl;
  }

  log("Masha's canvas came back blank", "warn");
  return "";
}

export async function runDesignPipeline(idea: string, projectName: string): Promise<DesignAssets> {
  log("▶ Boris, Ivan, and Masha are starting their work...", "info");

  const [css, heroImageUrl, logoSvg] = await Promise.all([
    generateCSSWithGPT(idea, projectName).catch((e) => {
      log(`Boris had an issue: ${(e as Error).message}`, "warn");
      return "";
    }),
    generateHeroImageWithFLUX(idea).catch((e) => {
      log(`Ivan had an issue: ${(e as Error).message}`, "warn");
      return "";
    }),
    generateLogoWithRecraft(projectName, idea).catch((e) => {
      log(`Masha had an issue: ${(e as Error).message}`, "warn");
      return "";
    }),
  ]);

  log("✓ Crew handed everything to Goldy for assembly", "success");
  return { css, heroImageUrl, logoSvg };
}

// ── Task plan types ────────────────────────────────────────────────────────

export interface TaskSpec {
  id: number;
  agent: string;
  task: string;
}

export interface StageData {
  projectName: string;
  description: string;
  fileList: string[];
  css: string;
  cssClassSummary: string;
  heroImageUrl: string;
  logoUrl: string;
  files: Record<string, string>;
  features: string[];
  repoUrl: string;
  deployUrl: string;
  vercelProjectId: string;
  deploymentName: string;
}

export interface BuildLog {
  ts: number;
  msg: string;
  type: "info" | "success" | "error" | "warn";
}

export interface BuildState {
  status: "idle" | "building" | "done" | "error";
  stage: string;
  stageData: Partial<StageData>;
  logs: BuildLog[];
  result: {
    url?: string;
    repoUrl?: string;
    projectName?: string;
    filesCreated?: number;
    projectId?: number;
    vercelProjectId?: string;
    deploymentName?: string;
  };
  error?: string;
  idea?: string;
  userId?: number;
  startedAt?: number;
}

export const state: BuildState = {
  status: "idle",
  stage: "",
  stageData: {},
  logs: [],
  result: {},
};

export function log(msg: string, type: BuildLog["type"] = "info") {
  state.logs.push({ ts: Date.now(), msg, type });
  console.log(`[Goldy] [${type.toUpperCase()}] ${msg}`);
}

export function resetState(idea: string, userId?: number) {
  state.status = "building";
  state.stage = "";
  state.stageData = {};
  state.logs = [];
  state.result = {};
  state.error = undefined;
  state.idea = idea;
  state.userId = userId;
  state.startedAt = Date.now();
  log("▶ Goldy is reviewing the blueprints...", "info");
}

const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

export function clearIfTimedOut(): boolean {
  if (state.status !== "building") return false;
  if (!state.startedAt || Date.now() - state.startedAt <= BUILD_TIMEOUT_MS) return false;
  console.log("[Goldy] [WARN] Build auto-reset: timed out after 20 minutes");
  state.status = "idle";
  state.stage = "";
  state.error = "Previous build timed out after 20 minutes — auto-reset";
  state.startedAt = undefined;
  return true;
}

// ── GitHub functions ───────────────────────────────────────────────────────

export async function getGitHubUsername(token: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `token ${token}`,
      "User-Agent": "Goldy-Builder/1.0",
    },
  });
  const data = (await res.json()) as { login: string };
  return data.login;
}

export async function createGitHubRepo(
  projectName: string,
  description: string
): Promise<{ repoName: string; repoUrl: string }> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is not set");

  const ts = new Date()
    .toISOString()
    .replace(/[-T:.Z]/g, "")
    .slice(0, 12);
  const repoName = `goldy-${projectName}-${ts}`;

  log(`▶ Petya is setting up the warehouse: ${repoName}`, "info");

  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Goldy-Builder/1.0",
    },
    body: JSON.stringify({
      name: repoName,
      private: false,
      description,
      auto_init: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub repo creation failed: ${err}`);
  }

  const data = (await res.json()) as { full_name: string; html_url: string };
  log(`✓ Petya set up the warehouse: ${data.full_name}`, "success");
  return { repoName, repoUrl: data.html_url };
}

export async function pushFilesToGitHub(
  repoName: string,
  files: Record<string, string>
): Promise<void> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is not set");

  const username = await getGitHubUsername(token);
  log(`▶ Petya is stacking ${Object.keys(files).length} files in the warehouse...`, "info");

  // Wait for GitHub to initialise the default branch after auto_init
  await new Promise((r) => setTimeout(r, 3000));

  for (const [filePath, content] of Object.entries(files)) {
    // Get SHA of existing file (auto_init creates a README.md we must overwrite)
    let existingSha: string | undefined;
    try {
      const checkRes = await fetch(
        `https://api.github.com/repos/${username}/${repoName}/contents/${filePath}`,
        {
          headers: {
            Authorization: `token ${token}`,
            "User-Agent": "Goldy-Builder/1.0",
          },
        }
      );
      if (checkRes.ok) {
        const existing = (await checkRes.json()) as { sha?: string };
        existingSha = existing.sha;
      }
    } catch { /* file doesn't exist yet, that's fine */ }

    const putBody: Record<string, string> = {
      message: `Add ${filePath}`,
      content: Buffer.from(content).toString("base64"),
    };
    if (existingSha) putBody["sha"] = existingSha;

    const putRes = await fetch(
      `https://api.github.com/repos/${username}/${repoName}/contents/${filePath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Goldy-Builder/1.0",
        },
        body: JSON.stringify(putBody),
      }
    );

    if (!putRes.ok) {
      const err = await putRes.text();
      log(`Petya couldn't store ${filePath}: ${err}`, "warn");
    } else {
      log(`  📦 ${filePath}`, "info");
    }
  }

  log("✓ Petya packed everything into the warehouse", "success");
}

// ── Task 1: Vercel direct file upload ─────────────────────────────────────

interface VercelFile {
  file: string;
  sha: string;
  size: number;
}

async function uploadFileToVercel(
  token: string,
  content: string
): Promise<{ sha: string; size: number }> {
  const buf = Buffer.from(content, "utf8");
  const sha = createHash("sha1").update(buf).digest("hex");
  const size = buf.length;

  const res = await fetch("https://api.vercel.com/v2/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "x-now-digest": sha,
      "x-now-size": String(size),
    },
    body: buf,
  });

  if (!res.ok && res.status !== 409) {
    const err = await res.text();
    throw new Error(`Vercel file upload failed: ${err}`);
  }

  return { sha, size };
}

export async function deployToVercel(
  projectName: string,
  files: Record<string, string>
): Promise<{ url: string; customUrl?: string; projectId: string; deploymentName: string }> {
  const token = process.env["VERCEL_TOKEN"];
  if (!token) throw new Error("VERCEL_TOKEN is not set");

  log("▶ Vasya is loading the delivery truck...", "info");

  const fileManifest: VercelFile[] = [];

  for (const [filePath, content] of Object.entries(files)) {
    const { sha, size } = await uploadFileToVercel(token, content);
    fileManifest.push({ file: filePath, sha, size });
    log(`  ↑ ${filePath}`, "info");
  }

  log("▶ Vasya is hitting the road...", "info");

  const deployName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 52);

  const res = await fetch("https://api.vercel.com/v13/deployments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: deployName,
      files: fileManifest,
      projectSettings: {
        framework: null,
        buildCommand: null,
        outputDirectory: null,
        installCommand: null,
      },
      target: "production",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vercel deployment creation failed: ${err}`);
  }

  const data = (await res.json()) as {
    url: string;
    id: string;
    projectId: string;
    name: string;
  };

  // Disable Vercel deployment protection so the URL is publicly accessible
  try {
    await fetch(`https://api.vercel.com/v9/projects/${data.projectId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ssoProtection: null }),
    });
  } catch {
    // Non-fatal — project may already be public
  }

  const deployUrl = `https://${data.url}`;

  // ── Auto-attach custom subdomain (e.g. project-name.goldy.team) ──────────
  let customUrl: string | undefined;
  const customDomain = process.env["CUSTOM_DOMAIN"];
  if (customDomain && data.projectId) {
    const subdomain = `${deployName}.${customDomain}`;
    try {
      const domRes = await fetch(
        `https://api.vercel.com/v9/projects/${data.projectId}/domains`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: subdomain }),
        }
      );
      const domData = (await domRes.json()) as { error?: { code?: string; message?: string } };
      if (domRes.ok || domData.error?.code === "domain_already_in_project") {
        customUrl = `https://${subdomain}`;
        log(`✓ Vasya pinned the address — LIVE at ${customUrl}`, "success");
      } else {
        log(`Vasya couldn't attach ${subdomain}: ${domData.error?.message ?? "unknown error"}`, "warn");
      }
    } catch (e) {
      log(`Vasya couldn't attach custom domain (non-fatal): ${(e as Error).message}`, "warn");
    }
  }

  if (!customUrl) {
    log(`✓ Vasya delivered the project — it's LIVE! ${deployUrl}`, "success");
  }

  return {
    url: deployUrl,
    customUrl,
    projectId: data.projectId,
    deploymentName: data.name,
  };
}

// ── Orchestration engine ───────────────────────────────────────────────────

const DEFAULT_TASK_PLAN: TaskSpec[] = [
  { id: 1, agent: "claude",  task: "analyze"       },
  { id: 2, agent: "gpt4o",   task: "css"           },
  { id: 3, agent: "recraft", task: "logo"          },
  { id: 4, agent: "flux",    task: "image"         },
  { id: 5, agent: "claude",  task: "code"          },
  { id: 6, agent: "deploy",  task: "github+vercel" },
];

function extractCssClassSummary(css: string): string {
  const classes = css.match(/\.[\w-]+(?=[\s,{:])/g) ?? [];
  const unique = [...new Set(classes)].slice(0, 40);
  return unique.join(" ").slice(0, 300);
}

async function getTaskPlanFromClaude(idea: string): Promise<TaskSpec[]> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return DEFAULT_TASK_PLAN;

  const client = new Anthropic({ apiKey });
  try {
    const goldyPrompt = await getPrompt("Goldy", `You are a build orchestrator. Output ONLY a JSON array of task steps to build a web project.
Each item: {"id": number, "agent": string, "task": string}
Agents available: "claude" (analyze/code), "gpt4o" (css), "recraft" (logo), "flux" (image), "deploy" (github+vercel).
Standard plan: [{"id":1,"agent":"claude","task":"analyze"},{"id":2,"agent":"gpt4o","task":"css"},{"id":3,"agent":"recraft","task":"logo"},{"id":4,"agent":"flux","task":"image"},{"id":5,"agent":"claude","task":"code"},{"id":6,"agent":"deploy","task":"github+vercel"}]
Output ONLY the JSON array. No explanation.`);
    const res = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 400,
      system: goldyPrompt,
      messages: [{ role: "user", content: `Project idea: ${idea}` }],
    });
    const text = res.content[0].type === "text" ? res.content[0].text : "";
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const plan = JSON.parse(match[0]) as TaskSpec[];
      if (Array.isArray(plan) && plan.length > 0) return plan;
    }
  } catch (e) {
    log(`Orchestrator plan failed, using default: ${(e as Error).message}`, "warn");
  }
  return DEFAULT_TASK_PLAN;
}

// ── Task handlers ──────────────────────────────────────────────────────────

async function handleAnalyze(idea: string): Promise<void> {
  state.stage = "analyze";
  log("▶ Goldy is reviewing the blueprints...", "info");

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ apiKey });
  const analyzePrompt = await getPrompt("Goldy", `Return ONLY a JSON object with exactly three fields:
- project_name: kebab-case string
- description: one sentence string
- files_to_generate: array of filenames — always split into index.html, style.css, script.js plus any extra HTML pages needed (e.g. about.html, menu.html, contact.html). Always include README.md. Example: ["index.html","style.css","script.js","about.html","contact.html","README.md"]
No markdown, no explanation.`);
  const res = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 600,
    system: analyzePrompt,
    messages: [{ role: "user", content: idea }],
  });

  const text = res.content[0].type === "text" ? res.content[0].text : "{}";
  const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as {
    project_name?: string;
    description?: string;
    files_to_generate?: string[];
  };

  state.stageData.projectName = parsed.project_name ?? idea.toLowerCase().replace(/\s+/g, "-").slice(0, 30);
  state.stageData.description = parsed.description ?? "Built by Goldy AI";
  state.stageData.fileList = parsed.files_to_generate ?? ["index.html", "README.md"];

  log(`✓ Goldy has the plan — "${state.stageData.projectName}" · ${state.stageData.fileList.length} files to build`, "success");
}

async function handleGpt4oCSS(idea: string): Promise<void> {
  state.stage = "design:css";
  log("▶ Boris is designing the interior...", "info");

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) { log("Boris is off duty — no API key, skipping CSS", "warn"); return; }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 1500,
        messages: [
          {
            role: "system",
            content: await getPrompt("Boris", `You are a CSS designer. Output ONLY raw CSS — no markdown, no explanation, no backticks.
Max 1500 tokens. Create a concise design system with:
- CSS custom properties (:root vars) for colors, fonts, spacing
- @import for Google Fonts (one font pairing)
- .navbar, .hero, .btn-primary, .btn-secondary, .card, .footer styles
- Dark theme, rich accent color matching the project purpose
- Smooth hover transitions
- A .hero class with background: var(--hero-bg) support`),
          },
          {
            role: "user",
            content: `Project: "${state.stageData.projectName ?? "web-app"}"\nDescription: ${idea}\n\nGenerate compact premium CSS.`,
          },
        ],
      }),
    });

    const rawBody = await res.text();
    console.log(`[DIAG] GPT-4o HTTP ${res.status} | first 200 chars: ${rawBody.slice(0, 200)}`);
    log(`[DIAG] GPT-4o HTTP ${res.status}`, res.ok ? "info" : "warn");
    if (!res.ok) { log(`Boris couldn't finish — HTTP ${res.status}`, "warn"); return; }
    const data = JSON.parse(rawBody) as { choices: Array<{ message: { content: string } }> };
    const css = data.choices[0]?.message?.content?.trim() ?? "";
    log(`[DIAG] GPT-4o first 200 chars of CSS: ${css.slice(0, 200)}`, "info");
    state.stageData.css = css;
    state.stageData.cssClassSummary = extractCssClassSummary(css);
    log(`✓ Boris nailed the interior design (${css.length} chars)`, "success");
  } catch (e) {
    log(`Boris hit a snag: ${(e as Error).message}`, "warn");
  }
}

async function handleRecraft(idea: string): Promise<void> {
  state.stage = "design:logo";
  log("▶ Masha is painting the logo...", "info");

  const apiKey = process.env["RECRAFT_API_KEY"];
  if (!apiKey) { log("Masha is off duty — no API key, skipping logo", "warn"); return; }

  try {
    const prompt = `minimalist flat vector logo icon for ${state.stageData.projectName ?? "app"}, single geometric shape, bold, professional, no text, clean`;
    const res = await fetch("https://external.api.recraft.ai/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, style: "vector_illustration", response_format: "url", n: 1 }),
    });

    const recraftBody = await res.text();
    console.log(`[DIAG] Recraft HTTP ${res.status} | first 200 chars: ${recraftBody.slice(0, 200)}`);
    log(`[DIAG] Recraft HTTP ${res.status}`, res.ok ? "info" : "warn");
    if (!res.ok) { log(`Masha's brush broke — HTTP ${res.status}`, "warn"); return; }
    const data = JSON.parse(recraftBody) as { data?: Array<{ url?: string }> };
    const url = data.data?.[0]?.url ?? "";
    log(`[DIAG] Recraft logo URL (first 200): ${url.slice(0, 200)}`, "info");
    if (url) {
      state.stageData.logoUrl = url;
      log("✓ Masha's logo is ready", "success");
    } else {
      log("Masha's canvas came back blank", "warn");
    }
  } catch (e) {
    log(`Masha had a problem: ${(e as Error).message}`, "warn");
  }
}

async function handleFlux(idea: string): Promise<void> {
  state.stage = "design:image";
  log("▶ Ivan is taking photos of the site...", "info");

  const token = process.env["REPLICATE_API_TOKEN"];
  if (!token) { log("Ivan is off duty — no API key, skipping photos", "warn"); return; }

  try {
    const prompt = `Professional hero image for a web app: ${idea.slice(0, 120)}. Cinematic lighting, dark atmospheric background, 4k quality, no text, no UI elements.`;
    const createRes = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait=30" },
      body: JSON.stringify({ input: { prompt, num_outputs: 1, aspect_ratio: "16:9", output_format: "webp", output_quality: 80 } }),
    });

    const fluxBody = await createRes.text();
    console.log(`[DIAG] FLUX HTTP ${createRes.status} | first 200 chars: ${fluxBody.slice(0, 200)}`);
    log(`[DIAG] FLUX HTTP ${createRes.status}`, createRes.ok ? "info" : "warn");
    if (!createRes.ok) { log(`Ivan dropped his camera — HTTP ${createRes.status}`, "warn"); return; }
    const prediction = JSON.parse(fluxBody) as { id: string; status: string; output?: string[]; urls?: { get: string } };

    let imageUrl = prediction.output?.[0] ?? "";
    if (!imageUrl && prediction.status !== "succeeded" && prediction.urls?.get) {
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const pollRes = await fetch(prediction.urls.get, { headers: { Authorization: `Bearer ${token}` } });
        const polled = (await pollRes.json()) as { status: string; output?: string[] };
        if (polled.status === "succeeded" && polled.output?.[0]) { imageUrl = polled.output[0]; break; }
        if (polled.status === "failed") break;
      }
    }

    if (imageUrl) {
      state.stageData.heroImageUrl = imageUrl;
      log("✓ Ivan got the perfect shot", "success");
    } else {
      log("Ivan's film came out blank", "warn");
    }
  } catch (e) {
    log(`Ivan had a problem: ${(e as Error).message}`, "warn");
  }
}

// Generate one file at a time — avoids token-limit truncation on multi-page sites
async function generateSingleFile(
  filename: string,
  projectName: string,
  description: string,
  allPageNames: string[],
  generatedSoFar: Record<string, string>,
  idea: string,
  designHints: string,
  client: Anthropic
): Promise<string> {
  const ext = filename.split(".").pop() ?? "";

  // Summarise already-generated files as context (cap each at 3000 chars to stay in budget)
  const context = Object.entries(generatedSoFar)
    .map(([f, c]) => `=== ${f} ===\n${c.length > 3000 ? c.slice(0, 3000) + "\n...(truncated)" : c}`)
    .join("\n\n");

  const navLinks = allPageNames
    .filter(f => f.endsWith(".html"))
    .map(f => {
      const label = f.replace(".html", "").replace(/-/g, " ");
      return `<a href="${f}">${label.charAt(0).toUpperCase() + label.slice(1)}</a>`;
    })
    .join(" | ");

  let fileInstructions = "";
  if (ext === "css") {
    fileInstructions = `Generate a complete, beautiful stylesheet.
- Clean modern design: consistent spacing, typography, color palette.
- Include styles for: nav, hero, sections, cards, footer, buttons, forms.
- Mobile-responsive with media queries.
- ${designHints}
Return ONLY the CSS. No markdown fences.`;
  } else if (ext === "js") {
    fileInstructions = `Generate complete shared JavaScript.
- Mobile hamburger menu toggle, smooth scroll, active nav highlighting.
- Any interactive features the project needs.
Return ONLY the JS. No markdown fences.`;
  } else if (ext === "html") {
    const isIndex = filename === "index.html";
    fileInstructions = `Generate a complete HTML page for "${filename}".
- Link stylesheet: <link rel="stylesheet" href="style.css">
- Link script at end of body: <script src="script.js"></script>
- Nav must link to ALL pages: ${navLinks}
- ${isIndex ? designHints : ""}
- Fill with real, meaningful content — no placeholder text.
Return ONLY the HTML. No markdown fences.`;
  } else {
    fileInstructions = `Generate the complete content for "${filename}". Return ONLY the file content. No markdown fences.`;
  }

  const system = await getPrompt("Goldy", `You are a senior web developer generating "${filename}" for a website project.
Return ONLY the raw file content — no explanation, no markdown fences, no preamble.

MANDATORY CSS LAWS — NEVER VIOLATE:

1. NAVBAR: Always fixed at top
   nav, header, .navbar, .nav { position: fixed; top: 0; left: 0; right: 0; width: 100%; z-index: 9999; }

2. FIRST SECTION: Always has padding-top to clear navbar
   main > *:first-child, section:first-of-type, .hero { padding-top: 80px; }

3. HERO TEXT: Always above background elements
   .hero-content, .hero-text, .hero-inner > div:first-child { position: relative; z-index: 10; }

4. BACKGROUND DECORATIONS: Always behind content
   .hero-bg, .bg-text, .hero-visual, [class*="bg-"], [class*="-bg"] { position: absolute; z-index: 0; pointer-events: none; }

5. NEVER put large decorative text in the hero — no giant brand name watermarks

6. NEVER create duplicate nav elements — only ONE nav per page

7. HERO LAYOUT: Two column = flex row, never absolute positioning
   .hero-inner, .hero-container { display: flex; align-items: center; gap: 60px; position: relative; }
   .hero-text { flex: 0 0 50%; position: relative; z-index: 10; }
   .hero-visual { flex: 0 0 45%; position: relative; z-index: 1; }

8. ALL SECTIONS: Never overflow horizontally
   section, .section { position: relative; overflow-x: hidden; clear: both; }

9. Z-INDEX HIERARCHY (always follow this order):
   - Navbar: 9999
   - Modals/overlays: 1000
   - Hero text content: 10
   - Hero visuals/mockups: 1
   - Background decorations: 0 or -1

10. IMAGES in hero: Never position:absolute unless explicitly decorative
    img.hero-image, .hero-mockup { position: relative; z-index: 1; max-width: 100%; }`);

  const user = `Project: "${projectName}"
Description: ${description}
All files in this project: ${allPageNames.join(", ")}

${context ? `Already generated:\n${context}\n` : ""}
Instructions for ${filename}:
${fileInstructions}

Original idea: ${idea}`;

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: user }],
  });

  const stopReason = response.stop_reason;
  const tokens = response.usage?.output_tokens ?? "?";
  console.log(`[DIAG] ${filename}: stop_reason=${stopReason} tokens=${tokens}`);
  log(`  [${filename}] ${tokens} tokens, stop: ${stopReason}`, "info");

  const raw = response.content[0].type === "text" ? response.content[0].text.trim() : "";
  // Strip any accidental markdown fences
  return raw.replace(/^```[\w]*\n?/m, "").replace(/\n?```$/m, "").trim();
}

async function handleCode(idea: string): Promise<void> {
  state.stage = "code";
  log("▶ Goldy is building the structure...", "info");

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ apiKey });
  const {
    projectName = "project",
    description = idea,
    fileList: rawFileList,
    cssClassSummary = "",
    heroImageUrl = "",
    logoUrl = "",
  } = state.stageData;

  // Ensure we always have the core files
  const baseFiles = ["index.html", "style.css", "script.js", "README.md"];
  const fileList: string[] = rawFileList?.length
    ? [...new Set([...rawFileList, ...baseFiles])]
    : baseFiles;

  // Order: CSS → JS → HTML pages (index.html last so it has nav context) → everything else
  const ordered = [
    ...fileList.filter(f => f.endsWith(".css")),
    ...fileList.filter(f => f.endsWith(".js")),
    ...fileList.filter(f => f.endsWith(".html") && f !== "index.html"),
    ...fileList.filter(f => f === "index.html"),
    ...fileList.filter(f => !f.endsWith(".css") && !f.endsWith(".js") && !f.endsWith(".html")),
  ];

  const designHints = [
    cssClassSummary ? `Boris's CSS classes available (will be auto-prepended to style.css): ${cssClassSummary}` : "",
    logoUrl ? `In the navbar in index.html, place exactly: <!-- GOLDY_LOGO --> where the logo <img> should go.` : "",
    heroImageUrl ? `On the hero section in index.html, set style attribute to exactly: <!-- GOLDY_HERO -->` : "",
  ].filter(Boolean).join("\n");

  const generatedFiles: Record<string, string> = {};

  for (const filename of ordered) {
    log(`  ▶ Writing ${filename}...`, "info");
    const content = await generateSingleFile(
      filename, projectName, description, ordered, generatedFiles, idea, designHints, client
    );
    generatedFiles[filename] = content;
    log(`  ✓ ${filename} done (${content.length} chars)`, "success");
  }

  state.stageData.files = generatedFiles;
  state.stageData.features = [];
  log(`✓ Goldy finished building — ${Object.keys(generatedFiles).length} files ready`, "success");
}

function handleAssemble(): void {
  state.stage = "assemble";
  log("▶ Goldy is putting everything together...", "info");

  const files = state.stageData.files ?? {};
  const css = state.stageData.css ?? "";
  const logoUrl = state.stageData.logoUrl ?? "";
  const heroImageUrl = state.stageData.heroImageUrl ?? "";

  if (!files["index.html"]) {
    log("No main page found — Goldy is skipping assembly", "warn");
    return;
  }

  let html = files["index.html"];

  // Inject Boris's CSS — prefer style.css (multi-file projects), fall back to GOLDY_CSS placeholder
  if (css) {
    if (files["style.css"] !== undefined) {
      files["style.css"] = `/* ── Boris's design system ── */\n${css}\n\n/* ── Project styles ── */\n${files["style.css"]}`;
      log("  ✓ Boris's designs merged into style.css", "info");
    } else {
      const cssPlaceholderFound = html.includes("<!-- GOLDY_CSS -->");
      console.log(`[DIAG] GOLDY_CSS placeholder found: ${cssPlaceholderFound}`);
      log(`[DIAG] GOLDY_CSS placeholder found: ${cssPlaceholderFound}`, "info");
      if (cssPlaceholderFound) {
        html = html.replace("<!-- GOLDY_CSS -->", `<style>\n${css}\n</style>`);
        log("  ✓ Boris's designs injected into index.html", "info");
      } else {
        log("  ⚠ Boris's spot is missing in the blueprint", "warn");
      }
    }
  }

  if (logoUrl && html.includes("<!-- GOLDY_LOGO -->")) {
    const initial = (state.stageData.projectName ?? "G").charAt(0).toUpperCase();
    const fallbackStyle = "width:40px;height:40px;border-radius:50%;background:#D4AF37;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;color:#fff;font-family:sans-serif;flex-shrink:0;";
    const onerror = `this.style.display='none';var f=document.createElement('div');f.style.cssText='${fallbackStyle}';f.textContent='${initial}';this.parentNode.insertBefore(f,this.nextSibling);`;
    html = html.replace("<!-- GOLDY_LOGO -->", `<img src="${logoUrl}" alt="Logo" class="navbar-logo" style="height:40px;width:auto;" onerror="${onerror}">`);
    log("  ✓ Masha's logo is mounted", "info");
  }

  if (heroImageUrl && html.includes("<!-- GOLDY_HERO -->")) {
    html = html.replace("<!-- GOLDY_HERO -->", `background-image:url('${heroImageUrl}');background-size:cover;background-position:center;`);
    log("  ✓ Ivan's photo is framed", "info");
  }

  files["index.html"] = html;
  state.stageData.files = files;
  log("✓ Everything is assembled — looking great!", "success");
}

async function handleDeploy(): Promise<void> {
  state.stage = "deploy";
  log("▶ Petya is packing up, Vasya is ready to deliver...", "info");

  const files = state.stageData.files ?? {};
  const projectName = state.stageData.projectName ?? "goldy-project";
  const description = state.stageData.description ?? "Built by Goldy AI";

  let repoUrl = "";
  let deployUrl = "";
  let projectId = "";
  let deploymentName = "";

  if (process.env["GITHUB_TOKEN"]) {
    try {
      const ghResult = await createGitHubRepo(projectName, description);
      repoUrl = ghResult.repoUrl;
      await pushFilesToGitHub(ghResult.repoName, files);
      state.stageData.repoUrl = repoUrl;
    } catch (e) {
      log(`Petya had a snag (non-fatal): ${(e as Error).message}`, "warn");
    }
  }

  if (process.env["VERCEL_TOKEN"]) {
    try {
      const vercelResult = await deployToVercel(projectName, files);
      // Prefer the custom subdomain URL; fall back to vercel.app URL
      deployUrl = vercelResult.customUrl ?? vercelResult.url;
      projectId = vercelResult.projectId;
      deploymentName = vercelResult.deploymentName;
      state.stageData.deployUrl = deployUrl;
      state.stageData.vercelProjectId = projectId;
      state.stageData.deploymentName = deploymentName;
    } catch (e) {
      log(`Vasya couldn't deliver: ${(e as Error).message}`, "error");
      if (!repoUrl) throw e;
      log("✓ Petya stored the files safely", "info");
    }
  } else {
    log("Vasya is off duty — no delivery key", "warn");
  }

  log(`✓ Crew is done — build complete!`, "success");
  if (deployUrl) log(`✓ Your project is LIVE at ${deployUrl}`, "success");
  else if (repoUrl) log(`✓ Petya saved it all at: ${repoUrl}`, "success");
}

async function runTaskPlan(plan: TaskSpec[], idea: string): Promise<void> {
  for (const task of plan) {
    const label = `[${task.agent}:${task.task}]`;
    try {
      if (task.agent === "claude" && task.task === "analyze") {
        await handleAnalyze(idea);
      } else if (task.agent === "gpt4o" && task.task === "css") {
        await handleGpt4oCSS(idea);
      } else if (task.agent === "recraft" && task.task === "logo") {
        await handleRecraft(idea);
      } else if (task.agent === "flux" && task.task === "image") {
        await handleFlux(idea);
      } else if (task.agent === "claude" && task.task === "code") {
        await handleCode(idea);
        handleAssemble();
      } else if (task.agent === "deploy") {
        await handleDeploy();
      } else {
        log(`Unknown task ${label} — skipping`, "warn");
      }
    } catch (e) {
      const isDesign = ["gpt4o", "recraft", "flux"].includes(task.agent);
      if (isDesign) {
        log(`${label} failed (non-fatal): ${(e as Error).message}`, "warn");
      } else {
        throw e;
      }
    }
  }
}

async function runBuild(idea: string) {
  try {
    log("▶ Goldy is calling the crew together...", "info");
    const plan = await getTaskPlanFromClaude(idea);
    log(`Crew assignments: ${plan.map((t) => `${t.agent}:${t.task}`).join(" → ")}`, "info");

    await runTaskPlan(plan, idea);

    const files = state.stageData.files ?? {};
    const projectName = state.stageData.projectName ?? "project";
    const features = state.stageData.features ?? [];
    const deployUrl = state.stageData.deployUrl ?? "";
    const repoUrl = state.stageData.repoUrl ?? "";

    if (features.length) log(`Built features: ${features.slice(0, 3).join(" · ")}`, "info");

    state.status = "done";
    state.stage = "done";

    let dbProjectId: number | undefined;
    if (state.userId) {
      const id = await saveProject({
        userId: state.userId,
        name: projectName,
        vercelUrl: deployUrl || undefined,
        githubUrl: repoUrl || undefined,
        files,
      });
      if (id) dbProjectId = id;
    }

    state.result = {
      url: deployUrl || repoUrl || undefined,
      repoUrl: repoUrl || undefined,
      projectName,
      filesCreated: Object.keys(files).length,
      projectId: dbProjectId,
      vercelProjectId: state.stageData.vercelProjectId ?? undefined,
      deploymentName: state.stageData.deploymentName ?? undefined,
    };

    log(`✓ Crew knocked it out! ${Object.keys(files).length} files built.`, "success");
  } catch (err) {
    state.status = "error";
    state.stage = "error";
    state.error = (err as Error).message;
    log(`Build failed: ${(err as Error).message}`, "error");
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

router.post("/roadmap", requireAuth, async (req, res) => {
  const { idea } = req.body as { idea?: string };
  if (!idea || idea.trim().length < 5) {
    res.status(400).json({ error: "Please provide a project idea" });
    return;
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    res.status(500).json({ error: "Anthropic API key not configured" });
    return;
  }

  try {
    const claude = new Anthropic({ apiKey });
    const msg = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: `Analyze this project idea and split it into 3 build phases. Return ONLY valid JSON, no markdown.

Project idea: "${idea.trim()}"

Return exactly this JSON structure:
{
  "phase1": ["feature 1", "feature 2", ...],
  "phase2": ["feature 1", "feature 2", ...],
  "phase3": ["feature 1", "feature 2", ...]
}

Rules:
- phase1 (CORE): 3-5 essential features that make a working v1. These get built now.
- phase2 (IMPORTANT): 3-5 features the user can add later via the editor. Things like animations, extra pages, integrations.
- phase3 (EXTRA): 3-5 nice-to-have features for the future. Advanced stuff.
- Each item should be a short phrase (3-8 words).
- Return ONLY the JSON object, nothing else.`,
        },
      ],
    });

    const text =
      msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
    const cleaned = text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "");
    const roadmap = JSON.parse(cleaned);

    const isStrArr = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((s) => typeof s === "string" && s.length < 200);

    if (
      !isStrArr(roadmap.phase1) ||
      !isStrArr(roadmap.phase2) ||
      !isStrArr(roadmap.phase3)
    ) {
      throw new Error("Invalid roadmap structure");
    }

    res.json({
      phase1: roadmap.phase1.slice(0, 5),
      phase2: roadmap.phase2.slice(0, 5),
      phase3: roadmap.phase3.slice(0, 5),
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to generate roadmap" });
  }
});

router.post("/build", requireAuth, (req, res) => {
  const { idea } = req.body as { idea?: string };

  if (!idea || idea.trim().length < 5) {
    res.status(400).json({ error: "Please provide a project idea" });
    return;
  }

  clearIfTimedOut();
  if (state.status === "building") {
    res.status(409).json({ error: "A build is already in progress" });
    return;
  }

  resetState(idea.trim(), req.user?.id);
  void runBuild(idea.trim());
  res.json({ ok: true, message: "Build started" });
});

router.get("/status", (_req, res) => {
  res.json({
    status: state.status,
    stage: state.stage,
    logs: state.logs,
    result: state.result,
    error: state.error,
    idea: state.idea,
    customDomain: process.env["CUSTOM_DOMAIN"] ?? null,
  });
});

router.post("/admin/reset-build", requireAdmin, (_req, res) => {
  const previous = state.status;
  state.status = "idle";
  state.stage = "";
  state.stageData = {};
  state.logs = [];
  state.result = {};
  state.error = undefined;
  state.startedAt = undefined;
  console.log(`[Goldy] [WARN] Admin manually reset build state from "${previous}" to "idle"`);
  res.json({ ok: true, previous });
});

// ── Task 3: Domain connection routes ──────────────────────────────────────

router.post("/domain", async (req, res) => {
  const { domain } = req.body as { domain?: string };

  if (!domain || domain.trim().length < 3) {
    res.status(400).json({ error: "Please provide a valid domain name" });
    return;
  }

  const token = process.env["VERCEL_TOKEN"];
  if (!token) {
    res.status(500).json({ error: "VERCEL_TOKEN is not configured" });
    return;
  }

  const vercelPid = state.result.vercelProjectId;
  if (!vercelPid) {
    res.status(400).json({ error: "No active deployment found. Build a project first." });
    return;
  }

  const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, "");

  try {
    const addRes = await fetch(
      `https://api.vercel.com/v9/projects/${vercelPid}/domains`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: cleanDomain }),
      }
    );

    const addData = (await addRes.json()) as {
      name?: string;
      verification?: Array<{ type: string; domain: string; value: string; reason: string }>;
      error?: { message: string; code?: string };
    };

    if (!addRes.ok && addData.error?.code !== "domain_already_in_project") {
      res.status(addRes.status).json({
        error: addData.error?.message || "Failed to add domain to Vercel project",
      });
      return;
    }

    const checkRes = await fetch(
      `https://api.vercel.com/v9/projects/${vercelPid}/domains/${cleanDomain}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const checkData = (await checkRes.json()) as {
      name?: string;
      verified?: boolean;
      verification?: Array<{ type: string; domain: string; value: string }>;
      apexName?: string;
      projectId?: string;
      redirect?: string | null;
      error?: { message: string };
    };

    const isApex = !cleanDomain.includes(".") || cleanDomain.split(".").length === 2;
    const apexName = checkData.apexName || cleanDomain;

    const records = [];

    if (isApex || cleanDomain === apexName) {
      records.push({
        type: "A",
        name: "@",
        value: "76.76.21.21",
        description: `Add this A record to your DNS for ${apexName}`,
      });
    } else {
      records.push({
        type: "CNAME",
        name: cleanDomain.replace(`.${apexName}`, ""),
        value: "cname.vercel-dns.com",
        description: `Add this CNAME record to your DNS provider`,
      });
    }

    if (checkData.verification && checkData.verification.length > 0) {
      for (const v of checkData.verification) {
        records.push({
          type: v.type,
          name: v.domain,
          value: v.value,
          description: "Domain verification record",
        });
      }
    }

    res.json({
      ok: true,
      domain: cleanDomain,
      verified: checkData.verified ?? false,
      records,
      vercelProjectId: vercelPid,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/domain/check", async (req, res) => {
  const domain = req.query["domain"] as string;

  if (!domain) {
    res.status(400).json({ error: "domain query param required" });
    return;
  }

  const token = process.env["VERCEL_TOKEN"];
  if (!token) {
    res.status(500).json({ error: "VERCEL_TOKEN is not configured" });
    return;
  }

  const vercelPid = state.result.vercelProjectId;
  if (!vercelPid) {
    res.status(400).json({ error: "No active deployment found" });
    return;
  }

  try {
    const checkRes = await fetch(
      `https://api.vercel.com/v9/projects/${vercelPid}/domains/${domain}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const data = (await checkRes.json()) as {
      verified?: boolean;
      verification?: Array<{ type: string; domain: string; value: string }>;
      error?: { message: string };
    };

    if (!checkRes.ok) {
      res.status(checkRes.status).json({
        error: data.error?.message || "Failed to check domain",
      });
      return;
    }

    res.json({
      domain,
      verified: data.verified ?? false,
      verification: data.verification ?? [],
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/callback", (req, res) => {
  const token = req.headers["x-callback-token"];
  const expected = process.env["SECRET_CALLBACK_TOKEN"];

  if (expected && token !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { status, url, repo_url, project_name, files_created, message } =
    req.body as {
      status?: string;
      url?: string;
      repo_url?: string;
      project_name?: string;
      files_created?: number;
      message?: string;
    };

  if (status === "done") {
    state.status = "done";
    state.result = {
      url,
      repoUrl: repo_url,
      projectName: project_name,
      filesCreated: files_created,
    };
    log(`External build complete! URL: ${url}`, "success");
  } else if (status === "error") {
    state.status = "error";
    state.error = message || "Unknown error from external builder";
    log(`External build error: ${message}`, "error");
  }

  res.json({ ok: true });
});

export default router;
