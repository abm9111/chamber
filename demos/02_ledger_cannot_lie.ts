/**
 * DEMO 2: the ledger cannot quietly lose its tail
 *
 * Demos are not probes. `probes/` use an inverted exit code (1 means the defect
 * is still present); these use the ordinary one — 0 means the scenario played
 * out as described. They run in CI so the transcripts cannot drift away from
 * what the tool actually does.
 *
 *   node --experimental-strip-types demos/02_ledger_cannot_lie.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openChamberDb } from "../src/db.ts";
import { appendAudit } from "../src/audit.ts";
import { buildCheckpointReceipt } from "../src/checkpoint_export.ts";
import { appendAnchor, verifyAgainstAnchors } from "../src/anchor.ts";

const work = mkdtempSync(join(tmpdir(), "chamber-demo2-"));
const log = join(work, "anchors.jsonl");
let failed = false;

try {
  console.log("An audit chain that only checks itself will agree with itself.");
  console.log("So Chamber keeps an anchor outside the database.\n");

  const honest = openChamberDb(":memory:");
  for (let i = 0; i < 6; i++) {
    appendAudit(honest, { category: "system", action: `event_${i}`, actor: "demo" });
  }
  const anchored = appendAnchor(log, buildCheckpointReceipt(honest));
  console.log(`$ chamber checkpoint`);
  console.log(`  anchored seq ${anchored.seq} — 6 events attested\n`);

  // A rollback that takes its witnesses with it: a fresh database with fewer
  // events. Every internal check agrees, because every internal witness is gone.
  const rolledBack = openChamberDb(":memory:");
  for (let i = 0; i < 3; i++) {
    appendAudit(rolledBack, { category: "system", action: `event_${i}`, actor: "demo" });
  }
  for (let i = 0; i < 5; i++) {
    appendAudit(rolledBack, { category: "system", action: `cover_${i}`, actor: "demo" });
  }
  const now = buildCheckpointReceipt(rolledBack);
  console.log("Someone rolls the chain back to 3 events, then writes 5 more.");
  console.log("The database is now LONGER than it was, and internally consistent:");
  console.log(`  audit.ok = ${now.audit.ok}  (it verifies against itself)\n`);

  console.log("$ chamber checkpoint verify");
  const verdict = verifyAgainstAnchors(log, now, rolledBack);
  console.log(`  ${verdict.ok ? "consistent" : verdict.reason}\n`);

  if (verdict.ok) {
    console.log("The rollback went unnoticed — that is a bug, not a demo.");
    failed = true;
  } else {
    console.log("Caught. Not by the database, which was happy, but by an");
    console.log("attestation made before the rollback and kept outside it.");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
