/**
 * PROBE: flagship gates are absent from the hash-chained audit trail.
 *
 * commit_belief and try_activate_skill write only to the unchained `gate_event`
 * table. Sixteen other modules call appendAudit; these two — the ones the
 * README's invariant is about — do not.
 *
 * Expected to FAIL (audit_event > 0) once Phase 1.2 lands.
 *
 *   node --experimental-strip-types probes/gate_audit.ts
 */

import { openChamberDb } from "../src/db.ts";
import { commitBelief } from "../src/commit_belief.ts";

const db = openChamberDb();

commitBelief(db, {
  type: "belief",
  text: "A claim that should be audited.",
  sources: [],
  authorFamily: "probe",
  path: "deep",
});
commitBelief(db, {
  type: "observation",
  text: "An observation that should be audited.",
  sources: [{ kind: "transcript", refId: "probe", snapshotHash: "deadbeef" }],
  authorFamily: "probe",
  path: "fast",
});

const gate = db.prepare("SELECT count(*) n FROM gate_event").get() as { n: number };
const audit = db.prepare("SELECT count(*) n FROM audit_event").get() as { n: number };

console.log("gate_event rows :", gate.n, "(unchained, plain table)");
console.log("audit_event rows:", audit.n, "(hash-chained)");

const unchained = gate.n > 0 && audit.n === 0;
console.log(
  unchained
    ? "\n>>> CONFIRMED — gate decisions are outside the tamper-evident chain"
    : "\n>>> gates are chained",
);
process.exit(unchained ? 1 : 0);
