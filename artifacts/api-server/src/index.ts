import app from "./app.js";
import { seedAdmin } from "./lib/seed-admin.js";
import { startWeeklyJob } from "./lib/weeklyJob.js";

const rawPort = process.env["PORT"] || "80";

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, "0.0.0.0", async () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
  await seedAdmin();
  await startWeeklyJob();
});
