// Plain-node test runner — zero dependencies.
// Runs every *.test.mjs in this directory; *.live.mjs suites (need live
// services like the Python sidecar) run only with RUN_LIVE=1.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const live = process.env.RUN_LIVE === "1";
const suites = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs") || (live && f.endsWith(".live.mjs")))
  .sort();

let failed = 0;
for (const suite of suites) {
  console.log(`\n== ${suite} ==`);
  const r = spawnSync(process.execPath, [path.join(here, suite)], {
    stdio: "inherit",
    cwd: path.join(here, ".."),
  });
  if (r.status !== 0) failed++;
}

console.log(`\n${suites.length} suite(s), ${failed} failed${live ? "" : " (live suites skipped — set RUN_LIVE=1)"}`);
process.exit(failed ? 1 : 0);
