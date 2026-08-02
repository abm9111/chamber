/**
 * Export MMR / Merkle checkpoint for external anchoring (OTS, Rekor, etc.).
 * Chamber does not phone home — it writes a JSON receipt you can timestamp.
 */

import { writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getIncrementalRoot } from "./merkle_inc.ts";
import { verifyAuditChain } from "./audit.ts";

export interface CheckpointReceipt {
  format: "chamber_checkpoint_v1";
  exportedAt: string;
  algorithm: string;
  mmrRoot: string | null;
  leafCount: number;
  lastSeq: number | null;
  peaks: { height: number; hash: string; fromSeq: number; toSeq: number }[];
  audit: { ok: boolean; checked: number; reason?: string };
}

export function buildCheckpointReceipt(db: DatabaseSync): CheckpointReceipt {
  const mmr = getIncrementalRoot(db);
  const chain = verifyAuditChain(db);
  return {
    format: "chamber_checkpoint_v1",
    exportedAt: new Date().toISOString(),
    algorithm: mmr.algorithm,
    mmrRoot: mmr.rootHash,
    leafCount: mmr.leafCount,
    lastSeq: mmr.lastSeq,
    peaks: mmr.peaks,
    audit: {
      ok: chain.ok,
      checked: chain.checked,
      reason: chain.reason,
    },
  };
}

export function exportCheckpoint(
  db: DatabaseSync,
  outPath: string,
): CheckpointReceipt {
  const receipt = buildCheckpointReceipt(db);
  writeFileSync(outPath, JSON.stringify(receipt, null, 2), "utf8");
  return receipt;
}
