import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import Anthropic from "@anthropic-ai/sdk";
import multer from "multer";
import AdmZip from "adm-zip";
import { state, log, resetState, createGitHubRepo, pushFilesToGitHub, deployToVercel, runDesignPipeline } from "./build.js";
import { requireAuth } from "../middlewares/auth.js";
import { saveProject } from "../lib/projects.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const SKIP_DIRS = [
  "node_modules/", ".git/", "dist/", ".next/", "__pycache__/",
  "venv/", ".venv/", "build/", ".cache/", ".vercel/", "coverage/",
];

const SKIP_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".bin", ".dll", ".so", ".dylib",
  ".zip", ".gz", ".tar", ".rar", ".7z",
  ".pdf", ".docx", ".xlsx",
  ".mp3", ".mp4", ".wav", ".ogg", ".avi", ".mov",
  ".pyc", ".pyo",
];

const MAX_FILE_SIZE = 100 * 1024;
const MAX_FILE_COUNT = 60;

function shouldSkipEntry(entryName: string): boolean {
  const lower = entryName.toLowerCase();
  for (const dir of SKIP_DIRS) {
    if (lower.includes(dir)) return true;
  }
  for (const ext of SKIP_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function extractFilesFromZip(buffer: Buffer): Record<string, string> {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const files: Record<string, string> = {};
  let count = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (count >= MAX_FILE_COUNT) break;

    const name = entry.entryName;
    if (shouldSkipEntry(name)) continue;

    const fileSize = entry.header.size;
    if (fileSize > MAX_FILE_SIZE) continue;

    try {
      const content = entry.getData().toString("utf8");
      if (content.includes("\0")) continue;

      const cleanName = name.includes("/")
        ? name.slice(name.indexOf("/") + 1)
        : name;

      if (!cleanName) continue;

      files[cleanName] = content;
      count++;
    } catch {
      // Skip unreadable files
    }
  }

  return files;
}

async function fetchGitHubZip(url: string): Promise<Buffer> {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error("Invalid GitHub URL — expected https://github.com/user/repo");

  const user = match[1];
  const repo = match[2].replace(/\.git$/, "");
  const token = process.env["GITHUB_TOKEN"];

  log(`▶ Petya is fetching files from ${user}/${repo}...`, "info");

  const headers: Record<string, string> = {
    "User-Agent": "Goldy-Builder/1.0",
    Accept: "application/vnd.github+json",
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const res = await fetch(
    `https://api.github.com/repos/${user}/${repo}/zipball/HEAD`,
    { headers }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub fetch failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

async function fetchReplitZip(url: string): Promise<Buffer> {
  const match = url.match(/replit\.com\/@([^/]+)\/([^/?#]+)/);
  if (!match) throw new Error("Invalid Replit URL — expected https://replit.com/@user/project");

  const user = match[1];
  const project = match[2];
  const exportUrl = `https://replit.com/@${user}/${project}.zip`;

  log(`▶ Petya is grabbing files from Replit: ${user}/${project}...`, "info");

  const res = await fetch(exportUrl, {
    headers: { "User-Agent": "Goldy-Builder/1.0" },
  });

  if (!res.ok) {
    throw new Error(
      `Replit fetch failed (${res.status}). Make sure the project is public.`
    );
  }

  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

function extractCssClassSummary(css: string): string {
  const classes = css.match(/\.[\w-]+(?=[\s,{:])/g) ?? [];
  const unique = [...new Set(classes)].slice(0, 40);
  return unique.join(" ").slice(0, 300);
}

function assembleDesignAssets(
  outFiles: Record<string, string>,
  assets: { css: string; heroImageUrl: string; logoSvg: string }
): Record<string, string> {
  if (!outFiles["index.html"]) return outFiles;
  let html = outFiles["index.html"];
  if (assets.css && html.includes("<!-- GOLDY_CSS -->")) {
    html = html.replace("<!-- GOLDY_CSS -->", `<style>\n${assets.css}\n</style>`);
    log("  ✓ Boris's designs are baked in", "info");
  }
  if (assets.logoSvg && html.includes("<!-- GOLDY_LOGO -->")) {
    html = html.replace("<!-- GOLDY_LOGO -->", `<img src="${assets.logoSvg}" alt="Logo" class="navbar-logo" style="height:40px;width:auto;">`);
    log("  ✓ Masha's logo is mounted", "info");
  }
  if (assets.heroImageUrl && html.includes("<!-- GOLDY_HERO -->")) {
    html = html.replace("<!-- GOLDY_HERO -->", `background-image:url('${assets.heroImageUrl}');background-size:cover;background-position:center;`);
    log("  ✓ Ivan's photo is framed", "info");
  }
  outFiles["index.html"] = html;
  return outFiles;
}

async function callClaudeImport(
  files: Record<string, string>,
  projectHint: string,
  assets?: { css: string; heroImageUrl: string; logoSvg: string }
): Promise<Record<string, unknown>> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ apiKey });

  const hasAssets = assets && (assets.css || assets.heroImageUrl || assets.logoSvg);
  const cssClassSummary = assets?.css ? extractCssClassSummary(assets.css) : "";

  const assetInstructions = hasAssets
    ? `
DESIGN SYSTEM — pre-generated assets will be injected after you output the code. Follow these instructions exactly:
${cssClassSummary ? `1. CSS CLASS NAMES — Use these classes in your HTML (full CSS auto-injected): ${cssClassSummary}
   In index.html <head>, place the placeholder: <!-- GOLDY_CSS -->` : ""}
${assets?.logoSvg ? `2. LOGO — In the navbar, place the placeholder: <!-- GOLDY_LOGO -->` : ""}
${assets?.heroImageUrl ? `3. HERO IMAGE — On the hero element's style attribute, place the placeholder: <!-- GOLDY_HERO -->` : ""}
Do NOT write your own CSS for the design system classes — the injected CSS handles them.
`
    : "";

  const systemPrompt = `You are a senior front-end developer. You are given source files from an existing project. Your job is to:
1. Carefully analyze what the project does, its features, UI design, and functionality
2. Rebuild it as a clean, optimized STATIC HTML/CSS/JS web app — no server, no backend, no build tools required
3. Preserve ALL the original features and design intent
4. Make the code clean, modern, and Vercel-ready (just open index.html)

CRITICAL RULES:
- Output ONLY static files: HTML, CSS, JS. No Python, Node.js server code, requirements.txt, package.json server deps.
- Use vanilla JS only — no React, no frameworks, no CDN imports needed.
- Store data in localStorage where appropriate.
- Make the UI beautiful and faithful to the original design intent.
- The app must work by opening index.html in a browser with no server.
- Generate REAL, working code — not pseudocode or placeholders.
${assetInstructions}
Output format — return ONLY valid JSON, no markdown fences, no explanation:
{
  "project_name": "kebab-case-name",
  "project_type": "webapp",
  "tech_stack": "HTML/CSS/JavaScript",
  "description": "One sentence description of what this app does",
  "features": ["Feature 1", "Feature 2", "Feature 3"],
  "files": {
    "index.html": "<!DOCTYPE html>... complete rebuilt file ...",
    "README.md": "# Project Name\\n..."
  }
}`;

  const fileLines: string[] = [
    `Imported project: "${projectHint}"`,
    `\nHere are all the source files:\n`,
  ];

  for (const [path, content] of Object.entries(files)) {
    fileLines.push(`\n=== ${path} ===\n${content}`);
  }

  const userContent = fileLines.join("");

  log("▶ Goldy is reviewing your project files...", "info");
  log(`Goldy is reading ${Object.keys(files).length} files...`, "info");

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude did not return valid JSON");

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  log(`✓ Goldy renamed it: "${parsed["project_name"] as string}"`, "success");
  log(parsed["description"] as string, "info");
  return parsed;
}

async function runImport(
  files: Record<string, string>,
  projectHint: string
) {
  try {
    // Run design pipeline first based on project hint / source files summary
    const designIdea = `${projectHint}: ${Object.keys(files).slice(0, 5).join(", ")}`;
    const assets = await runDesignPipeline(designIdea, projectHint.toLowerCase().replace(/\s+/g, "-").slice(0, 30));

    const spec = await callClaudeImport(files, projectHint, assets);
    const projectName = (spec["project_name"] as string) || "imported-project";
    const description = (spec["description"] as string) || "Imported and rebuilt by Goldy AI";
    let outFiles = (spec["files"] as Record<string, string>) || {};

    // Assemble: inject GPT-4o CSS, Recraft logo, FLUX hero image via placeholder replacement
    log("▶ Goldy is assembling the crew's work...", "info");
    outFiles = assembleDesignAssets(outFiles, assets);

    log(`✓ Project ready: "${projectName}"`, "success");
    log(`${description}`, "info");

    let repoUrl = "";
    let deployUrl = "";
    let projectId = "";
    let deploymentName = "";

    if (process.env["GITHUB_TOKEN"]) {
      try {
        const ghResult = await createGitHubRepo(projectName, description);
        repoUrl = ghResult.repoUrl;
        await pushFilesToGitHub(ghResult.repoName, outFiles);
      } catch (e) {
        log(`Petya had a snag (non-fatal): ${(e as Error).message}`, "warn");
      }
    }

    if (process.env["VERCEL_TOKEN"]) {
      try {
        const vercelResult = await deployToVercel(projectName, outFiles);
        deployUrl = vercelResult.url;
        projectId = vercelResult.projectId;
        deploymentName = vercelResult.deploymentName;
      } catch (e) {
        log(`Vasya couldn't deliver: ${(e as Error).message}`, "error");
        if (!repoUrl) throw e;
        log("✓ Petya stored the files safely", "info");
      }
    } else {
      log("Vasya is off duty — no delivery key", "warn");
    }

    state.status = "done";
    state.result = {
      url: deployUrl || repoUrl || undefined,
      repoUrl: repoUrl || undefined,
      projectName,
      filesCreated: Object.keys(outFiles).length,
      projectId: projectId || undefined,
      deploymentName: deploymentName || undefined,
    };

    log(`✓ Crew rebuilt it! ${Object.keys(outFiles).length} files ready.`, "success");
    if (deployUrl) log(`✓ Vasya delivered the project — it's LIVE! ${deployUrl}`, "success");
    else if (repoUrl) log(`✓ Petya stored it at: ${repoUrl}`, "success");

    if (state.userId) {
      await saveProject({
        userId: state.userId,
        name: projectName,
        vercelUrl: deployUrl || undefined,
        githubUrl: repoUrl || undefined,
        files: outFiles,
      });
    }
  } catch (err) {
    state.status = "error";
    state.error = (err as Error).message;
    log(`Import failed: ${(err as Error).message}`, "error");
  }
}

function conditionalMulter(req: Request, res: Response, next: NextFunction) {
  if (req.is("multipart/form-data")) {
    upload.single("file")(req, res, next);
  } else {
    next();
  }
}

router.post("/import", requireAuth, conditionalMulter, (req, res) => {
  if (state.status === "building") {
    res.status(409).json({ error: "A build is already in progress" });
    return;
  }

  const file = (req as Request & { file?: Express.Multer.File }).file;
  const body = req.body as { mode?: string; url?: string };

  const mode = file ? "zip" : (body.mode || "");

  resetState(`Import & Rebuild (${mode})`, req.user?.id);

  if (mode === "zip") {
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    log("▶ Petya is unloading the ZIP package...", "info");
    let files: Record<string, string>;
    try {
      files = extractFilesFromZip(file.buffer);
    } catch (e) {
      res.status(400).json({ error: `Failed to read ZIP: ${(e as Error).message}` });
      return;
    }

    const count = Object.keys(files).length;
    if (count === 0) {
      res.status(400).json({ error: "No readable files found in ZIP" });
      return;
    }

    log(`✓ Petya unloaded ${count} files from the package`, "success");
    res.json({ ok: true, message: "Import started", filesFound: count });
    void runImport(files, file.originalname.replace(/\.zip$/, ""));

  } else if (mode === "github") {
    const url = body.url?.trim();
    if (!url || !url.includes("github.com")) {
      res.status(400).json({ error: "Provide a valid GitHub URL (https://github.com/user/repo)" });
      return;
    }

    const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    const projectHint = match ? `${match[1]}/${match[2]}` : "github-project";

    res.json({ ok: true, message: "Import started" });

    void (async () => {
      try {
        const buf = await fetchGitHubZip(url);
        const files = extractFilesFromZip(buf);
        const count = Object.keys(files).length;
        if (count === 0) throw new Error("No readable files found in the repository");
        log(`✓ Petya grabbed ${count} files from the warehouse`, "success");
        await runImport(files, projectHint);
      } catch (e) {
        state.status = "error";
        state.error = (e as Error).message;
        log(`Import failed: ${(e as Error).message}`, "error");
      }
    })();

  } else if (mode === "replit") {
    const url = body.url?.trim();
    if (!url || !url.includes("replit.com")) {
      res.status(400).json({ error: "Provide a valid Replit URL (https://replit.com/@user/project)" });
      return;
    }

    const match = url.match(/replit\.com\/@([^/]+)\/([^/?#]+)/);
    const projectHint = match ? `${match[2]}` : "replit-project";

    res.json({ ok: true, message: "Import started" });

    void (async () => {
      try {
        const buf = await fetchReplitZip(url);
        const files = extractFilesFromZip(buf);
        const count = Object.keys(files).length;
        if (count === 0) throw new Error("No readable files found in the Replit project");
        log(`✓ Petya grabbed ${count} files from Replit`, "success");
        await runImport(files, projectHint);
      } catch (e) {
        state.status = "error";
        state.error = (e as Error).message;
        log(`Import failed: ${(e as Error).message}`, "error");
      }
    })();

  } else {
    res.status(400).json({ error: "Invalid mode. Use mode=zip, mode=github, or mode=replit" });
  }
});

export default router;
