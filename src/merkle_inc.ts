/**
 * Incremental Merkle Mountain Range (peaks).
 *
 * Append cost: O(log n) — never rebuilds the full tree.
 * Live root stays fresh after every audit leaf.
 *
 * Peaks follow the binary representation of leaf_count:
 *   each set bit → one peak of that height covering 2^h leaves.
 * New leaf is always the right child when merged with an existing same-height peak.
 *
 * Inclusion: path inside the peak (from that peak's leaves only) + bag of peaks = root.
 * Algorithm: sha256_mmr_peaks_v1
 */

import type { DatabaseSync } from "node:sqlite";
import { newId, sha256 } from "./hash.ts";
import {
  buildMerkleLayers,
  proveInclusion,
  verifyInclusionProof,
} from "./merkle.ts";

export const MMR_ALG = "sha256_mmr_peaks_v1";

/** Local copy to avoid depending on merkleParent export timing in cycles */
function merkleParent(leftHex: string, rightHex: string): string {
  return sha256(leftHex + rightHex);
}

export interface MmrPeak {
  height: number;
  hash: string;
  fromSeq: number;
  toSeq: number;
}

export interface MmrAppendResult {
  leafCount: number;
  rootHash: string;
  lastSeq: number;
  peaks: MmrPeak[];
}

function bagPeaks(peakHashes: string[]): string {
  if (peakHashes.length === 0) throw new Error("mmr: empty peaks");
  let acc = peakHashes[0]!;
  for (let i = 1; i < peakHashes.length; i++) {
    acc = merkleParent(acc, peakHashes[i]!);
  }
  return acc;
}

function loadPeaks(db: DatabaseSync): MmrPeak[] {
  return (
    db
      .prepare(
        `SELECT height, hash, from_seq, to_seq FROM merkle_inc_peak ORDER BY height ASC`,
      )
      .all() as { height: number; hash: string; from_seq: number; to_seq: number }[]
  ).map((r) => ({
    height: r.height,
    hash: r.hash,
    fromSeq: r.from_seq,
    toSeq: r.to_seq,
  }));
}

function savePeaks(db: DatabaseSync, peaks: MmrPeak[]): void {
  db.prepare(`DELETE FROM merkle_inc_peak`).run();
  const ins = db.prepare(
    `INSERT INTO merkle_inc_peak (height, hash, from_seq, to_seq) VALUES (?, ?, ?, ?)`,
  );
  for (const p of peaks) {
    ins.run(p.height, p.hash, p.fromSeq, p.toSeq);
  }
}

function incrementalOn(db: DatabaseSync): boolean {
  const row = db
    .prepare(`SELECT value FROM chamber_config WHERE key = 'merkle.incremental'`)
    .get() as { value: string } | undefined;
  return (row?.value ?? "on") === "on";
}

/**
 * Absorb one audit leaf into the live MMR. O(log n).
 * Idempotent when auditSeq <= last_seq.
 */
export function appendMerkleLeaf(
  db: DatabaseSync,
  leafHash: string,
  auditSeq: number,
): MmrAppendResult | null {
  if (!incrementalOn(db)) return null;

  const state = db
    .prepare(
      `SELECT leaf_count, last_seq, root_hash FROM merkle_inc_state WHERE id = 1`,
    )
    .get() as {
    leaf_count: number;
    last_seq: number | null;
    root_hash: string | null;
  };

  if (state.last_seq != null && auditSeq <= state.last_seq) {
    return {
      leafCount: state.leaf_count,
      rootHash: state.root_hash ?? "",
      lastSeq: state.last_seq,
      peaks: loadPeaks(db),
    };
  }

  // peaksByHeight: at most one peak per height (binary-counter invariant)
  const peaksByHeight = new Map<number, MmrPeak>();
  for (const p of loadPeaks(db)) {
    peaksByHeight.set(p.height, p);
  }

  let cur: MmrPeak = {
    height: 0,
    hash: leafHash,
    fromSeq: auditSeq,
    toSeq: auditSeq,
  };

  while (peaksByHeight.has(cur.height)) {
    const left = peaksByHeight.get(cur.height)!;
    peaksByHeight.delete(cur.height);
    // Existing peak is older (left); new carry is right
    cur = {
      height: cur.height + 1,
      hash: merkleParent(left.hash, cur.hash),
      fromSeq: left.fromSeq,
      toSeq: cur.toSeq,
    };
  }
  peaksByHeight.set(cur.height, cur);

  const finalPeaks = [...peaksByHeight.values()].sort((a, b) => a.height - b.height);
  const rootHash = bagPeaks(finalPeaks.map((p) => p.hash));
  const leafCount = state.leaf_count + 1;

  savePeaks(db, finalPeaks);

  db.prepare(
    `INSERT INTO merkle_inc_path (leaf_seq, leaf_hash, path_json, peak_height, peak_hash)
     VALUES (?, ?, '[]', ?, ?)
     ON CONFLICT(leaf_seq) DO UPDATE SET
       leaf_hash = excluded.leaf_hash,
       peak_height = excluded.peak_height,
       peak_hash = excluded.peak_hash`,
  ).run(auditSeq, leafHash, cur.height, cur.hash);

  db.prepare(
    `UPDATE merkle_inc_state
     SET leaf_count = ?, root_hash = ?, last_seq = ?,
         algorithm = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = 1`,
  ).run(leafCount, rootHash, auditSeq, MMR_ALG);

  return { leafCount, rootHash, lastSeq: auditSeq, peaks: finalPeaks };
}

export function getIncrementalRoot(db: DatabaseSync): {
  rootHash: string | null;
  leafCount: number;
  lastSeq: number | null;
  peaks: MmrPeak[];
  algorithm: string;
} {
  const state = db
    .prepare(
      `SELECT leaf_count, root_hash, last_seq, algorithm FROM merkle_inc_state WHERE id = 1`,
    )
    .get() as {
    leaf_count: number;
    root_hash: string | null;
    last_seq: number | null;
    algorithm: string;
  };
  return {
    rootHash: state.root_hash,
    leafCount: state.leaf_count,
    lastSeq: state.last_seq,
    peaks: loadPeaks(db),
    algorithm: state.algorithm ?? MMR_ALG,
  };
}

/**
 * Inclusion against live root without full-tree rebuild.
 * Loads only the leaves under the peak that contains seq (size 2^h), proves
 * path to peak, then checks peak ∈ bag → root.
 */
export function proveMmrInclusion(
  db: DatabaseSync,
  leafSeq: number,
): {
  leafSeq: number;
  leafHash: string;
  peak: MmrPeak;
  peakProof: ReturnType<typeof proveInclusion>;
  peaks: MmrPeak[];
  rootHash: string;
  algorithm: string;
} {
  const tip = getIncrementalRoot(db);
  if (!tip.rootHash) throw new Error("mmr: empty tree");

  const peak = tip.peaks.find((p) => p.fromSeq <= leafSeq && leafSeq <= p.toSeq);
  if (!peak) throw new Error(`mmr: no peak covers seq=${leafSeq}`);

  const rows = db
    .prepare(
      `SELECT seq, entry_hash FROM audit_event
       WHERE seq >= ? AND seq <= ? ORDER BY seq ASC`,
    )
    .all(peak.fromSeq, peak.toSeq) as { seq: number; entry_hash: string }[];

  if (rows.length !== 2 ** peak.height && peak.height > 0) {
    // height 0 → 1 leaf; height h → 2^h leaves
    if (rows.length !== 1 << peak.height) {
      throw new Error(
        `mmr: peak leaf count ${rows.length} != 2^${peak.height}`,
      );
    }
  }

  const leaves = rows.map((r) => r.entry_hash);
  const leafIndex = rows.findIndex((r) => r.seq === leafSeq);
  if (leafIndex < 0) throw new Error(`mmr: seq=${leafSeq} not in peak leaves`);

  const peakProof = proveInclusion(leaves, leafIndex);
  if (peakProof.rootHash !== peak.hash) {
    throw new Error("mmr: peak proof root != peak hash");
  }

  return {
    leafSeq,
    leafHash: rows[leafIndex]!.entry_hash,
    peak,
    peakProof,
    peaks: tip.peaks,
    rootHash: tip.rootHash,
    algorithm: MMR_ALG,
  };
}

export function verifyMmrInclusion(proof: ReturnType<typeof proveMmrInclusion>): {
  ok: boolean;
  reason?: string;
} {
  const peakCheck = verifyInclusionProof(proof.peakProof, proof.peak.hash);
  if (!peakCheck.ok) {
    return { ok: false, reason: peakCheck.reason ?? "peak path failed" };
  }
  const bag = bagPeaks(proof.peaks.map((p) => p.hash));
  if (bag !== proof.rootHash) {
    return { ok: false, reason: "peak bag != root" };
  }
  if (!proof.peaks.some((p) => p.hash === proof.peak.hash)) {
    return { ok: false, reason: "peak not listed" };
  }
  return { ok: true };
}

/** Catch up from audit_event rows not yet in the MMR. */
export function syncMerkleIncremental(db: DatabaseSync): MmrAppendResult | null {
  if (!incrementalOn(db)) return null;
  const state = db
    .prepare(`SELECT last_seq FROM merkle_inc_state WHERE id = 1`)
    .get() as { last_seq: number | null };
  const after = state.last_seq ?? 0;
  const rows = db
    .prepare(
      `SELECT seq, entry_hash FROM audit_event WHERE seq > ? ORDER BY seq ASC`,
    )
    .all(after) as { seq: number; entry_hash: string }[];
  let last: MmrAppendResult | null = null;
  for (const r of rows) {
    last = appendMerkleLeaf(db, r.entry_hash, r.seq);
  }
  return last;
}

/** Publish live root as a checkpoint without reloading all leaves. */
export function checkpointFromIncremental(
  db: DatabaseSync,
  note?: string,
): {
  id: string;
  rootHash: string;
  fromSeq: number;
  toSeq: number;
  leafCount: number;
} | null {
  const tip = getIncrementalRoot(db);
  if (!tip.rootHash || tip.leafCount === 0 || tip.lastSeq == null) return null;

  const id = newId("mck");
  const fromSeq = 1;
  const toSeq = tip.lastSeq;

  const prev = db
    .prepare(
      `SELECT id, root_hash FROM merkle_checkpoint ORDER BY to_seq DESC LIMIT 1`,
    )
    .get() as { id: string; root_hash: string } | undefined;

  const checkpointLink = prev
    ? sha256(`${prev.root_hash}\n${tip.rootHash}`)
    : sha256(`GENESIS\n${tip.rootHash}`);

  db.prepare(
    `INSERT INTO merkle_checkpoint (
       id, from_seq, to_seq, leaf_count, root_hash,
       prev_checkpoint_id, checkpoint_link, algorithm, note
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fromSeq,
    toSeq,
    tip.leafCount,
    tip.rootHash,
    prev?.id ?? null,
    checkpointLink,
    MMR_ALG,
    note ?? "incremental snapshot",
  );

  db.prepare(
    `UPDATE merkle_tip
     SET checkpoint_id = ?, root_hash = ?, to_seq = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = 1`,
  ).run(id, tip.rootHash, toSeq);

  return {
    id,
    rootHash: tip.rootHash,
    fromSeq,
    toSeq,
    leafCount: tip.leafCount,
  };
}
