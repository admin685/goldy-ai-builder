import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import Anthropic from "@anthropic-ai/sdk";
import multer from "multer";
import AdmZip from "adm-zip";
import { state, log, resetState, clearIfTimedOut, createGitHubRepo, pushFilesToGitHub, deployToVercel, runDesignPipeline } from "./build.js";
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

  const zipUrl = `https://api.github.com/repos/${user}/${repo}/zipball/HEAD`;

  const authedHeaders: Record<string, string> = {
    "User-Agent": "Goldy-Builder/1.0",
    Accept: "application/vnd.github+json",
  };
  if (token) authedHeaders["Authorization"] = `token ${token}`;

  let res = await fetch(zipUrl, { headers: authedHeaders });

  // Fine-grained PATs can't access third-party public repos — retry without auth
  if (res.status === 404 && token) {
    log(`  Token rejected (404) — retrying as public repo...`, "info");
    res = await fetch(zipUrl, {
      headers: {
        "User-Agent": "Goldy-Builder/1.0",
        Accept: "application/vnd.github+json",
      },
    });
  }

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
  assets: { css: string; heroImageUrl: string; logoSvg: string },
  projectName: string
): Record<string, string> {
  // Inject Boris's CSS: prepend into style.css if it exists, otherwise inject via placeholder in index.html
  if (assets.css) {
    if (outFiles["style.css"] !== undefined) {
      outFiles["style.css"] = outFiles["style.css"].replace(/^\/\* GOLDY_CSS_INJECT \*\/\n?/, "");
      outFiles["style.css"] = assets.css + "\n\n/* --- Goldy-generated project CSS --- */\n\n" + outFiles["style.css"];
      log("  ✓ Boris's designs injected into style.css", "info");
    } else {
      for (const name of Object.keys(outFiles)) {
        if (name.endsWith(".html") && outFiles[name].includes("<!-- GOLDY_CSS -->")) {
          outFiles[name] = outFiles[name].replace("<!-- GOLDY_CSS -->", `<style>\n${assets.css}\n</style>`);
          log("  ✓ Boris's designs baked into " + name, "info");
        }
      }
    }
  }

  // Replace logo and hero placeholders in all HTML files
  for (const name of Object.keys(outFiles)) {
    if (!name.endsWith(".html")) continue;
    let html = outFiles[name];
    if (assets.logoSvg && html.includes("<!-- GOLDY_LOGO -->")) {
      const initial = projectName.charAt(0).toUpperCase() || "G";
      const fallbackStyle = "width:40px;height:40px;border-radius:50%;background:#D4AF37;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;color:#fff;font-family:sans-serif;flex-shrink:0;";
      const onerror = `this.style.display='none';var f=document.createElement('div');f.style.cssText='${fallbackStyle}';f.textContent='${initial}';this.parentNode.insertBefore(f,this.nextSibling);`;
      html = html.replace("<!-- GOLDY_LOGO -->", `<img src="${assets.logoSvg}" alt="Logo" class="navbar-logo" style="height:40px;width:auto;" onerror="${onerror}">`);
      log("  ✓ Masha's logo is mounted", "info");
    }
    if (assets.heroImageUrl && html.includes("<!-- GOLDY_HERO -->")) {
      html = html.replace("<!-- GOLDY_HERO -->", `background-image:url('${assets.heroImageUrl}');background-size:cover;background-position:center;`);
      log("  ✓ Ivan's photo is framed", "info");
    }
    outFiles[name] = html;
  }
  return outFiles;
}

async function analyzeImport(
  files: Record<string, string>,
  projectHint: string
): Promise<{ project_name: string; description: string; files_to_generate: string[] }> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const fileLines: string[] = [`Imported project: "${projectHint}"\n\nSource files to analyze:\n`];
  for (const [path, content] of Object.entries(files)) {
    fileLines.push(`\n=== ${path} ===\n${content.slice(0, 2000)}`);
  }

  log(`Goldy is reading ${Object.keys(files).length} files...`, "info");

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 600,
    system: `Analyze these source files and plan a rebuild as a clean static HTML/CSS/JS web app.
Return ONLY valid JSON — no markdown, no explanation:
{
  "project_name": "kebab-case-name",
  "description": "One sentence description of what this app does",
  "files_to_generate": ["style.css", "script.js", "index.html", "README.md"]
}
RULES: Always list style.css first, then JS files, then HTML pages, then README.md last. Max 8 files. Only .html/.css/.js/README.md — no server files.`,
    messages: [{ role: "user", content: fileLines.join("") }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Goldy could not plan the rebuild — no JSON returned");
  const parsed = JSON.parse(jsonMatch[0]) as { project_name: string; description: string; files_to_generate: string[] };
  return parsed;
}

async function generateImportFile(
  fileName: string,
  sourceFiles: Record<string, string>,
  alreadyGenerated: Record<string, string>,
  plan: { project_name: string; description: string; files_to_generate: string[] },
  assets: { css: string; heroImageUrl: string; logoSvg: string }
): Promise<string> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });

  const cssClassSummary = assets.css ? extractCssClassSummary(assets.css) : "";
  const isHtml = fileName.endsWith(".html");
  const isCss = fileName === "style.css";

  const assetInstructions = (isHtml || isCss) && (assets.css || assets.heroImageUrl || assets.logoSvg)
    ? `\nDESIGN SYSTEM (assets injected after generation):
${cssClassSummary ? `- CSS classes available: ${cssClassSummary}` : ""}
${isCss ? `- START style.css with this exact comment on line 1: /* GOLDY_CSS_INJECT */` : ""}
${isHtml && assets.logoSvg ? `- Navbar: use exactly <!-- GOLDY_LOGO --> where the logo goes` : ""}
${isHtml && assets.heroImageUrl ? `- Hero element style attribute: <!-- GOLDY_HERO -->` : ""}`
    : "";

  const sourceContext = Object.entries(sourceFiles)
    .slice(0, 8)
    .map(([p, c]) => `=== ${p} ===\n${c.slice(0, 1500)}`)
    .join("\n\n");

  const generatedContext = Object.entries(alreadyGenerated)
    .map(([p, c]) => `=== ${p} (already generated) ===\n${c.slice(0, 600)}`)
    .join("\n\n");

  const userContent = `Project: "${plan.project_name}"
Description: ${plan.description}
All files being generated: ${plan.files_to_generate.join(", ")}

Original source files (for reference):
${sourceContext}

${generatedContext ? `Already generated files (stay consistent):\n${generatedContext}\n` : ""}
Now generate ONLY the file: ${fileName}
Output raw file content — no markdown fences, no explanation.${assetInstructions}`;

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 8000,
    system: `You are a senior front-end developer rebuilding a project as a clean static HTML/CSS/JS web app.
Output ONLY the raw content of the requested file. No markdown. No backticks. No explanation. Just the file.
The app must work by opening index.html with no server. Use localStorage for data persistence.`,
    messages: [{ role: "user", content: userContent }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return text.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim();
}

async function runImport(
  files: Record<string, string>,
  projectHint: string
) {
  try {
    // Run design pipeline first based on project hint / source files summary
    const designIdea = `${projectHint}: ${Object.keys(files).slice(0, 5).join(", ")}`;
    const assets = await runDesignPipeline(designIdea, projectHint.toLowerCase().replace(/\s+/g, "-").slice(0, 30));

    // Phase 1: Analyze — plan the rebuild (file list only, no code yet)
    log("▶ Goldy is analyzing your project files...", "info");
    const plan = await analyzeImport(files, projectHint);
    const projectName = plan.project_name || "imported-project";
    const description = plan.description || "Imported and rebuilt by Goldy AI";
    const fileList = plan.files_to_generate?.length ? plan.files_to_generate : ["style.css", "index.html", "README.md"];
    log(`✓ Goldy has the plan — "${projectName}" · ${fileList.length} files to build`, "success");
    log(description, "info");

    // Phase 2: Per-file generation (each file gets full 8000 tokens)
    const generatedFiles: Record<string, string> = {};
    for (const fileName of fileList) {
      log(`  ▶ Writing ${fileName}...`, "info");
      const content = await generateImportFile(fileName, files, generatedFiles, plan, assets);
      generatedFiles[fileName] = content;
      log(`  ✓ ${fileName} ready (${content.length} chars)`, "success");
    }

    // Phase 3: Assemble — inject Boris's CSS, Masha's logo, Ivan's hero image
    log("▶ Goldy is assembling the crew's work...", "info");
    let outFiles = assembleDesignAssets(generatedFiles, assets, projectName);

    log(`✓ Project ready: "${projectName}"`, "success");

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
  clearIfTimedOut();
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
