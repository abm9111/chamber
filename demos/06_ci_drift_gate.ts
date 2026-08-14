/**
 * DEMO 6: a doc claim pinned to code, failing CI when the code moves
 *
 * Demos are not probes. `probes/` use an inverted exit code (1 means the
 * defect is still present); these use the ordinary one — 0 means the scenario
 * played out as described. They run in CI so the transcripts cannot drift
 * away from what the tool actually does.
 *
 * The scenario is the CI drift gate: documentation asserts something about
 * the code ("the late fee is five percent"), the assertion is committed as a
 * belief whose pinned source is the code passage itself, and `chamber verify`
 * exits non-zero the moment the code stops backing the claim. No model is
 * involved at any step — the check is hash comparison.
 *
 *   node --experimental-strip-types demos/06_ci_drift_gate.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openChamberDb } from "../src/db.ts";
import { indexCodeTree } from "../src/code_index.ts";
import { commitBelief } from "../src/commit_belief.ts";
import { buildVerifyReport } from "../src/pins.ts";

const work = mkdtempSync(join(tmpdir(), "chamber-demo6-"));
let failed = false;

try {
  console.log("A repo whose docs make a claim about its code:\n");

  mkdirSync(join(work, "src"), { recursive: true });
  const feesPath = join(work, "src", "fees.ts");
  writeFileSync(
    feesPath,
    "export function lateFeePercent(): number {\n" +
      "  // Contractual: five percent after the grace period.\n" +
      "  return 5;\n" +
      "}\n",
  );

  const db = openChamberDb(":memory:");
  indexCodeTree(db, work);

  const row = db
    .prepare(
      `SELECT id, snapshot_hash AS snapshotHash FROM vector_document
        WHERE source_ref LIKE '%fees.ts%' LIMIT 1`,
    )
    .get() as { id: string; snapshotHash: string } | undefined;
  if (!row) throw new Error("code indexing produced no row for fees.ts");

  console.log("$ chamber index-code .");
  console.log(`  fees.ts indexed as a citable passage (${row.id})\n`);

  const commit = commitBelief(db, {
    type: "belief",
    text: "The late fee is five percent, per src/fees.ts.",
    sources: [
      { kind: "vault_page", refId: row.id, snapshotHash: row.snapshotHash },
    ],
    authorFamily: "demo",
    path: "deep",
  });
  if (!commit.ok) throw new Error(`doc claim did not commit: ${JSON.stringify(commit)}`);
  console.log('$ chamber believe belief "The late fee is five percent, per src/fees.ts."');
  console.log(`  committed ${commit.beliefId} — pinned to the code passage\n`);

  const clean = buildVerifyReport(db);
  console.log("$ chamber verify        # in CI: the gate step");
  console.log(
    `  ${clean.checked} belief(s) checked, ${clean.broken} broken, ${clean.degraded} degraded — exit 0, build passes\n`,
  );
  if (clean.broken + clean.degraded !== 0) {
    failed = true;
    console.log("  !! expected a clean run before the edit");
  }

  console.log("A PR changes the fee without touching the docs:\n");
  writeFileSync(
    feesPath,
    "export function lateFeePercent(): number {\n" +
      "  // Bumped for Q4.\n" +
      "  return 15;\n" +
      "}\n",
  );
  indexCodeTree(db, work);
  console.log("$ git diff --stat && chamber index-code .");
  console.log("  src/fees.ts | 2 +-\n");

  const drifted = buildVerifyReport(db);
  const bad = drifted.beliefs.find((b) => b.failures.length > 0);
  console.log("$ chamber verify        # same CI step, after the PR");
  if (!bad || drifted.broken + drifted.degraded === 0) {
    failed = true;
    console.log("  !! the gate did not notice the code moved under the claim");
  } else {
    for (const f of bad.failures) {
      console.log(`  ${f.reason}: ${f.refId}`);
    }
    console.log(
      `  ${drifted.checked} belief(s) checked, ${drifted.broken} broken, ${drifted.degraded} degraded — exit 1, build FAILS`,
    );
    console.log(
      "\nThe doc claim did not change. The code under it did, and the build",
    );
    console.log(
      "goes red until someone re-checks the claim — `chamber verify --json`",
    );
    console.log("gives the CI step the same finding as a parseable object.");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
