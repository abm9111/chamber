/**
 * Orphan-directory sweep for the drift backtest, with a liveness check.
 *
 * Its own module so `probes/backtest_orphan_sweep.ts` can exercise it without
 * importing `backtest_drift.ts`, whose body runs a whole backtest on import.
 *
 * ── Why a liveness check, and what it replaced ────────────────────────────
 *
 * `backtest_drift.ts` extracts a corpus into a temp directory and must remove
 * it before exiting. Aborts and signals could leave one behind, and SIGKILL is
 * uncatchable, so a sweep at the next startup is the only thing that closes
 * that window from outside the dead process.
 *
 * The first version swept every `chamber-backtest-*` directory except the
 * current run's, on the reasoning that "a survivor is by definition an
 * orphan." That reasoning is false, and the consequence was worse than the
 * leak it fixed: run two copies of the harness at once — two terminals, a
 * retry before killing the first, a CI matrix sharing a runner's /tmp — and
 * the second one's sweep deletes the FIRST one's corpus and database while it
 * is being read and written. Reproduced during review with two real
 * processes: the sibling aborted mid-ingest with its self-test collapsing from
 * 100% to 0%. It was loud there only by luck. A sweep landing after the
 * self-test has passed would instead let the run finish and report confident,
 * silently wrong recall and precision — which is the exact failure this whole
 * harness exists to detect.
 *
 * So a directory is swept only when its owner is demonstrably gone:
 *
 *   - `.pid` readable and that process is alive  → SKIP, a live sibling
 *   - `.pid` readable and that process is dead   → SWEEP, a killed run
 *   - `.pid` missing or unreadable               → SWEEP only once the
 *                                                  directory is older than
 *                                                  STALE_MS
 *
 * The last case covers a run killed in the window between `mkdtemp` and the
 * marker write. It is deliberately slow: leaving an orphan for an hour is a
 * bounded, passive failure, and deleting a live run's state is not.
 */

import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DIR_PREFIX = "chamber-backtest-";
/** How old an unmarked directory must be before it counts as abandoned. */
export const STALE_MS = 60 * 60 * 1000;
const PID_FILE = ".pid";

/** Claim a working directory for this process, so a sibling's sweep spares it. */
export function markLive(dir: string, pid: number = process.pid): void {
  writeFileSync(join(dir, PID_FILE), `${pid}\n`, "utf8");
}

/**
 * Is `pid` a process that currently exists?
 *
 * `kill(pid, 0)` sends no signal and only tests reachability. ESRCH means gone;
 * EPERM means it exists but belongs to someone else — alive either way, and
 * treated as alive, because the cost of a false "alive" is one skipped orphan
 * and the cost of a false "dead" is destroying a live run.
 */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type SweepDecision = "swept" | "live" | "too-recent" | "failed";

/**
 * Decide one candidate. Exported so the probe can assert the DECISION rather
 * than only its filesystem effect — a sweep that skipped for the wrong reason
 * would otherwise look identical to one that skipped for the right one.
 */
export function classifyCandidate(dir: string, now: number): SweepDecision {
  let pidRaw: string | null;
  try {
    pidRaw = readFileSync(join(dir, PID_FILE), "utf8");
  } catch {
    pidRaw = null;
  }
  if (pidRaw !== null) {
    const pid = Number.parseInt(pidRaw.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      return processIsAlive(pid) ? "live" : "swept";
    }
  }
  // No usable marker: fall back to age, and fail SAFE when the age cannot be
  // read at all.
  try {
    return now - statSync(dir).mtimeMs > STALE_MS ? "swept" : "too-recent";
  } catch {
    return "failed";
  }
}

export interface SweepResult {
  swept: number;
  live: number;
  tooRecent: number;
  failed: number;
}

/**
 * Remove abandoned working directories under `base`, never touching `self`.
 */
export function sweepOrphans(base: string, self: string, now: number = Date.now()): SweepResult {
  const out: SweepResult = { swept: 0, live: 0, tooRecent: 0, failed: 0 };
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
    // Directories only. A symlink named with the prefix is not one of ours;
    // rmSync's lstat-based recursion would unlink the link rather than follow
    // it, but refusing outright means this loop never has to be reasoned about
    // in terms of what rmSync does with a link.
    let isDir: boolean;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      out.failed++;
      continue;
    }
    if (!isDir) continue;
    const decision = classifyCandidate(dir, now);
    if (decision === "live") { out.live++; continue; }
    if (decision === "too-recent") { out.tooRecent++; continue; }
    if (decision === "failed") { out.failed++; continue; }
    try {
      rmSync(dir, { recursive: true, force: true });
      out.swept++;
    } catch {
      out.failed++;
    }
  }
  return out;
}
