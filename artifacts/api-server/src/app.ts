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
const htmlFile = path.join(publicDir, "index.html");

// API routes first — before any HTML or static serving
app.use("/api", router);

// HTML serving after API routes so they never shadow an API path
app.get("/api", (_req, res) => res.sendFile(htmlFile));
app.get("/api/", (_req, res) => res.sendFile(htmlFile));
app.get("/", (_req, res) => res.redirect("/api"));

app.use(express.static(publicDir));

export default app;
