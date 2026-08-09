/**
 * DEMO 3: an unsourced claim cannot be quietly repeated
 *
 * Demos are not probes. `probes/` use an inverted exit code (1 means the defect
 * is still present); these use the ordinary one — 0 means the scenario played
 * out as described. They run in CI so the transcripts cannot drift away from
 * what the tool actually does.
 *
 *   node --experimental-strip-types demos/03_debt_blocks_repetition.ts
 */

import { openChamberDb } from "../src/db.ts";
import { commitBelief } from "../src/commit_belief.ts";
import { listOpenDebts, waiveDebt } from "../src/debt.ts";

const db = openChamberDb(":memory:");
const CLAIM = "Every production deploy is reviewed by a second engineer.";
let failed = false;

console.log("Chamber lets you assert without evidence — once, and on the record.\n");

console.log(`$ chamber believe belief "${CLAIM}"`);
const first = commitBelief(db, {
  type: "belief", text: CLAIM, sources: [], authorFamily: "demo", path: "deep",
});
console.log(`  ${first.ok ? `committed ${first.beliefId}` : "unexpectedly refused"}`);
console.log("  no source was given, so the claim now owes one\n");

console.log("$ chamber debts");
const debt = listOpenDebts(db)[0];
console.log(`  ${debt?.id}  [${debt?.status}]\n`);

console.log("Assert the same thing again while that debt is open:");
console.log(`$ chamber believe belief "${CLAIM}"`);
const repeat = commitBelief(db, {
  type: "belief", text: CLAIM, sources: [], authorFamily: "demo", path: "deep",
});
console.log(`  ${repeat.ok ? "ALLOWED — the gate did not hold" : `REJECTED — ${repeat.reason}`}\n`);
if (repeat.ok) failed = true;

console.log("Debt is not a trap. When the corpus genuinely cannot support a");
console.log("claim, an operator settles it on the record instead:");
console.log(`$ chamber waive-debt ${debt?.id} "no source exists; asserted on judgement"`);
waiveDebt(db, debt!.id, "no source exists; asserted on judgement");
const after = commitBelief(db, {
  type: "belief", text: CLAIM, sources: [], authorFamily: "demo", path: "deep",
});
console.log(`  ${after.ok ? "committed" : "still blocked"} — a waive is an admission, not a payment\n`);
if (!after.ok) failed = true;

console.log("Note the honest limit: this is the exact-claim block, which is");
console.log("reliable. Chamber also compares rewordings, but that leg is a weak");
console.log("heuristic — see docs/KNOWN_LIMITATIONS.md for its measurement.");
process.exit(failed ? 1 : 0);
