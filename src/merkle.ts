/**
 * Binary Merkle tree over audit_event.entry_hash leaves (sha256).
 *
 * Tree rule (sha256_binary_merkle_v1):
 *   - Leaves are entry_hash values in seq order (already digests)
 *   - Odd node at a level is promoted (duplicated pair with itself) before hash
 *   - Parent = sha256(left || right)  (64 hex chars concatenated as utf8 hex, then hashed)
 *
 * Inclusion proof: sibling hashes from leaf to root + path directions.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId, sha256 } from "./hash.ts";
import { checkpointFromIncremental } from "./merkle_inc.ts";

export const MERKLE_ALG = "sha256_binary_merkle_v1";

/** Parent hash of two child hex digests. */
export function merkleParent(leftHex: string, rightHex: string): string {
  return sha256(leftHex + rightHex);
}

/**
 * Build layers bottom-up. Returns { root, layers } where layers[0] is leaves.
 * Empty input throws.
 */
export function buildMerkleLayers(leaves: string[]): {
  root: string;
  layers: string[][];
} {
  if (leaves.length === 0) {
    throw new Error("merkle: cannot build tree from zero leaves");
  }
  const layers: string[][] = [leaves.slice()];
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(merkleParent(level[i]!, level[i + 1]!));
      } else {
        // Promote odd leaf by hashing with itself
        next.push(merkleParent(level[i]!, level[i]!));
      }
    }
    layers.push(next);
    level = next;
  }
  return { root: level[0]!, layers };
}

export interface InclusionProof {
  leafHash: string;
  leafIndex: number;
  leafCount: number;
  /** Sibling hash at each level from leaf toward root */
  siblings: string[];
  /** true = current node was right child (sibling is left) */
  wasRight: boolean[];
  rootHash: string;
  algorithm: string;
}

export function proveInclusion(
  leaves: string[],
  leafIndex: number,
): InclusionProof {
  if (leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error("merkle: leafIndex out of range");
  }
  const { root, layers } = buildMerkleLayers(leaves);
  const siblings: string[] = [];
  const wasRight: boolean[] = [];
  let idx = leafIndex;
  for (let L = 0; L < layers.length - 1; L++) {
    const level = layers[L]!;
    const isRight = idx % 2 === 1;
    wasRight.push(isRight);
    if (isRight) {
      siblings.push(level[idx - 1]!);
    } else if (idx + 1 < level.length) {
      siblings.push(level[idx + 1]!);
    } else {
      // Odd last node — sibling is self
      siblings.push(level[idx]!);
    }
    idx = Math.floor(idx / 2);
  }
  return {
    leafHash: leaves[leafIndex]!,
    leafIndex,
    leafCount: leaves.length,
    siblings,
    wasRight,
    rootHash: root,
    algorithm: MERKLE_ALG,
  };
}

/** Verify an inclusion proof against an expected root. */
export function verifyInclusionProof(
  proof: InclusionProof,
  expectedRoot?: string,
): { ok: boolean; computedRoot: string; reason?: string } {
  if (proof.algorithm !== MERKLE_ALG) {
    return {
      ok: false,
      computedRoot: "",
      reason: `unsupported algorithm ${proof.algorithm}`,
    };
  }
  let hash = proof.leafHash;
  for (let i = 0; i < proof.siblings.length; i++) {
    const sib = proof.siblings[i]!;
    if (proof.wasRight[i]) {
      hash = merkleParent(sib, hash);
    } else {
      hash = merkleParent(hash, sib);
    }
  }
  const expected = expectedRoot ?? proof.rootHash;
  if (hash !== expected) {
    return {
      ok: false,
      computedRoot: hash,
      reason: "computed root does not match expected",
    };
  }
  return { ok: true, computedRoot: hash };
}

function loadLeaves(
  db: DatabaseSync,
  fromSeq: number,
  toSeq: number,
): { seq: number; entry_hash: string }[] {
  return db
    .prepare(
      `SELECT seq, entry_hash FROM audit_event
       WHERE seq >= ? AND seq <= ?
       ORDER BY seq ASC`,
    )
    .all(fromSeq, toSeq) as { seq: number; entry_hash: string }[];
}

export interface CheckpointResult {
  id: string;
  fromSeq: number;
  toSeq: number;
  leafCount: number;
  rootHash: string;
  prevCheckpointId: string | null;
  checkpointLink: string;
}

/**
 * Create a Merkle checkpoint over audit_event seq range [fromSeq, toSeq].
 * Defaults: from last checkpoint's to_seq+1 (or 1) through current max seq.
 */
export function createMerkleCheckpoint(
  db: DatabaseSync,
  opts?: { fromSeq?: number; toSeq?: number; note?: string },
): CheckpointResult {
  const maxRow = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM audit_event`)
    .get() as { m: number };
  const maxSeq = maxRow.m;
  if (maxSeq < 1) {
    throw new Error("merkle: no audit events to checkpoint");
  }

  const prev = db
    .prepare(
      `SELECT id, to_seq, root_hash FROM merkle_checkpoint ORDER BY to_seq DESC LIMIT 1`,
    )
    .get() as { id: string; to_seq: number; root_hash: string } | undefined;

  const fromSeq = opts?.fromSeq ?? (prev ? prev.to_seq + 1 : 1);
  const toSeq = opts?.toSeq ?? maxSeq;
  if (fromSeq > toSeq) {
    throw new Error(`merkle: empty range from_seq=${fromSeq} to_seq=${toSeq}`);
  }

  const rows = loadLeaves(db, fromSeq, toSeq);
  if (rows.length === 0) {
    throw new Error("merkle: no leaves in range");
  }
  // Ensure contiguous seq coverage
  if (rows[0]!.seq !== fromSeq || rows[rows.length - 1]!.seq !== toSeq) {
    throw new Error("merkle: audit seq range is not contiguous or incomplete");
  }

  const leaves = rows.map((r) => r.entry_hash);
  const { root } = buildMerkleLayers(leaves);

  const id = newId("mck");
  const prevId = prev?.id ?? null;
  const checkpointLink = prev
    ? sha256(`${prev.root_hash}\n${root}`)
    : sha256(`GENESIS\n${root}`);

  db.prepare(
    `INSERT INTO merkle_checkpoint (
       id, from_seq, to_seq, leaf_count, root_hash,
       prev_checkpoint_id, checkpoint_link, algorithm, note
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fromSeq,
    toSeq,
    leaves.length,
    root,
    prevId,
    checkpointLink,
    MERKLE_ALG,
    opts?.note ?? null,
  );

  db.prepare(
    `UPDATE merkle_tip
     SET checkpoint_id = ?, root_hash = ?, to_seq = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = 1`,
  ).run(id, root, toSeq);

  return {
    id,
    fromSeq,
    toSeq,
    leafCount: leaves.length,
    rootHash: root,
    prevCheckpointId: prevId,
    checkpointLink,
  };
}

/**
 * Prove that audit seq is in a given checkpoint (or latest covering it).
 */
export function proveAuditSeq(
  db: DatabaseSync,
  seq: number,
  checkpointId?: string,
): InclusionProof & { checkpointId: string; seq: number } {
  const cp = checkpointId
    ? (db
        .prepare(
          `SELECT id, from_seq, to_seq, root_hash FROM merkle_checkpoint WHERE id = ?`,
        )
        .get(checkpointId) as
        | { id: string; from_seq: number; to_seq: number; root_hash: string }
        | undefined)
    : (db
        .prepare(
          `SELECT id, from_seq, to_seq, root_hash FROM merkle_checkpoint
           WHERE from_seq <= ? AND to_seq >= ?
           ORDER BY to_seq DESC LIMIT 1`,
        )
        .get(seq, seq) as
        | { id: string; from_seq: number; to_seq: number; root_hash: string }
        | undefined);

  if (!cp) {
    throw new Error(`merkle: no checkpoint covers seq=${seq}`);
  }
  if (seq < cp.from_seq || seq > cp.to_seq) {
    throw new Error(`merkle: seq=${seq} outside checkpoint range`);
  }

  const rows = loadLeaves(db, cp.from_seq, cp.to_seq);
  const leaves = rows.map((r) => r.entry_hash);
  const leafIndex = seq - cp.from_seq;
  const proof = proveInclusion(leaves, leafIndex);
  if (proof.rootHash !== cp.root_hash) {
    throw new Error("merkle: recomputed root diverges from stored checkpoint");
  }
  return { ...proof, checkpointId: cp.id, seq };
}

export interface CheckpointVerifyResult {
  ok: boolean;
  checkpointId: string;
  reason?: string;
  recomputedRoot?: string;
}

/** Recompute root from audit leaves and compare to stored checkpoint. */
export function verifyMerkleCheckpoint(
  db: DatabaseSync,
  checkpointId: string,
): CheckpointVerifyResult {
  const cp = db
    .prepare(
      `SELECT id, from_seq, to_seq, root_hash, leaf_count FROM merkle_checkpoint WHERE id = ?`,
    )
    .get(checkpointId) as
    | {
        id: string;
        from_seq: number;
        to_seq: number;
        root_hash: string;
        leaf_count: number;
      }
    | undefined;

  if (!cp) {
    return { ok: false, checkpointId, reason: "checkpoint not found" };
  }

  const rows = loadLeaves(db, cp.from_seq, cp.to_seq);
  if (rows.length !== cp.leaf_count) {
    return {
      ok: false,
      checkpointId,
      reason: `leaf_count mismatch stored=${cp.leaf_count} actual=${rows.length}`,
    };
  }
  const { root } = buildMerkleLayers(rows.map((r) => r.entry_hash));
  if (root !== cp.root_hash) {
    return {
      ok: false,
      checkpointId,
      reason: "recomputed root does not match stored root_hash",
      recomputedRoot: root,
    };
  }
  return { ok: true, checkpointId, recomputedRoot: root };
}

/** Verify checkpoint link chain (each link binds to previous root). */
export function verifyCheckpointChain(db: DatabaseSync): {
  ok: boolean;
  checked: number;
  reason?: string;
} {
  const rows = db
    .prepare(
      `SELECT id, root_hash, prev_checkpoint_id, checkpoint_link
       FROM merkle_checkpoint ORDER BY to_seq ASC`,
    )
    .all() as {
    id: string;
    root_hash: string;
    prev_checkpoint_id: string | null;
    checkpoint_link: string | null;
  }[];

  let checked = 0;
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const r of rows) {
    if (!r.prev_checkpoint_id) {
      const expected = sha256(`GENESIS\n${r.root_hash}`);
      if (r.checkpoint_link !== expected) {
        return {
          ok: false,
          checked,
          reason: `genesis link mismatch at ${r.id}`,
        };
      }
    } else {
      const prev = byId.get(r.prev_checkpoint_id);
      if (!prev) {
        return {
          ok: false,
          checked,
          reason: `missing prev checkpoint ${r.prev_checkpoint_id}`,
        };
      }
      const expected = sha256(`${prev.root_hash}\n${r.root_hash}`);
      if (r.checkpoint_link !== expected) {
        return {
          ok: false,
          checked,
          reason: `checkpoint link mismatch at ${r.id}`,
        };
      }
    }
    checked++;
  }
  return { ok: true, checked };
}

/**
 * Auto-checkpoint when new events since last tip exceed N (config).
 * Returns new checkpoint or null if not needed.
 */
export function maybeAutoCheckpoint(db: DatabaseSync): CheckpointResult | null {
  const enabled = db
    .prepare(`SELECT value FROM chamber_config WHERE key = 'merkle.enabled'`)
    .get() as { value: string } | undefined;
  if (enabled && enabled.value !== "on") return null;

  const everyRow = db
    .prepare(
      `SELECT value FROM chamber_config WHERE key = 'merkle.auto_checkpoint_every_n'`,
    )
    .get() as { value: string } | undefined;
  const everyN = parseInt(everyRow?.value ?? "64", 10);

  const tip = db
    .prepare(`SELECT to_seq FROM merkle_tip WHERE id = 1`)
    .get() as { to_seq: number | null };
  const maxRow = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM audit_event`)
    .get() as { m: number };

  const last = tip.to_seq ?? 0;
  if (maxRow.m - last < everyN) return null;
  // Prefer incremental snapshot (live MMR root, no full leaf reload)
  const snap = checkpointFromIncremental(db, "auto-inc");
  if (snap) {
    return {
      id: snap.id,
      fromSeq: snap.fromSeq,
      toSeq: snap.toSeq,
      leafCount: snap.leafCount,
      rootHash: snap.rootHash,
      prevCheckpointId: null,
      checkpointLink: "",
    };
  }
  return createMerkleCheckpoint(db);
}

export function getMerkleTip(db: DatabaseSync): {
  checkpointId: string | null;
  rootHash: string | null;
  toSeq: number | null;
} {
  const tip = db
    .prepare(
      `SELECT checkpoint_id, root_hash, to_seq FROM merkle_tip WHERE id = 1`,
    )
    .get() as {
    checkpoint_id: string | null;
    root_hash: string | null;
    to_seq: number | null;
  };
  return {
    checkpointId: tip.checkpoint_id,
    rootHash: tip.root_hash,
    toSeq: tip.to_seq,
  };
}
