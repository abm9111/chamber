/**
 * Report — never remove — working directories left behind by earlier backtests.
 *
 * ── Why this reports instead of acting ────────────────────────────────────
 *
 * `backtest_drift.ts` extracts a corpus into a temp directory and removes it on
 * every route it controls. SIGKILL is uncatchable and its body is synchronous,
 * so a killed run can still leave one behind, holding extracted content.
 *
 * Two attempts were made to clean that up automatically, and both were worse
 * than the leak:
 *
 *   1. Remove every `chamber-backtest-*` directory but this run's, on the
 *      reasoning that "a survivor is by definition an orphan." It is not — two
 *      concurrent runs are ordinary use, and the second run's sweep deleted the
 *      first's corpus and database mid-flight. Reproduced with two real
 *      processes.
 *   2. Gate that on liveness via a `.pid` marker and `kill(pid, 0)`. Pid numbers
 *      are namespace-local, so this is structurally wrong in exactly the
 *      topology the fix was written for — a CI matrix sharing a runner's temp
 *      dir. Proved with two real containers: a process genuinely alive in one
 *      reads as dead from another (so its live corpus is destroyed), and a dead
 *      container's pid 1 reads as alive (so its directory becomes immortal and
 *      the staleness fallback never applies).
 *
 * The second fix was more elaborate than the first and failed in both
 * directions at once. That is the argument against a third: no in-process check
 * can establish that a directory in a shared, unauthenticated namespace belongs
 * to a process that is gone. `rmSync(recursive, force)` over such a namespace is
 * the most dangerous thing this tool could do, and it is being done to tidy a
 * temp directory.
 *
 * So the destructive path is removed rather than guarded. What remains cannot
 * delete anything it did not create: it lists candidates and lets the operator
 * decide, which is the same choice `findGonePinnedFiles` makes in src/pins.ts —
 * report the finding, leave the action to someone who knows the context.
 *
 * The residual failure is bounded and passive: after a `kill -9`, one temp
 * directory survives until a human or the OS removes it, and the next run says
 * so by name.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const DIR_PREFIX = "chamber-backtest-";

export interface OrphanReport {
  /** Directories matching this tool's naming that this run does not own. */
  paths: string[];
  /** Candidates that could not be inspected. Reported, never assumed empty. */
  unreadable: number;
}

/**
 * Find, and only find. There is deliberately no removal path in this module —
 * a future edit that adds one has to add it here, where the history above is.
 */
export function findOrphans(base: string, self: string): OrphanReport {
  const out: OrphanReport = { paths: [], unreadable: 0 };
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const dir = join(base, name);
    if (dir === self) continue;
    try {
      // Directories only: a symlink or file wearing the prefix is not one of
      // ours, and naming it would send an operator to delete the wrong thing.
      if (statSync(dir).isDirectory()) out.paths.push(dir);
    } catch {
      out.unreadable++;
    }
  }
  out.paths.sort();
  return out;
}
