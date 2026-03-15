import app from "./app.js";
import { initDb } from "./lib/init-db.js";
import { seedAdmin } from "./lib/seed-admin.js";
import { startWeeklyJob } from "./lib/weeklyJob.js";

const rawPort = process.env["PORT"] || "8080";

const port = parseInt(rawPort, 10);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main() {
  try {
    await initDb();
  } catch (err) {
    console.error("DATABASE CONNECTION ERROR:", err);
    process.exit(1);
  }

  try {
    await seedAdmin();
  } catch (err) {
    console.error("SEED ADMIN ERROR:", err);
  }

  app.listen(port, "0.0.0.0", () => {
    console.log(`Server listening on 0.0.0.0:${port}`);
    void startWeeklyJob();
  });
}

void main();
