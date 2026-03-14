import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicDir = path.join(__dirname, "..", "public");
const htmlFile = path.join(publicDir, "index.html");

app.get("/api", (_req, res) => res.sendFile(htmlFile));
app.get("/api/", (_req, res) => res.sendFile(htmlFile));
app.get("/", (_req, res) => res.sendFile(htmlFile));

app.use("/api", router);

app.use(express.static(publicDir));

export default app;
