/**
 * DEMO 4: a sandbox that cannot confine, refuses
 *
 * Demos are not probes. `probes/` use an inverted exit code (1 means the defect
 * is still present); these use the ordinary one — 0 means the scenario played
 * out as described. They run in CI so the transcripts cannot drift away from
 * what the tool actually does.
 *
 *   node --experimental-strip-types demos/04_nothing_runs_unisolated.ts
 */

import { runInSandbox, detectSandboxBackend } from "../src/sandbox.ts";

process.env.CHAMBER_SANDBOX_REQUIRED = "1";
let failed = false;

console.log("Chamber runs model-authored code only inside a sandbox it has");
console.log("proven confines. The interesting case is when it cannot.\n");

console.log(`  detected backend: ${detectSandboxBackend()}`);
console.log("  CHAMBER_SANDBOX_REQUIRED=1\n");

console.log("$ chamber tool-run <model-authored source>");
const r = runInSandbox({
  runtime: "node",
  source: `console.log("payload ran")`,
  timeoutMs: 10_000,
});

if (r.ok) {
  console.log("  the payload RAN, and the isolation probe confirmed confinement");
  console.log("  (this machine has a working bubblewrap)");
} else {
  console.log(`  refused: ${r.error}`);
  console.log(`  reported backend: ${r.backend} — nothing ran\n`);
  console.log("  Note what did NOT happen: it did not fall back to running the");
  console.log("  code unisolated. A backend detected on PATH is not evidence it");
  console.log("  confines anything, so Chamber probes it and refuses on failure.");
}

if (r.ok && !r.stdout.includes("payload ran")) {
  console.log("\n  reported success without output — that is a bug, not a demo.");
  failed = true;
}
process.exit(failed ? 1 : 0);
