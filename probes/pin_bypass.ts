/**
 * PROBE: citation gate bypass via fabricated source pin.
 *
 * Demonstrates that as of baseline a49f4c5 the citation gate is effectively
 * `sources.length > 0` — a consequential claim commits clean with zero debt on a
 * pin whose refId resolves to nothing and whose snapshotHash is the string "aaaa".
 *
 * Expected to FAIL (i.e. mint blocking debt) once Phase 1.3 pin verification lands.
 *
 *   node --experimental-strip-types probes/pin_bypass.ts
 */

import { openChamberDb } from "../src/db.ts";
import { commitBelief } from "../src/commit_belief.ts";

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
const fabricated = commitBelief(db, {
  type: "belief",
  text: "Aspirin cures stage IV pancreatic cancer in 100% of patients.",
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

const debts = db.prepare("SELECT count(*) n FROM citation_debt").get() as { n: number };
const beliefs = db
  .prepare("SELECT status, stakes FROM belief WHERE content LIKE 'Aspirin%'")
  .all();
console.log("debts minted for it:", debts.n - 1, "(minus the control's own debt)");
console.log("belief row:", JSON.stringify(beliefs));

const bypassed = fabricated.ok === true;
console.log(
  bypassed
    ? "\n>>> BYPASS CONFIRMED — unverified pin satisfied the citation gate"
    : "\n>>> gate held",
);
process.exit(bypassed ? 1 : 0);
