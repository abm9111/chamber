/**
 * PROBE: citation gate bypass via fabricated source pin.
 *
 * Demonstrates that as of baseline a49f4c5 the citation gate is effectively
 * `sources.length > 0` — a consequential claim commits clean with zero debt on a
 * pin whose refId resolves to nothing and whose snapshotHash is the string "aaaa".
 *
 * Exits non-zero while the bypass exists. Closed by 806237e.
 *
 *   node --experimental-strip-types probes/pin_bypass.ts
 *
 * The bypass criterion used to be `fabricated.ok === true`. That was a correct
 * proxy only at baseline, where the fabricated claim committed with no debt at
 * all: an *uncited* assertion also returns ok — the control below does exactly
 * that — because Chamber records an unsupported claim rather than refusing it,
 * and blocks it with debt instead. So once the gate started treating a
 * fabricated pin the way it treats no citation, `ok === true` stopped
 * separating the two, and the probe reported BYPASS CONFIRMED against a closed
 * gate while printing "debts minted for it: 1" one line above.
 *
 * The criterion is now the sentence in the docstring — committed *clean*, i.e.
 * with no blocking debt on its own claim_hash — read off the claim rather than
 * inferred from a total. This is not an inversion: the probe still fails on
 * every state the original one failed on, including a gate that returns ok
 * with zero debt, and it now also fails if support is written from a pin the
 * corpus cannot confirm.
 */

import { openChamberDb } from "../src/db.ts";
import { commitBelief } from "../src/commit_belief.ts";
import { claimHash } from "../src/hash.ts";

const db = openChamberDb();

// Control: an assertion with no sources correctly mints blocking debt.
const noSource = commitBelief(db, {
  type: "belief",
  text: "The moon is made of cheese.",
  sources: [],
  authorFamily: "probe",
  path: "deep",
});
console.log("no-source belief:", JSON.stringify(noSource));

const repeat = commitBelief(db, {
  type: "belief",
  text: "The moon is made of cheese.",
  sources: [],
  authorFamily: "probe",
  path: "deep",
});
console.log("repeat (should be blocked by its own debt):", JSON.stringify(repeat));

// The bypass: one entirely fabricated pin, consequential stakes.
const fabricatedText = "Aspirin cures stage IV pancreatic cancer in 100% of patients.";
const fabricated = commitBelief(db, {
  type: "belief",
  text: fabricatedText,
  sources: [
    {
      kind: "url",
      refId: "https://example.invalid/does-not-exist",
      snapshotHash: "aaaa",
    },
  ],
  authorFamily: "probe",
  path: "deep",
  stakes: "consequential",
});
console.log("\nfabricated pin, consequential stakes:", JSON.stringify(fabricated));

const ownDebts = db
  .prepare(
    `SELECT count(*) n FROM citation_debt
     WHERE claim_hash = ? AND blocking = 1 AND status IN ('pending','proposed_paid')`,
  )
  .get(claimHash("belief", fabricatedText)) as { n: number };
const support = db
  .prepare(
    `SELECT count(*) n FROM belief_source WHERE belief_id = ?`,
  )
  .get(fabricated.beliefId ?? "") as { n: number };
const beliefs = db
  .prepare("SELECT status, stakes FROM belief WHERE content LIKE 'Aspirin%'")
  .all();
console.log("open blocking debts on its claim:", ownDebts.n);
console.log("support rows written from the fabricated pin:", support.n);
console.log("belief row:", JSON.stringify(beliefs));

// Bypassed = the claim got through without paying for it: it committed and
// carries no blocking debt, or an unconfirmable pin was recorded as support.
const bypassed =
  (fabricated.ok === true && ownDebts.n === 0) || support.n > 0;
console.log(
  bypassed
    ? "\n>>> BYPASS CONFIRMED — unverified pin satisfied the citation gate"
    : "\n>>> gate held — fabricated pin bought nothing: no support, blocking debt open",
);
process.exit(bypassed ? 1 : 0);
