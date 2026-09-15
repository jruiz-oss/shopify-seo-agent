import { migrate, pool } from "./db/index.js";
import { runAgent } from "./agent/run.js";
import { fetchAll } from "./connectors/shopify.js";

const cmd = process.argv[2];

async function main() {
  await migrate();
  if (cmd === "migrate") return console.log("migrated");
  if (cmd === "run") {
    const id = await runAgent("manual");
    return console.log(`run ${id} complete`);
  }
  if (cmd === "snapshot") {
    const r = await fetchAll();
    console.table(r.slice(0, 50).map((x) => ({ type: x.targetType, handle: x.handle, seoTitle: x.seoTitle?.slice(0, 40), seoDescLen: x.seoDescription?.length ?? 0 })));
    return console.log(`${r.length} resources`);
  }
  console.log("usage: cli.ts migrate | run | snapshot");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
