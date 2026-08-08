/**
 * Anchor log — the checkpoint history, kept outside the database.
 *
 * A single receipt is one file to rewrite. This is an append-only JSONL log
 * where each entry carries the hash of the one before it, so what an attacker
 * has to forge is the *history* of roots rather than one number, and it has to
 * be forged somewhere the database cannot reach.
 *
 * Be clear about the ceiling. This does not make tampering impossible: whoever
 * can rewrite the database can usually rewrite a file next to it, and a log
 * rewritten consistently from the first line still verifies. What it buys is
 * that a rollback now has to be committed in two places at once, and that any
 * inconsistency between them is loud. Real external anchoring — a timestamping
 * service, a signed commit pushed to a remote, a copy on separate media — is
 * the step beyond this, and this log is what you would feed to it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256, stableStringify } from "./hash.ts";
import {
  defaultCheckpointPath,
  exportCheckpoint,
  compareCheckpoints,
  verifyCheckpointPrefix,
  type CheckpointReceipt,
  type SignedCheckpointReceipt,
} from "./checkpoint_export.ts";

export interface AnchorEntry {
  seq: number;
  anchoredAt: string;
  receipt: SignedCheckpointReceipt;
  prevAnchorHash: string | null;
  anchorHash: string;
}

/** Beside the checkpoint, since they are two halves of one record. */
export function defaultAnchorPath(): string {
  return join(dirname(defaultCheckpointPath()), "anchors.jsonl");
}

function anchorHashOf(entry: Omit<AnchorEntry, "anchorHash">): string {
  return sha256(stableStringify(entry));
}

/**
 * Read the log, keeping malformed lines as a reported fault rather than a throw.
 *
 * An unguarded `JSON.parse` per line made the tamper-evidence check disarmable
 * by appending garbage: one junk line and `verify` died with a stack trace
 * instead of reporting, after it had already printed that the chain looked
 * consistent. A check that can be turned into a crash is a check an attacker
 * controls. `appendFileSync` is not atomic either, so a crash or a full disk
 * produces the same half-written line without anyone being hostile.
 */
function readEntries(path: string): {
  entries: AnchorEntry[];
  malformed: number[];
} {
  if (!existsSync(path)) return { entries: [], malformed: [] };
  const entries: AnchorEntry[] = [];
  const malformed: number[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as AnchorEntry);
    } catch {
      malformed.push(i + 1);
    }
  }
  return { entries, malformed };
}

export function appendAnchor(
  path: string,
  receipt: SignedCheckpointReceipt,
  now: () => Date = () => new Date(),
): AnchorEntry {
  // Refuse to append over damage. Chaining from the last *valid* line left the
  // malformed one in place forever, so `verifyAnchorLog` reported the log
  // damaged on every later run and `verifyAgainstAnchors` returned early without
  // comparing anything — one interrupted write permanently disarmed the
  // tamper-evidence, with no path back. Failing here keeps the damage visible
  // and repairable instead of burying it under new entries.
  const { entries: existing, malformed } = readEntries(path);
  if (malformed.length > 0) {
    throw new Error(
      `anchor log ${path} has malformed line(s) ${malformed.join(", ")}; ` +
        `refusing to append over them — inspect and repair the log first`,
    );
  }
  const prev = existing.at(-1) ?? null;
  const body: Omit<AnchorEntry, "anchorHash"> = {
    seq: (prev?.seq ?? 0) + 1,
    anchoredAt: now().toISOString(),
    receipt,
    prevAnchorHash: prev?.anchorHash ?? null,
  };
  const entry: AnchorEntry = { ...body, anchorHash: anchorHashOf(body) };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/**
 * Recompute every entry's hash and check that each names the one before it.
 * Catches an edit anywhere in the log, and any reordering.
 */
export function verifyAnchorLog(path: string): {
  ok: boolean;
  entries: number;
  reason?: string;
} {
  const { entries, malformed } = readEntries(path);
  if (malformed.length > 0) {
    return {
      ok: false,
      entries: entries.length,
      reason: `line(s) ${malformed.join(", ")} are not valid JSON — the log is damaged or was appended to by something else`,
    };
  }
  let prevHash: string | null = null;
  for (const [i, entry] of entries.entries()) {
    const { anchorHash, ...body } = entry;
    if (anchorHashOf(body) !== anchorHash) {
      return {
        ok: false,
        entries: entries.length,
        reason: `anchor ${i + 1} (seq ${entry.seq}) was edited: contents do not match its hash`,
      };
    }
    if (entry.prevAnchorHash !== prevHash) {
      return {
        ok: false,
        entries: entries.length,
        reason: `anchor ${i + 1} (seq ${entry.seq}) does not link the entry before it`,
      };
    }
    prevHash = anchorHash;
  }
  return { ok: true, entries: entries.length };
}

/** The most recent anchor, or null when nothing has been anchored yet. */
export function latestAnchor(path: string): AnchorEntry | null {
  return readEntries(path).entries.at(-1) ?? null;
}

/**
 * Judge the current chain against **every** anchor, not merely the newest.
 *
 * Reading only the tail hands the attacker the comparison: truncate the chain,
 * run `chamber checkpoint` once, and the newest anchor is their own description
 * of the shortened chain — correctly hash-linked, so the log still verifies. The
 * whole point of keeping the history is that an *earlier* attestation, made
 * before the rollback, can still contradict it. The oldest disagreement is the
 * one worth reporting, so this walks forward and returns the first.
 */
/**
 * Write the checkpoint and its anchor, or neither.
 *
 * The two are halves of one record, and they were written in the order that
 * makes a partial failure worst: `exportCheckpoint` put the receipt on disk, then
 * `appendAnchor` refused a damaged log and threw. The checkpoint advanced while
 * the anchor log stayed frozen, every later scheduled run failed the same way,
 * and `verifyAgainstAnchors` had no anchor matching the current receipt even
 * once the damage was repaired.
 *
 * Checking the log first costs one read and keeps the two artefacts in step: if
 * the anchor cannot be appended, no receipt is written and the operator still has
 * the pair they had before.
 */
export function exportCheckpointGuarded(
  db: DatabaseSync,
  outPath: string,
  anchorPath: string = defaultAnchorPath(),
): { receipt: SignedCheckpointReceipt; anchor: AnchorEntry } {
  // Gate on exactly what `appendAnchor` refuses — a malformed line — and
  // nothing more.
  //
  // Gating on the full chain check was stricter than the thing it guards, and
  // strictly worse: one edited byte inside a *valid* JSON entry made
  // verifyAnchorLog fail, so every subsequent checkpoint threw before writing
  // anything. That converts the attestation mechanism from "detects the tamper"
  // into "stops attesting", with no repair command, which is a denial of
  // service an attacker can trigger with a single write. A hash mismatch is
  // exactly what `checkpoint verify` exists to report; it must not also stop
  // the record advancing.
  const { malformed } = readEntries(anchorPath);
  if (malformed.length > 0) {
    throw new Error(
      `anchor log ${anchorPath} has malformed line(s) ${malformed.join(", ")}; ` +
        `refusing to write a checkpoint that could not be anchored — repair the ` +
        `log first. A tampered-but-parseable log does not stop this: that is ` +
        `reported by \`chamber checkpoint verify\`.`,
    );
  }
  const receipt = exportCheckpoint(db, outPath);
  const anchor = appendAnchor(anchorPath, receipt);
  return { receipt, anchor };
}

export function verifyAgainstAnchors(
  path: string,
  current: CheckpointReceipt,
  db?: DatabaseSync,
): { ok: boolean; reason?: string; anchors: number; failedAt?: number } {
  const log = verifyAnchorLog(path);
  if (!log.ok) {
    return { ok: false, reason: log.reason, anchors: log.entries };
  }
  const { entries } = readEntries(path);
  for (const entry of entries) {
    // Both checks, per anchor. `compareCheckpoints` reads two receipts and
    // therefore cannot see a truncation that was followed by fresh writes — the
    // chain is longer, so every length test passes. Only re-deriving the
    // attested root from the tree catches that, and it has to run against the
    // *older* anchors: an attacker who truncates and re-runs `checkpoint`
    // overwrites the receipt file and appends a correctly-linked anchor of
    // their own, so the newest attestation is theirs. The honest one is behind
    // it in this log.
    const verdict = db
      ? (() => {
          const c = compareCheckpoints(entry.receipt, current);
          if (!c.ok) return c;
          return verifyCheckpointPrefix(db, entry.receipt);
        })()
      : compareCheckpoints(entry.receipt, current);
    if (!verdict.ok) {
      return {
        ok: false,
        reason: `anchor seq ${entry.seq} (${entry.anchoredAt}): ${verdict.reason}`,
        anchors: entries.length,
        failedAt: entry.seq,
      };
    }
  }
  return { ok: true, anchors: entries.length };
}
