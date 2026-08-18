/**
 * PROBE: `chamber verify`'s exit status treats a moved passage as drift, or
 * treats a real break as a move.
 *
 * The relocation rescue (src/pins.ts, findMovedWithinFile) exists because the
 * pin formula contains `source_ref` — `path#pN` — so inserting a section at
 * the top of a note re-slots every passage below it and every pin on that note
 * fires `hash_mismatch` against byte-identical text. A vault backtest measured
 * nine such false alarms from a single edit.
 *
 * The fix's whole contract is a claim about the exit code, and the exit code is
 * produced by src/cli.ts, not by the function the unit tests call:
 *
 *     if (vr.broken + vr.degraded > 0) process.exitCode = 1;
 *
 * `relocatedPins` is simply absent from that sum. That is the entire mechanism
 * — there is no code asserting it, so nothing stops a future edit from adding
 * relocations to the tally (making every top-of-note edit fail CI again) or,
 * far worse, from routing a genuine `hash_mismatch` through the rescue and
 * dropping a real break out of it.
 *
 * A unit test cannot cover this. tests/harness.ts calls buildVerifyReport in
 * process; the property under test belongs to the CLI's wiring, and the
 * consumer is unattended (the composite GitHub Action and the scheduled job
 * read the process's status and nothing else). probes/verify_partial_drift.ts
 * learned this the expensive way — it once copied the CLI's arithmetic into
 * itself, went on asserting a defect from a stale duplicate after the CLI was
 * fixed, and would have gone on passing had the CLI regressed. So this probe
 * spawns the real binary, twice, against real databases:
 *
 *   A. Relocation only — a note grows a section at the top; every pinned
 *      passage is intact one slot lower. Must exit 0 and say so.
 *   B. Relocation + a genuine break — the same shift, plus one belief whose
 *      cited passage was actually edited. Must exit 1.
 *
 * B is the half that matters. A rescue that swallowed real drift would still
 * pass A.
 *
 * Exits non-zero if either contract is violated.
 *
 *   node --experimental-strip-types probes/verify_relocation_exit.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openChamberDb } from "../src/db.ts";
import { upsertDocument, LOCAL_HASH_MODEL } from "../src/vector.ts";
import { commitBelief } from "../src/commit_belief.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const ROOT = "/vaults/probe";

/** Write a passage exactly as `chamber ingest` does — with its ingest root. */
function put(
  db: ReturnType<typeof openChamberDb>,
  ref: string,
  title: string,
  body: string,
): { id: string; snapshotHash: string } {
  const { id } = upsertDocument(db, {
    sourceKind: "vault_page",
    sourceRef: ref,
    title,
    body,
    metadata: { ingestRoot: ROOT },
    model: LOCAL_HASH_MODEL,
  });
  const row = db
    .prepare(`SELECT snapshot_hash FROM vector_document WHERE id = ?`)
    .get(id) as { snapshot_hash: string };
  return { id, snapshotHash: row.snapshot_hash };
}

function runVerify(dbPath: string): { code: number | null; out: string } {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "verify"],
    { encoding: "utf8", env: { ...process.env, CHAMBER_DB: dbPath }, timeout: 60_000 },
  );
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function freshPath(tag: string): string {
  return join(mkdtempSync(join(tmpdir(), `chamber-reloc-${tag}-`)), "p.sqlite");
}

// ── Scenario A: a pure relocation must not fail the run ──────────────────────
const pathA = freshPath("a");
{
  const db = openChamberDb(pathA);
  const pinned = put(db, "board.md#p0", "Board › Now", "the decision of record");
  const committed = commitBelief(db, {
    type: "inference",
    text: "the board note records this decision",
    sources: [{ kind: "vault_page", refId: pinned.id, snapshotHash: pinned.snapshotHash }],
    authorFamily: "probe",
    path: "fast",
    requireVerifiedSupport: true,
  });
  if (!committed.ok) {
    console.error("probe setup failed: commit refused", JSON.stringify(committed));
    process.exit(1);
  }
  // A section is inserted at the top; the pinned passage shifts down intact.
  put(db, "board.md#p0", "Board › New", "a section inserted above everything");
  put(db, "board.md#p1", "Board › Now", "the decision of record");
}
const a = runVerify(pathA);

// ── Scenario B: the same shift, plus one genuinely edited passage ────────────
const pathB = freshPath("b");
{
  const db = openChamberDb(pathB);
  const moved = put(db, "board.md#p0", "Board › Now", "the decision of record");
  const edited = put(db, "policy.md#p0", "Policy › Retention", "records are kept seven years");
  for (const [text, src] of [
    ["the board note records this decision", moved],
    ["policy keeps records seven years", edited],
  ] as const) {
    const r = commitBelief(db, {
      type: "inference",
      text,
      sources: [{ kind: "vault_page", refId: src.id, snapshotHash: src.snapshotHash }],
      authorFamily: "probe",
      path: "fast",
      requireVerifiedSupport: true,
    });
    if (!r.ok) {
      console.error("probe setup failed: commit refused", JSON.stringify(r));
      process.exit(1);
    }
  }
  put(db, "board.md#p0", "Board › New", "a section inserted above everything");
  put(db, "board.md#p1", "Board › Now", "the decision of record");
  // Real drift: the cited text itself changes, with no copy left anywhere.
  //
  // policy.md deliberately keeps a SIBLING passage. Without one, the rescue
  // has no candidate to examine and the scenario passes even with the hash
  // comparison removed — which is exactly what an early version of this probe
  // did, reporting a held contract while the equality check was gutted. The
  // sibling means a rescue that stopped comparing content would grab it,
  // report the edited pin as moved, and drop the exit code to 0.
  put(db, "policy.md#p0", "Policy › Retention", "records are kept three years");
  put(db, "policy.md#p1", "Policy › Scope", "this policy covers all accounts");
}
const b = runVerify(pathB);

console.log("── scenario A: relocation only ──");
console.log(a.out.trim());
console.log(`exit: ${a.code}`);
console.log("\n── scenario B: relocation + genuine drift ──");
console.log(b.out.trim());
console.log(`exit: ${b.code}`);

const aSaysMoved = /new position in the same file/.test(a.out);
const failures: string[] = [];
if (a.code !== 0) {
  failures.push(`A: a moved-but-intact passage failed the run (exit ${a.code}); every top-of-note edit would break CI`);
}
if (!aSaysMoved) {
  failures.push("A: the run said nothing about the relocation; a silent rescue is indistinguishable from no check");
}
if (b.code !== 1) {
  failures.push(`B: real drift alongside a relocation did NOT fail the run (exit ${b.code}) — the rescue is swallowing genuine evidence loss`);
}

console.log(
  failures.length > 0
    ? `\n>>> BROKEN CONTRACT\n${failures.map((f) => `    - ${f}`).join("\n")}`
    : "\n>>> relocation exit contract holds: moves do not fail the run, real drift still does",
);
process.exit(failures.length > 0 ? 1 : 0);
