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
import { sha256, stableStringify } from "./hash.ts";
import {
  defaultCheckpointPath,
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

function readEntries(path: string): AnchorEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AnchorEntry);
}

export function appendAnchor(
  path: string,
  receipt: SignedCheckpointReceipt,
  now: () => Date = () => new Date(),
): AnchorEntry {
  const existing = readEntries(path);
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
  const entries = readEntries(path);
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
  return readEntries(path).at(-1) ?? null;
}
