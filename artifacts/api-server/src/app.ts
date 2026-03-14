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
const landingFile = path.join(publicDir, "landing.html");
const appFile     = path.join(publicDir, "index.html");

// API routes first — before any HTML serving
app.use("/api", router);

// Landing page at root (and at /api for Replit preview pane compatibility)
app.get("/",     (_req, res) => res.sendFile(landingFile));
app.get("/api",  (_req, res) => res.sendFile(landingFile));
app.get("/api/", (_req, res) => res.sendFile(landingFile));

// Builder app at /app (and /api/app for Replit proxy)
app.get("/app",      (_req, res) => res.sendFile(appFile));
app.get("/app/",     (_req, res) => res.sendFile(appFile));
app.get("/api/app",  (_req, res) => res.sendFile(appFile));
app.get("/api/app/", (_req, res) => res.sendFile(appFile));

// Static assets (CSS, images, etc.)
app.use(express.static(publicDir));

export default app;
