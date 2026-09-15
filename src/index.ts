import cron from "node-cron";
import { config } from "./config.js";
import { migrate } from "./db/index.js";
import { startServer } from "./web/server.js";
import { runAgent } from "./agent/run.js";

async function main() {
  await migrate();
  const server = startServer();

  if (config.agent.cron) {
    cron.schedule(config.agent.cron, async () => {
      if (server.isRunning()) return console.log("cron: skip, run already in progress");
      server.setRunning(true);
      try {
        await runAgent("cron");
      } catch (e) {
        console.error("cron run failed", e);
      } finally {
        server.setRunning(false);
      }
    });
    console.log(`scheduled agent runs: ${config.agent.cron}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
