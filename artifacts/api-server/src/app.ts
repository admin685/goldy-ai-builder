import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes/index.js";

let __appdir: string;
try {
  __appdir = typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
} catch {
  __appdir = process.cwd();
}

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicDir = path.join(__appdir, "..", "public");
const serve = (name: string) => path.join(publicDir, name);

// Static assets — served first so images/css/js are never blocked by route handlers
// index: false prevents express.static from auto-serving index.html at /, which
// would shadow the explicit landing.html mapping below and redirect unauthenticated
// users to /login.
app.use(express.static(publicDir, { index: false }));

// API routes
app.use("/api", router);

// Public HTML pages
const pages: [string[], string][] = [
  [["", "/", "/api", "/api/"], "landing.html"],
  [["/app", "/app/", "/api/app", "/api/app/"], "index.html"],
  [["/login", "/login/", "/api/login", "/api/login/"], "login.html"],
  [["/register", "/register/", "/api/register", "/api/register/"], "register.html"],
  [["/dashboard", "/dashboard/", "/api/dashboard", "/api/dashboard/"], "dashboard.html"],
  [["/admin", "/admin/", "/api/admin", "/api/admin/"], "admin.html"],
  [["/editor", "/editor/", "/api/editor", "/api/editor/"], "editor.html"],
];

for (const [paths, file] of pages) {
  for (const p of paths) {
    app.get(p === "" ? "/" : p, (_req, res) => res.sendFile(serve(file)));
  }
}

export default app;
