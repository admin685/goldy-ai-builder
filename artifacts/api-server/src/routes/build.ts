import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";

const router: IRouter = Router();

interface BuildLog {
  ts: number;
  msg: string;
  type: "info" | "success" | "error" | "warn";
}

interface BuildState {
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

const state: BuildState = {
  status: "idle",
  logs: [],
  result: {},
};

function log(msg: string, type: BuildLog["type"] = "info") {
  state.logs.push({ ts: Date.now(), msg, type });
  console.log(`[Goldy] [${type.toUpperCase()}] ${msg}`);
}

function resetState(idea: string) {
  state.status = "building";
  state.logs = [];
  state.result = {};
  state.error = undefined;
  state.idea = idea;
  log("Build started — Goldy is thinking...", "info");
}

// ── Task 2: Updated Claude prompt for static HTML output ──────────────────

async function callClaude(idea: string): Promise<Record<string, unknown>> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ apiKey });

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

  log("Calling Claude to generate your project code...", "info");

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 12000,
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

async function getGitHubUsername(token: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `token ${token}`,
      "User-Agent": "Goldy-Builder/1.0",
    },
  });
  const data = (await res.json()) as { login: string };
  return data.login;
}

async function createGitHubRepo(
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
      auto_init: false,
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

async function pushFilesToGitHub(
  repoName: string,
  files: Record<string, string>
): Promise<void> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is not set");

  const username = await getGitHubUsername(token);
  log(`Pushing ${Object.keys(files).length} files to GitHub...`, "info");

  for (const [filePath, content] of Object.entries(files)) {
    const putRes = await fetch(
      `https://api.github.com/repos/${username}/${repoName}/contents/${filePath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Goldy-Builder/1.0",
        },
        body: JSON.stringify({
          message: `Add ${filePath}`,
          content: Buffer.from(content).toString("base64"),
        }),
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

async function deployToVercel(
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
    const spec = await callClaude(idea);
    const projectName = (spec["project_name"] as string) || "my-project";
    const description = (spec["description"] as string) || "Built by Goldy AI";
    const files = (spec["files"] as Record<string, string>) || {};
    const features = (spec["features"] as string[]) || [];

    log(`Project: "${projectName}"`, "success");
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
