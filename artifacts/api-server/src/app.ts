import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicDir = path.join(__dirname, "..", "public");
const serve = (name: string) => path.join(publicDir, name);

// API routes first — before any HTML serving
app.use("/api", router);

// Public HTML pages
const pages: [string[], string][] = [
  [["", "/", "/api", "/api/"], "landing.html"],
  [["/app", "/app/", "/api/app", "/api/app/"], "index.html"],
  [["/login", "/login/", "/api/login", "/api/login/"], "login.html"],
  [["/register", "/register/", "/api/register", "/api/register/"], "register.html"],
  [["/dashboard", "/dashboard/", "/api/dashboard", "/api/dashboard/"], "dashboard.html"],
  [["/admin", "/admin/", "/api/admin", "/api/admin/"], "admin.html"],
];

for (const [paths, file] of pages) {
  for (const p of paths) {
    app.get(p === "" ? "/" : p, (_req, res) => res.sendFile(serve(file)));
  }
}

// Static assets
app.use(express.static(publicDir));

export default app;
