/**
 * PROBE: citation debt blocks verbatim repetition only — a paraphrase escapes.
 *
 * The debt gate's blocking condition is keyed on `claim_hash`, and
 * `claimHash(type, text)` is sha256 over the exact claim text after whitespace
 * normalisation (src/hash.ts:4-7; consumed at src/commit_belief.ts:85-97 and
 * :185). Two sentences asserting the same fact in different words are two
 * different hashes. So an assertion that is blocked from being re-committed
 * word-for-word commits freely the moment it is reworded — and language models
 * reword by default. Debt prevents *repetition*; it does not prevent
 * *reliance* on the same unsupported claim.
 *
 * This probe demonstrates the boundary mechanically:
 *
 *   1. An unsourced assertion commits and mints blocking debt (control: the
 *      gate works as documented).
 *   2. The identical sentence is then REJECTED by its own open debt (control:
 *      the block is real).
 *   3. A paraphrase of the same claim — same fact, different words — commits
 *      `ok: true` while that debt is still open (the escape).
 *
 * A probe cannot prove semantic equivalence; what it proves is the mechanism's
 * key. Any two strings that a reader would judge to assert the same thing and
 * that hash differently behave exactly as legs 2 and 3 below. `--strict`
 * (requireVerifiedSupport) refuses the paraphrase too — but it refuses every
 * unsourced assertion, original included, so it is not a paraphrase defence;
 * on the default path the block does not propagate.
 *
 * Exits non-zero while the escape exists.
 *
 *   node --experimental-strip-types probes/debt_paraphrase.ts
 */

import { openChamberDb } from "../src/db.ts";
import { commitBelief } from "../src/commit_belief.ts";
import { claimHash } from "../src/hash.ts";

const db = openChamberDb();

const ORIGINAL =
  "The refund policy allows customers to return any purchase within 30 days.";
const PARAPHRASE =
  "Customers may send back anything they bought for a full refund during the 30 days after purchase.";

// Leg 1 — control setup: the original assertion commits unsourced and mints
// blocking debt on its claim_hash.
const first = commitBelief(db, {
  type: "belief",
  text: ORIGINAL,
  sources: [],
  authorFamily: "probe",
  path: "deep",
});
console.log("original commit:", JSON.stringify(first));

const openDebt = db
  .prepare(
    `SELECT count(*) n FROM citation_debt
     WHERE claim_hash = ? AND blocking = 1 AND status IN ('pending','proposed_paid')`,
  )
  .get(claimHash("belief", ORIGINAL)) as { n: number };
console.log("open blocking debts on the original claim:", openDebt.n);

// Leg 2 — control: the verbatim repeat is blocked by its own debt. Without
// this, leg 3 would prove nothing about the block at all.
const repeat = commitBelief(db, {
  type: "belief",
  text: ORIGINAL,
  sources: [],
  authorFamily: "probe",
  path: "deep",
});
console.log("\nverbatim repeat:", JSON.stringify(repeat));

// Leg 3 — the escape: same fact, different words, while leg 1's debt is open.
const paraphrase = commitBelief(db, {
  type: "belief",
  text: PARAPHRASE,
  sources: [],
  authorFamily: "probe",
  path: "deep",
});
console.log("\nparaphrase commit:", JSON.stringify(paraphrase));

const paraphraseDebt = db
  .prepare(
    `SELECT count(*) n FROM citation_debt
     WHERE claim_hash = ? AND blocking = 1 AND status IN ('pending','proposed_paid')`,
  )
  .get(claimHash("belief", PARAPHRASE)) as { n: number };
console.log("open blocking debts on the paraphrase claim:", paraphraseDebt.n);
console.log(
  "same claim_hash for both sentences:",
  claimHash("belief", ORIGINAL) === claimHash("belief", PARAPHRASE),
);

// Escaped = the block held verbatim (leg 2 rejected) and the paraphrase
// committed anyway (leg 3 ok) while the original debt was still open.
const escaped =
  first.ok === true &&
  openDebt.n > 0 &&
  repeat.ok === false &&
  paraphrase.ok === true;

console.log(
  escaped
    ? "\n>>> ESCAPE CONFIRMED — debt blocked the verbatim sentence; its paraphrase committed freely with the original debt still open"
    : "\n>>> no escape — the debt block followed the claim across rewording",
);
process.exit(escaped ? 1 : 0);
