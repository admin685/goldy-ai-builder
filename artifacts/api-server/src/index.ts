import app from "./app.js";
import { initDb } from "./lib/init-db.js";
import { seedAdmin } from "./lib/seed-admin.js";
import { startWeeklyJob } from "./lib/weeklyJob.js";

const rawPort = process.env["PORT"] || "80";

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main() {
  await initDb();
  await seedAdmin();
  app.listen(port, "0.0.0.0", () => {
    console.log(`Server listening on 0.0.0.0:${port}`);
    void startWeeklyJob();
  });
}

void main();
