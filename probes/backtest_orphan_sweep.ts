/**
 * PROBE: the backtest's orphan sweep deletes a running sibling's work.
 *
 * `scripts/backtest_drift.ts` extracts a private corpus into a temp directory.
 * SIGKILL cannot be caught and its body is fully synchronous, so a killed run
 * can leave that directory behind — and the only thing that can remove it is a
 * sweep by the NEXT run. The sweep is therefore mandatory, and it is an
 * `rmSync(recursive, force)` loop over a shared, unauthenticated namespace
 * (`os.tmpdir()`) selected by name prefix. That is the most dangerous code in
 * the tool.
 *
 * Its first version swept every matching directory but its own, reasoning that
 * "a survivor is by definition an orphan." It is not. Two copies of the
 * harness at once — two terminals, a retry before killing the first, a CI
 * matrix sharing a runner's /tmp — and the second one's sweep deleted the
 * first one's corpus and database mid-run. Found by review with two real
 * processes; the victim aborted with its self-test collapsing 100% → 0%. It
 * was loud there only by luck: a sweep landing after the self-test has already
 * passed would let the run finish and report confident, silently wrong recall
 * and precision, which is precisely the failure this harness exists to detect.
 *
 * So the sweep now requires proof the owner is gone, and this probe holds it
 * to that. Nothing in `npm test` covers this file at all, and the class has
 * now recurred five times in it, so the check belongs where it can fail.
 *
 * Four planted candidates, one assertion each:
 *
 *   live      — marked with THIS process's pid. Must survive. This is the
 *               regression that matters; everything else is a supporting case.
 *   dead      — marked with a pid that is not running. Must be swept, or the
 *               sweep does not do its job and the leak stays open.
 *   unmarked  — no marker, fresh. Must survive: a run killed between mkdtemp
 *               and the marker write is indistinguishable from a run that is
 *               about to write one, and waiting an hour beats deleting live
 *               state.
 *   stale     — no marker, mtime backdated past the threshold. Must be swept.
 *
 * Exits non-zero if a live sibling is destroyed, or if a genuine orphan
 * survives.
 *
 *   node --experimental-strip-types probes/backtest_orphan_sweep.ts
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIR_PREFIX,
  STALE_MS,
  markLive,
  processIsAlive,
  sweepOrphans,
} from "../scripts/backtest_sweep.ts";

const base = mkdtempSync(join(tmpdir(), "chamber-sweeptest-"));
const failures: string[] = [];

/** A pid that is not running. Search downward from an implausible value. */
function deadPid(): number {
  for (let p = 60000; p > 30000; p -= 7) {
    if (!processIsAlive(p)) return p;
  }
  throw new Error("probe setup: could not find a dead pid");
}

function plant(name: string, body: (dir: string) => void): string {
  const dir = join(base, `${DIR_PREFIX}${name}`);
  mkdirSync(dir, { recursive: true });
  // Every planted directory carries content, so a wrong sweep destroys
  // something recognisable rather than an empty shell.
  writeFileSync(join(dir, "corpus-stand-in.md"), `planted for ${name}\n`, "utf8");
  body(dir);
  return dir;
}

try {
  const live = plant("live", (d) => markLive(d, process.pid));
  const dead = plant("dead", (d) => markLive(d, deadPid()));
  const unmarked = plant("unmarked", () => {});
  const stale = plant("stale", (d) => {
    const old = (Date.now() - STALE_MS * 2) / 1000;
    utimesSync(d, old, old);
  });
  // The caller's own directory, which must be skipped by identity.
  const self = plant("self", (d) => markLive(d, deadPid()));

  const result = sweepOrphans(base, self, Date.now());
  console.log("sweep result:", JSON.stringify(result));

  const check = (label: string, dir: string, shouldSurvive: boolean): void => {
    const survived = existsSync(dir);
    console.log(`  ${label.padEnd(9)} ${survived ? "survived" : "swept   "} (expected ${shouldSurvive ? "survive" : "swept"})`);
    if (survived !== shouldSurvive) {
      failures.push(
        shouldSurvive
          ? `${label}: DESTROYED work that must be preserved`
          : `${label}: an abandoned directory survived the sweep`,
      );
    }
  };

  check("live", live, true);
  check("dead", dead, false);
  check("unmarked", unmarked, true);
  check("stale", stale, false);
  check("self", self, true);

  console.log(
    failures.length > 0
      ? `\n>>> SWEEP IS UNSAFE\n${failures.map((f) => `    - ${f}`).join("\n")}`
      : "\n>>> sweep spares live and just-started runs, removes abandoned ones",
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(failures.length > 0 ? 1 : 0);
