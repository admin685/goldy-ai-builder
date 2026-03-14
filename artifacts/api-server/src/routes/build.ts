import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";

const router: IRouter = Router();

// ── Multi-AI Design Pipeline ───────────────────────────────────────────────

interface DesignAssets {
  css: string;
  heroImageUrl: string;
  logoSvg: string;
}

async function generateCSSWithGPT(idea: string, projectName: string): Promise<string> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    log("OPENAI_API_KEY not set — skipping GPT-4o CSS generation", "warn");
    return "";
  }

  log("GPT-4o: generating premium CSS styling...", "info");

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
          content: `You are a world-class CSS designer. Generate premium, production-ready CSS for a web project. 
Output ONLY raw CSS — no markdown, no explanation, no backticks. 
Use CSS custom properties (variables). Create a cohesive design system with:
- A distinctive color palette (dark theme, rich accent colors matching the project's purpose)
- Custom Google Font pairings using @import
- Smooth transitions and hover effects
- Clean card/container styles
- A .hero section with a large background image via var(--hero-bg)
- A .navbar with logo area
- Responsive layout utilities
- Subtle animations with @keyframes`,
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
    log(`GPT-4o CSS generation failed: ${err.slice(0, 200)}`, "warn");
    return "";
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const css = data.choices[0]?.message?.content?.trim() ?? "";
  log("GPT-4o: CSS generated successfully ✓", "success");
  return css;
}

async function generateHeroImageWithFLUX(idea: string): Promise<string> {
  const token = process.env["REPLICATE_API_TOKEN"];
  if (!token) {
    log("REPLICATE_API_TOKEN not set — skipping FLUX image generation", "warn");
    return "";
  }

  log("FLUX: generating hero image...", "info");

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
    log(`FLUX image generation failed: ${err.slice(0, 200)}`, "warn");
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
        log("FLUX: hero image generated successfully ✓", "success");
        return polled.output[0];
      }
      if (polled.status === "failed") {
        log("FLUX: image generation failed", "warn");
        return "";
      }
    }
    log("FLUX: image generation timed out", "warn");
    return "";
  }

  const imageUrl = prediction.output?.[0] ?? "";
  if (imageUrl) log("FLUX: hero image generated successfully ✓", "success");
  return imageUrl;
}

async function generateLogoWithRecraft(projectName: string, idea: string): Promise<string> {
  const apiKey = process.env["RECRAFT_API_KEY"];
  if (!apiKey) {
    log("RECRAFT_API_KEY not set — skipping Recraft logo generation", "warn");
    return "";
  }

  log("Recraft: generating SVG logo...", "info");

  const prompt = `Minimalist modern SVG logo for "${projectName}": ${idea.slice(0, 100)}. Clean geometric design, single color, professional brand mark.`;

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
    log(`Recraft logo generation failed: ${err.slice(0, 200)}`, "warn");
    return "";
  }

  const data = (await res.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };

  const imageUrl = data.data?.[0]?.url ?? "";
  if (imageUrl) {
    log("Recraft: logo generated successfully ✓", "success");
    return imageUrl;
  }

  log("Recraft: no image URL returned", "warn");
  return "";
}

export async function runDesignPipeline(idea: string, projectName: string): Promise<DesignAssets> {
  log("Launching parallel design pipeline (GPT-4o + FLUX + Recraft)...", "info");

  const [css, heroImageUrl, logoSvg] = await Promise.all([
    generateCSSWithGPT(idea, projectName).catch((e) => {
      log(`GPT-4o CSS error: ${(e as Error).message}`, "warn");
      return "";
    }),
    generateHeroImageWithFLUX(idea).catch((e) => {
      log(`FLUX image error: ${(e as Error).message}`, "warn");
      return "";
    }),
    generateLogoWithRecraft(projectName, idea).catch((e) => {
      log(`Recraft logo error: ${(e as Error).message}`, "warn");
      return "";
    }),
  ]);

  log("Design pipeline complete — handing assets to Claude for assembly...", "success");
  return { css, heroImageUrl, logoSvg };
}

export interface BuildLog {
  ts: number;
  msg: string;
  type: "info" | "success" | "error" | "warn";
}

export interface BuildState {
  status: "idle" | "building" | "done" | "error";
  logs: BuildLog[];
  result: {
    url?: string;
    repoUrl?: string;
    projectName?: string;
    filesCreated?: number;
    projectId?: string;
    deploymentName?: string;
  };
  error?: string;
  idea?: string;
}

export const state: BuildState = {
  status: "idle",
  logs: [],
  result: {},
};

export function log(msg: string, type: BuildLog["type"] = "info") {
  state.logs.push({ ts: Date.now(), msg, type });
  console.log(`[Goldy] [${type.toUpperCase()}] ${msg}`);
}

export function resetState(idea: string) {
  state.status = "building";
  state.logs = [];
  state.result = {};
  state.error = undefined;
  state.idea = idea;
  log("Build started — Goldy is thinking...", "info");
}

// ── Claude: code generation + design asset assembly ───────────────────────

async function callClaude(
  idea: string,
  assets?: DesignAssets
): Promise<Record<string, unknown>> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ apiKey });

  const hasAssets = assets && (assets.css || assets.heroImageUrl || assets.logoSvg);

  const assetInstructions = hasAssets
    ? `
DESIGN ASSETS — you have been given pre-generated design assets. You MUST integrate them exactly as described:

${assets.css ? `1. GPT-4o PREMIUM CSS — Insert this verbatim inside a <style> tag in the <head>. Do NOT alter or override it. Build your HTML to use the class names defined in it (.hero, .navbar, etc.):
\`\`\`css
${assets.css.slice(0, 6000)}
\`\`\`
` : ""}
${assets.heroImageUrl ? `2. FLUX HERO IMAGE — Use this URL as the hero section's background image. Set it inline: style="background-image: url('${assets.heroImageUrl}')" on the .hero element. Also set background-size: cover; background-position: center;
` : ""}
${assets.logoSvg ? `3. RECRAFT LOGO — Place this logo image in the navbar using: <img src="${assets.logoSvg}" alt="Logo" class="navbar-logo" style="height:40px;width:auto;"> inside the .navbar element.
` : ""}
IMPORTANT: Do NOT generate default/generic CSS for the hero or navbar — the GPT-4o CSS already handles that. Just wire up the HTML structure to use those classes.
`
    : "";

  const systemPrompt = `You are a senior full-stack developer. The user gives you a project idea. You return a complete, deployable project as JSON.

CRITICAL RULES:
- Generate REAL, working code. Not pseudocode, not placeholders.
- For webapp and landing types: output ONLY static files (HTML, CSS, JS). Do NOT generate any server-side code, requirements.txt, app.py, or any Python/Node server. These projects must run as static files in a browser.
- For telegram_bot type: generate Python with python-telegram-bot library.
- For api type: generate a Node.js Express API with a package.json.
- Every file must be complete and self-contained.
- Include a README.md with setup instructions.

For webapp and landing projects specifically:
- Generate ONE self-contained index.html with all CSS and JS inline (no separate files needed, but you can add them).
- Make the UI genuinely beautiful: dark theme (#0d1117 background), clean layout, smooth interactions.
- Use vanilla JS only — no React, no frameworks, no CDN imports.
- Store data in localStorage where appropriate.
- The app must work by opening index.html in a browser with no server.
${assetInstructions}
Output format — return ONLY valid JSON, no markdown fences, no explanation:
{
  "project_name": "kebab-case-name",
  "project_type": "webapp",
  "tech_stack": "HTML/CSS/JavaScript",
  "description": "One sentence description",
  "features": ["Feature 1", "Feature 2", "Feature 3", "Feature 4"],
  "files": {
    "index.html": "<!DOCTYPE html>... complete file ...",
    "README.md": "# Project Name\\n..."
  }
}`;

  log("Claude: assembling final project with all design assets...", "info");

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 14000,
    system: systemPrompt,
    messages: [{ role: "user", content: idea }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude did not return valid JSON");

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  log(`Project type: ${parsed["project_type"] as string} — ${parsed["tech_stack"] as string}`, "info");
  return parsed;
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

  log(`Creating GitHub repository: ${repoName}`, "info");

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
  log(`Repository created: ${data.full_name}`, "success");
  return { repoName, repoUrl: data.html_url };
}

export async function pushFilesToGitHub(
  repoName: string,
  files: Record<string, string>
): Promise<void> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is not set");

  const username = await getGitHubUsername(token);
  log(`Pushing ${Object.keys(files).length} files to GitHub...`, "info");

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
      log(`Warning: failed to push ${filePath}: ${err}`, "warn");
    } else {
      log(`  ✓ ${filePath}`, "info");
    }
  }

  log("All files pushed to GitHub", "success");
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
): Promise<{ url: string; projectId: string; deploymentName: string }> {
  const token = process.env["VERCEL_TOKEN"];
  if (!token) throw new Error("VERCEL_TOKEN is not set");

  log("Uploading files to Vercel...", "info");

  const fileManifest: VercelFile[] = [];

  for (const [filePath, content] of Object.entries(files)) {
    const { sha, size } = await uploadFileToVercel(token, content);
    fileManifest.push({ file: filePath, sha, size });
    log(`  ↑ ${filePath}`, "info");
  }

  log("Creating Vercel deployment...", "info");

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
  log(`Deployed to Vercel: ${deployUrl}`, "success");

  return {
    url: deployUrl,
    projectId: data.projectId,
    deploymentName: data.name,
  };
}

// ── Main build orchestration ───────────────────────────────────────────────

async function runBuild(idea: string) {
  try {
    // Step 1: Quick spec call to get project_name for the design pipeline
    log("Getting project details from Claude...", "info");
    const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] ?? "" });
    const quickRes = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 300,
      system: "Return ONLY a JSON object with two fields: project_name (kebab-case) and description (one sentence). No markdown, no explanation.",
      messages: [{ role: "user", content: idea }],
    });
    const quickText = quickRes.content[0].type === "text" ? quickRes.content[0].text : "{}";
    const quickJson = JSON.parse(quickText.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as {
      project_name?: string;
      description?: string;
    };
    const earlyName = quickJson.project_name ?? idea.toLowerCase().replace(/\s+/g, "-").slice(0, 30);
    const earlyDesc = quickJson.description ?? "Built by Goldy AI";
    log(`Project: "${earlyName}"`, "success");

    // Step 2: Run design pipeline in parallel (GPT-4o CSS + FLUX image + Recraft logo)
    const assets = await runDesignPipeline(idea, earlyName);

    // Step 3: Claude assembles full code with all design assets injected
    const spec = await callClaude(idea, assets);
    const projectName = (spec["project_name"] as string) || earlyName;
    const description = (spec["description"] as string) || earlyDesc;
    const files = (spec["files"] as Record<string, string>) || {};
    const features = (spec["features"] as string[]) || [];

    log(`${description}`, "info");
    log(`Features: ${features.slice(0, 3).join(" · ")}`, "info");

    let repoUrl = "";
    let deployUrl = "";
    let projectId = "";
    let deploymentName = "";

    if (process.env["GITHUB_TOKEN"]) {
      try {
        const ghResult = await createGitHubRepo(projectName, description);
        repoUrl = ghResult.repoUrl;
        await pushFilesToGitHub(ghResult.repoName, files);
      } catch (e) {
        log(`GitHub failed (non-fatal): ${(e as Error).message}`, "warn");
      }
    }

    if (process.env["VERCEL_TOKEN"]) {
      try {
        const vercelResult = await deployToVercel(projectName, files);
        deployUrl = vercelResult.url;
        projectId = vercelResult.projectId;
        deploymentName = vercelResult.deploymentName;
      } catch (e) {
        log(`Vercel deployment failed: ${(e as Error).message}`, "error");
        if (!repoUrl) throw e;
        log("Project code is saved to GitHub", "info");
      }
    } else {
      log("VERCEL_TOKEN not set — skipping deployment", "warn");
    }

    state.status = "done";
    state.result = {
      url: deployUrl || repoUrl || undefined,
      repoUrl: repoUrl || undefined,
      projectName,
      filesCreated: Object.keys(files).length,
      projectId: projectId || undefined,
      deploymentName: deploymentName || undefined,
    };

    log(`Build complete! ${Object.keys(files).length} files created.`, "success");
    if (deployUrl) log(`Live at: ${deployUrl}`, "success");
    else if (repoUrl) log(`Code at: ${repoUrl}`, "success");
  } catch (err) {
    state.status = "error";
    state.error = (err as Error).message;
    log(`Build failed: ${(err as Error).message}`, "error");
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

router.post("/build", (req, res) => {
  const { idea } = req.body as { idea?: string };

  if (!idea || idea.trim().length < 5) {
    res.status(400).json({ error: "Please provide a project idea" });
    return;
  }

  if (state.status === "building") {
    res.status(409).json({ error: "A build is already in progress" });
    return;
  }

  resetState(idea.trim());
  void runBuild(idea.trim());
  res.json({ ok: true, message: "Build started" });
});

router.get("/status", (_req, res) => {
  res.json({
    status: state.status,
    logs: state.logs,
    result: state.result,
    error: state.error,
    idea: state.idea,
  });
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

  const projectId = state.result.projectId;
  if (!projectId) {
    res.status(400).json({ error: "No active deployment found. Build a project first." });
    return;
  }

  const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, "");

  try {
    const addRes = await fetch(
      `https://api.vercel.com/v9/projects/${projectId}/domains`,
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
      `https://api.vercel.com/v9/projects/${projectId}/domains/${cleanDomain}`,
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
      projectId,
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

  const projectId = state.result.projectId;
  if (!projectId) {
    res.status(400).json({ error: "No active deployment found" });
    return;
  }

  try {
    const checkRes = await fetch(
      `https://api.vercel.com/v9/projects/${projectId}/domains/${domain}`,
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
