/**
 * Content-pin verification.
 *
 * A pin is only meaningful if the formula that produced it is the same one
 * that checks it. Each source kind therefore registers its own formula, and a
 * kind with no registered formula is unverifiable — never exempt.
 *
 * Verification is a local corpus lookup: no network, no model, safe to call
 * inside a gate transaction.
 */

import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "./hash.ts";

export type PinFailure = "not_found" | "hash_mismatch" | "kind_unregistered";

export interface PinVerdict {
  ok: boolean;
  reason?: PinFailure;
  actualHash?: string;
  sourceRef?: string | null;
}

export interface PinnedSource {
  kind: string;
  refId: string;
  snapshotHash: string;
}

/**
 * Recompute a vault_page pin from the stored row.
 * Must stay byte-identical to upsertDocument (src/vector.ts:131-133).
 */
function vaultPageHash(row: {
  title: string | null;
  body: string;
  source_ref: string | null;
}): string {
  return sha256([row.title ?? "", row.body, row.source_ref ?? ""].join("\n"));
}

export function verifyPin(db: DatabaseSync, source: PinnedSource): PinVerdict {
  if (source.kind !== "vault_page") {
    return { ok: false, reason: "kind_unregistered" };
  }
  const row = db
    .prepare(
      `SELECT title, body, source_ref FROM vector_document WHERE id = ?`,
    )
    .get(source.refId) as
    | { title: string | null; body: string; source_ref: string | null }
    | undefined;

  if (!row) return { ok: false, reason: "not_found" };

  const actualHash = vaultPageHash(row);
  if (actualHash !== source.snapshotHash) {
    return {
      ok: false,
      reason: "hash_mismatch",
      actualHash,
      sourceRef: row.source_ref,
    };
  }
  return { ok: true, actualHash, sourceRef: row.source_ref };
}
