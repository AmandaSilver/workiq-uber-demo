// scripts/precompute-routes.mjs
// One-off build step: fetch real street-following driving routes for every
// in-city ride in the captured sample dataset and bake them into the JSON, so
// the offline demo draws believable routes with zero network dependency.
//
//   node scripts/precompute-routes.mjs
//
// Re-run only if you change the sample rides. Airport transfers are skipped on
// purpose (they're hidden from the planning map).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeBetweenDetailed } from "../server/services/routing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, "..", "server", "data", "captured", "uber-receipts.json");

const data = JSON.parse(await fs.readFile(FILE, "utf8"));
let done = 0;
for (const r of data.rides) {
  if (r.isAirport) { delete r.route; delete r.distanceMi; delete r.durationMin; continue; }
  process.stdout.write(`Routing ${r.id} ${r.pickup.name} -> ${r.dropoff.name} ... `);
  const detail = await routeBetweenDetailed(r.pickup, r.dropoff, 15000);
  if (detail) {
    r.route = detail.path;
    if (detail.distanceMi != null) r.distanceMi = Number(detail.distanceMi.toFixed(1));
    if (detail.durationMin != null) r.durationMin = Math.round(detail.durationMin);
    done++;
    console.log(`ok (${detail.path.length} pts, ${r.distanceMi} mi, ${r.durationMin} min)`);
  } else console.log("FAILED (will fall back to a straight line)");
}
await fs.writeFile(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`\nBaked routes for ${done}/${data.rides.filter((r) => !r.isAirport).length} in-city rides into ${path.relative(process.cwd(), FILE)}`);
