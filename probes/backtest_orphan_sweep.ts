/**
 * PROBE: the drift backtest deletes a directory it did not create.
 *
 * `scripts/backtest_drift.ts` extracts a private corpus into a temp directory
 * under `os.tmpdir()` — a shared, unauthenticated namespace. Twice it tried to
 * tidy up directories left by killed runs, and both attempts were worse than
 * the leak they addressed:
 *
 *   1. Remove every `chamber-backtest-*` directory but this run's. Two
 *      concurrent runs are ordinary use, so the second deleted the first's
 *      corpus and database mid-flight. Reproduced with two real processes.
 *   2. Gate that on a `.pid` marker and `kill(pid, 0)`. Pid numbers are
 *      namespace-local, so in a containerized CI matrix sharing a temp dir — the
 *      topology that fix was written for — a live sibling reads as dead and is
 *      destroyed, while a dead container's pid 1 reads as alive and its
 *      directory becomes permanent. Proved with two real containers.
 *
 * The destructive path is now gone rather than guarded, and this probe holds
 * the line at the property that matters: **this tool removes only what it made.**
 * It is deliberately not a test of the tidy-up logic, because there is no
 * longer any tidy-up logic to test — it is a test that none has come back.
 *
 * Two checks:
 *   - the reporting module exports no removal capability, and does not remove a
 *     planted directory it is pointed at;
 *   - a real end-to-end run over a temp dir seeded with a decoy leaves the decoy
 *     untouched, while removing its own working directory.
 *
 * The second matters most: the first can be satisfied by a module that never
 * deletes while the CALLER does. Only running the real binary settles that.
 *
 *   node --experimental-strip-types probes/backtest_orphan_sweep.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sweepModule from "../scripts/backtest_sweep.ts";
import { DIR_PREFIX, findOrphans } from "../scripts/backtest_sweep.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures: string[] = [];

// ── 1. the module reports and does not remove ────────────────────────────────
{
  const base = mkdtempSync(join(tmpdir(), "chamber-orphanprobe-"));
  const decoy = join(base, `${DIR_PREFIX}decoy`);
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, "corpus-stand-in.md"), "planted\n", "utf8");
  const self = join(base, `${DIR_PREFIX}self`);
  mkdirSync(self, { recursive: true });

  const report = findOrphans(base, self);
  console.log("findOrphans:", JSON.stringify(report));

  if (!report.paths.includes(decoy)) {
    failures.push("findOrphans did not report a planted directory — the report is not a report");
  }
  if (report.paths.includes(self)) {
    failures.push("findOrphans reported the caller's own directory");
  }
  if (!existsSync(decoy)) {
    failures.push("findOrphans REMOVED a directory it was only asked to find");
  }
  // The capability itself must be absent, not merely unused: a module with no
  // removal export cannot grow one by accident in a later edit.
  const exported = Object.keys(sweepModule);
  const removers = exported.filter((k) => /sweep|clean|remove|purge|delete|rm/i.test(k));
  if (removers.length > 0) {
    failures.push(`backtest_sweep.ts exports removal-shaped API again: ${removers.join(", ")}`);
  }
  console.log("exports:", exported.join(", "));
  rmSync(base, { recursive: true, force: true });
}

// ── 2. a real run leaves a stranger's directory alone ────────────────────────
{
  const fakeTmp = mkdtempSync(join(tmpdir(), "chamber-orphanprobe-tmp-"));
  const decoy = join(fakeTmp, `${DIR_PREFIX}someone-elses-live-run`);
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, "corpus-stand-in.md"), "another run's extracted content\n", "utf8");

  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(ROOT, "scripts", "backtest_drift.ts"),
      "--repo", ROOT,
      "--from", "HEAD",
      "--to", "HEAD",
      "--pins", "5",
      "--acknowledge-full-history",
    ],
    {
      encoding: "utf8",
      // TMPDIR steers os.tmpdir(), so the run's own directory and the decoy
      // share one namespace — the situation two concurrent runs are actually in.
      env: { ...process.env, TMPDIR: fakeTmp, CHAMBER_EMBEDDER: "hash" },
      timeout: 300_000,
    },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(`\nreal run exit: ${r.status}`);

  if (!existsSync(decoy) || !existsSync(join(decoy, "corpus-stand-in.md"))) {
    failures.push("a real run DESTROYED another run's working directory — the defect this probe exists for");
  }
  if (!/working director/i.test(out)) {
    failures.push("a real run did not mention the directory it found — silence is not a report");
  }
  // Its own directory must still be cleaned up: the point is to delete less,
  // not to stop deleting.
  const leftovers = readdirSync(fakeTmp).filter(
    (n) => n.startsWith(DIR_PREFIX) && n !== "chamber-backtest-someone-elses-live-run",
  );
  if (leftovers.length > 0) {
    failures.push(`a completed run left its own working directory behind: ${leftovers.join(", ")}`);
  }
  rmSync(fakeTmp, { recursive: true, force: true });
}

console.log(
  failures.length > 0
    ? `\n>>> BROKEN\n${failures.map((f) => `    - ${f}`).join("\n")}`
    : "\n>>> the backtest removes only what it created, and names what it does not",
);
process.exit(failures.length > 0 ? 1 : 0);
