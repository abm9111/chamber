/**
 * PROBE: `chamber verify` exits 0 when a belief loses SOME of its evidence.
 *
 * The verify command's exit status — the one machine-readable signal the
 * scheduled launchd job produces — is driven by this counter
 * (src/cli.ts:1220-1267):
 *
 *     broken += b.verified === 0 ? 1 : 0;
 *     ...
 *     if (broken > 0) process.exitCode = 1;
 *
 * A belief is counted only when it has lost ALL verified support. A belief
 * that loses two of its three pins prints two `hash_mismatch` lines and still
 * yields exit 0. Anything monitoring the job by exit status — which
 * docs/KNOWN_LIMITATIONS.md entry 13 identifies as the realistic consumer —
 * sees a clean run while a stored conclusion is hanging by one of its three
 * original passages. "Evidence moved or vanished" is reported in prose;
 * "some evidence remains" is treated as success.
 *
 * This probe builds the minimal case end to end:
 *
 *   1. Three real vault passages are ingested and a belief commits against
 *      all three pins — every pin verifies at commit time.
 *   2. Two of the three passages are then edited underneath the belief
 *      (simulating re-ingest after the source notes changed).
 *   3. verifyBeliefSources reports 1/3 verified with 2 hash_mismatch failures.
 *   4. The CLI's own exit-code computation, reproduced verbatim, returns 0.
 *
 * Exits non-zero while partial evidence loss produces a clean exit status.
 *
 *   node --experimental-strip-types probes/verify_partial_drift.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openChamberDb } from "../src/db.ts";
import { upsertDocument, LOCAL_HASH_MODEL } from "../src/vector.ts";
import { commitBelief } from "../src/commit_belief.ts";
import { verifyBeliefSources } from "../src/pins.ts";

// File-backed, not `:memory:`, because step 4 runs the real CLI as a
// subprocess against this database. An in-memory database cannot be handed to
// another process, and reproducing the CLI's arithmetic in here instead is the
// thing this probe was originally wrong about — see the note at step 4.
const DB_PATH = join(mkdtempSync(join(tmpdir(), "chamber-partial-")), "p.sqlite");
const db = openChamberDb(DB_PATH);

// Step 1 — three real passages, one belief pinned to all three.
const docs = ["alpha", "beta", "gamma"].map((name, i) => {
  const body = `Passage ${name}: line ${name} shipped ${100 + i} units in Q3.`;
  const { id } = upsertDocument(db, {
    sourceKind: "vault_page",
    sourceRef: `ops.md#p${i}`,
    title: `Ops › ${name}`,
    body,
    model: LOCAL_HASH_MODEL,
  });
  const row = db
    .prepare(`SELECT snapshot_hash FROM vector_document WHERE id = ?`)
    .get(id) as { snapshot_hash: string };
  return { id, body, snapshotHash: row.snapshot_hash };
});

const belief = commitBelief(db, {
  type: "belief",
  text: "All three product lines hit their Q3 shipping numbers.",
  sources: docs.map((d) => ({
    kind: "vault_page",
    refId: d.id,
    snapshotHash: d.snapshotHash,
  })),
  authorFamily: "probe",
  path: "deep",
});
console.log("commit:", JSON.stringify(belief));

const supportRows = db
  .prepare(`SELECT count(*) n FROM belief_source WHERE belief_id = ?`)
  .get(belief.ok ? belief.beliefId : "") as { n: number };
console.log("belief_source rows written:", supportRows.n);

// Step 2 — two of the three passages change underneath the belief.
for (const d of docs.slice(0, 2)) {
  db.prepare(`UPDATE vector_document SET body = ? WHERE id = ?`).run(
    `${d.body} (revised in Q4 planning)`,
    d.id,
  );
}
console.log("\nedited 2 of 3 pinned passages; re-running verification");

// Step 3 — what `chamber verify` would print for this belief.
const report = verifyBeliefSources(db, {});
const entry = report.find((r) => belief.ok && r.beliefId === belief.beliefId);
console.log("\ndrift report entry:", JSON.stringify(entry, null, 2));

// Step 4 — run the real `chamber verify` and read its real exit code.
//
// This step originally *copied* the CLI's arithmetic into the probe, with a
// comment claiming that made it "measure the same thing the cron job emits."
// It did not. A copy does not track the original: the moment src/cli.ts was
// fixed, the probe went on asserting the defect from its stale duplicate, and
// would equally have gone on passing had the CLI regressed underneath it.
//
// That is the same failure this probe exists to catch, one level up — a check
// reporting on a system it is not actually reading. So it now spawns the CLI
// the scheduled job spawns, against the same database, and takes the exit
// status from the process rather than from a reimplementation of it.
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const run = spawnSync(
  process.execPath,
  ["--experimental-strip-types", CLI, "verify"],
  { encoding: "utf8", env: { ...process.env, CHAMBER_DB: DB_PATH }, timeout: 60_000 },
);
const cliExitCode = run.status;
console.log(`\n${(run.stdout ?? "").trim()}`);
console.log(`\nchamber verify exit code: ${cliExitCode}`);

const partialLossSilent =
  belief.ok === true &&
  supportRows.n === 3 &&
  entry !== undefined &&
  entry.total === 3 &&
  entry.verified === 1 &&
  entry.failures.length === 2 &&
  cliExitCode === 0;

console.log(
  partialLossSilent
    ? "\n>>> CONFIRMED — a belief that lost 2 of its 3 pins produces exit 0: partial evidence loss is invisible to exit-status monitoring"
    : "\n>>> not reproduced — partial evidence loss now affects the exit status",
);
process.exit(partialLossSilent ? 1 : 0);
