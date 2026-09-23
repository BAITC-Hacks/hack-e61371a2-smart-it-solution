import { createPool } from "./db.js";
import { readConfig } from "./config.js";
import {
  createReminders,
  enqueueMessengerNotifications,
  processWebhooks,
} from "./integrations.js";
import { cleanupAssistantRetention } from "./ai.js";
const pool = createPool(readConfig().databaseUrl);
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
while (!stopping) {
  try {
    await createReminders(pool);
    await cleanupAssistantRetention(pool);
    if (process.env.WORKER_DELIVERY_ENABLED === "true") {
      await enqueueMessengerNotifications(pool);
      await processWebhooks(pool);
    }
  } catch {
    console.error(
      JSON.stringify({
        event: "worker.failed",
        message: "Check migrations and integration configuration",
      }),
    );
  }
  if (stopping || process.argv.includes("--once")) break;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      process.removeListener("SIGTERM", done);
      process.removeListener("SIGINT", done);
      resolve();
    };
    const timer = setTimeout(done, 15000);
    process.once("SIGTERM", done);
    process.once("SIGINT", done);
  });
}
await pool.end();
