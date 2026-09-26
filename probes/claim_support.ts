/**
 * PROBE: a fabricated claim with a real citation comes back [ALLOWED].
 *
 * The pin gate proves a cited passage exists and is unchanged. It said nothing
 * about whether the passage contains what the claim says — so a model could
 * cite a real passage for a sentence the passage never says, and the claim
 * committed as verified evidence. Reproduced live on 2026-09-26 against the
 * vault: "Kingroon filament is manufactured on the Moon and costs $900 per kg
 * [1]" returned ALLOWED over a real filament note.
 *
 * Three legs, so a green result means something:
 *
 *   1. Control: a faithful claim citing the passage is ALLOWED. Without this,
 *      a check that refused every citation would pass legs 2 and 3.
 *   2. Escape: a fabricated claim (name, number and place absent from the
 *      passage) citing the same passage must NOT be ALLOWED.
 *   3. Escape, observation shape: a verbless fabricated line (classified as an
 *      observation, not an assertion) must not be ALLOWED either — the two
 *      kinds take different branches in enforceClaimContract.
 *   4. Escape, reply path: the same fabrication through enforceReplyContract
 *      with a real pin — the path behind turn, the server and the bots.
 *
 * What this cannot show: a fabrication made only of words the passage
 * already contains ("the policy forbids returns") still passes. The check is
 * on specifics — numbers, names, domains — and that limit is stated in
 * docs/KNOWN_LIMITATIONS.md §2.
 *
 * Exits non-zero while the escape exists.
 *
 *   node --experimental-strip-types probes/claim_support.ts
 */

import { openChamberDb } from "../src/db.ts";
import { upsertDocument } from "../src/vector.ts";
import { runAsk } from "../src/ask.ts";
import { enforceReplyContract } from "../src/contract.ts";
import { verifyPin } from "../src/pins.ts";

const db = openChamberDb();
upsertDocument(db, {
  sourceKind: "vault_page",
  sourceRef: "notes/filament.md",
  title: "Filament",
  body: "Kingroon PLA sells for about $9 per kg on AliExpress and ships to Dubai.",
  model: "local-hash-v1",
});

const answer = [
  "Kingroon PLA sells for about $9 per kg on AliExpress. [1]",
  "Kingroon filament is manufactured on the Moon and costs $900 per kg. [1]",
  "Kingroon PLA: shipped from Mars by Tesla. [1]",
].join("\n");

const r = await runAsk(db, "Kingroon filament price", {
  complete: async () => answer,
  model: "local-hash-v1",
});
for (const c of r.claims) {
  console.log(`[${c.status}] ${c.kind} | ${c.text}`);
  for (const rj of c.rejected) console.log(`   rejected ${rj.refId}: ${rj.reason}`);
}

// Leg 4: the reply path. enforceReplyContract is what turn, the server and the
// Discord / Slack / gateway runners call, and it accepts sources. The check
// once ran only inside runAsk, so a caller passing sources here certified the
// same fabrication. Checked with real pins over the same passage.
const doc = r.passages[0]!;
const snapshotHash = verifyPin(db, { kind: "vault_page", refId: doc.documentId, snapshotHash: "" })
  .actualHash!;
const reply = enforceReplyContract(
  db,
  "Kingroon filament is manufactured on the Moon and costs $900 per kg.",
  { sources: [{ kind: "vault_page", refId: doc.documentId, snapshotHash }] },
);
console.log(`[${reply.results[0]!.status}] reply path | ${reply.claims[0]!.text}`);

const [faithful, fabricated, verbless] = r.claims;
const controlHeld = faithful?.status === "ALLOWED";
const escaped =
  fabricated?.status === "ALLOWED" ||
  verbless?.status === "ALLOWED" ||
  reply.results[0]!.status === "ALLOWED";

if (!controlHeld) {
  console.log("\n>>> CONTROL FAILED — a faithful cited claim was not ALLOWED; this run proves nothing");
  process.exit(1);
}
console.log(
  escaped
    ? "\n>>> ESCAPE CONFIRMED — a claim whose specifics are absent from its cited passage came back ALLOWED"
    : "\n>>> no escape — claims whose specifics the passage does not contain were not certified",
);
process.exit(escaped ? 1 : 0);
