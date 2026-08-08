/**
 * Export MMR / Merkle checkpoint for external anchoring (OTS, Rekor, etc.).
 * Chamber does not phone home — it writes a JSON receipt you can timestamp.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getIncrementalRoot, rootAtSeq } from "./merkle_inc.ts";
import { verifyAuditChain } from "./audit.ts";
import { configPath } from "./config.ts";
import { stableStringify } from "./hash.ts";

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

/**
 * Where a checkpoint goes when the caller does not say.
 *
 * It used to be `/tmp/chamber-checkpoint.json`, which is the one place a
 * receipt must never live: `/tmp` is world-writable and is cleared on reboot,
 * so the single artefact that exists to outlive the database was neither
 * durable nor exclusively ours. It belongs beside the config, under the
 * operator's own directory.
 */
export function defaultCheckpointPath(): string {
  return join(dirname(configPath()), "checkpoint.json");
}

export interface CheckpointSignature {
  algorithm: "ed25519";
  /** SPKI DER, base64. Identifies the signer — it does not vouch for them. */
  publicKey: string;
  value: string;
}

export interface SignedCheckpointReceipt extends CheckpointReceipt {
  signature?: CheckpointSignature;
}

/**
 * Key-order-independent bytes, so a receipt that has been through a file and
 * back still verifies. The signature is excluded from what it signs.
 */
function canonicalBytes(receipt: CheckpointReceipt): Buffer {
  return Buffer.from(stableStringify(receipt, ["signature"]), "utf8");
}

export function generateCheckpointKey(): {
  privateKey: string;
  publicKey: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

/**
 * Load the signing key, creating it on first use.
 *
 * The private key is a file this process can read, which is the honest limit of
 * what local signing buys — see `verifyCheckpointSignature`.
 */
export function loadOrCreateCheckpointKey(keyPath?: string): {
  privateKey: string;
  publicKey: string;
} {
  const p = keyPath ?? join(dirname(configPath()), "checkpoint-key.pem");
  if (existsSync(p)) {
    const privateKey = readFileSync(p, "utf8");
    const publicKey = createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .toString("base64");
    return { privateKey, publicKey };
  }
  const key = generateCheckpointKey();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, key.privateKey, { encoding: "utf8", mode: 0o600 });
  return key;
}

export function signCheckpointReceipt(
  receipt: CheckpointReceipt,
  privateKeyPem: string,
): SignedCheckpointReceipt {
  const publicKey = createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const value = cryptoSign(null, canonicalBytes(receipt), privateKeyPem).toString(
    "base64",
  );
  return { ...receipt, signature: { algorithm: "ed25519", publicKey, value } };
}

/**
 * Check a receipt's signature.
 *
 * Read what this returns carefully. With no `expectedPublicKey` it verifies the
 * receipt against the key printed *inside that same receipt*, which proves only
 * that the document is internally consistent — anyone can sign anything with a
 * key they just generated and embed it. That is a label check, not an identity
 * check. Pass the public key you already trust, from somewhere other than the
 * document, to get an answer about authorship.
 *
 * And even a correct identity answer says nothing about completeness: the agent
 * holds the private key, so a truncated chain can be re-checkpointed and
 * re-signed into a receipt that verifies. `compareCheckpoints` against an older
 * receipt is the only thing here that detects that.
 */
export function verifyCheckpointSignature(
  receipt: SignedCheckpointReceipt,
  expectedPublicKey?: string,
): { ok: boolean; reason?: string } {
  const sig = receipt.signature;
  if (!sig) return { ok: false, reason: "receipt is unsigned" };
  if (expectedPublicKey && expectedPublicKey !== sig.publicKey) {
    return { ok: false, reason: "signed by a different key than expected" };
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(sig.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    const ok = cryptoVerify(
      null,
      canonicalBytes(receipt),
      key,
      Buffer.from(sig.value, "base64"),
    );
    return ok
      ? { ok: true }
      : { ok: false, reason: "signature does not match receipt contents" };
  } catch (err) {
    return {
      ok: false,
      reason: `signature unverifiable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Prove the chain as it stands still contains the history a receipt attested.
 *
 * This is the check `compareCheckpoints` structurally cannot do. Given only two
 * receipts, a truncation followed by fresh writes looks like growth: the chain
 * is longer, so both shrink tests are false, and the root comparison is gated on
 * the length being unchanged so it never runs. Re-deriving the earlier root from
 * the tree's own leaves is what catches it, and it needs the database.
 *
 * `mmrRoot` null means the receipt attested an empty chain — nothing to prove.
 */
export function verifyCheckpointPrefix(
  db: DatabaseSync,
  previous: CheckpointReceipt,
): { ok: boolean; reason?: string } {
  if (previous.mmrRoot === null || previous.lastSeq === null) return { ok: true };

  const { rootHash, leafCount } = rootAtSeq(db, previous.lastSeq);
  if (rootHash === null) {
    return {
      ok: false,
      reason: `no events remain at or before seq ${previous.lastSeq}; the receipt attested ${previous.leafCount}`,
    };
  }
  if (leafCount < previous.leafCount) {
    return {
      ok: false,
      reason: `only ${leafCount} of the ${previous.leafCount} attested events remain up to seq ${previous.lastSeq}`,
    };
  }
  if (rootHash !== previous.mmrRoot) {
    return {
      ok: false,
      reason: `history up to seq ${previous.lastSeq} no longer hashes to the attested root — it was rewritten, not merely extended`,
    };
  }
  return { ok: true };
}

/**
 * Compare a receipt kept from an earlier moment against the chain as it stands.
 *
 * Catches a tail that went backwards, and a rewrite at unchanged length. It
 * cannot catch a truncation followed by fresh writes — that needs the tree, and
 * `verifyCheckpointPrefix` is the check for it. Callers holding a database
 * should run both; this one alone is not a consistency proof.
 */
export function compareCheckpoints(
  previous: CheckpointReceipt,
  current: CheckpointReceipt,
): { ok: boolean; reason?: string } {
  // The unsophisticated truncation — DELETE the last rows and re-export — does
  // not move lastSeq, leafCount or the root at all, because the MMR leaves and
  // the chain tip are separate state the delete never touched. It shows up here
  // instead, as the chain failing to verify against its own tip. Reporting it
  // is this function's job even though the comparison itself is not what caught
  // it: a caller holding two receipts wants one verdict, not two.
  if (!current.audit.ok) {
    return {
      ok: false,
      reason: `chain fails its own verification: ${current.audit.reason ?? "unknown"} (${current.audit.checked} event(s) checked)`,
    };
  }

  const prevSeq = previous.lastSeq ?? 0;
  const curSeq = current.lastSeq ?? 0;
  if (curSeq < prevSeq) {
    return {
      ok: false,
      reason: `audit tail went backwards: lastSeq ${prevSeq} → ${curSeq} (${prevSeq - curSeq} event(s) missing)`,
    };
  }
  if (current.leafCount < previous.leafCount) {
    return {
      ok: false,
      reason: `merkle leaves fell: ${previous.leafCount} → ${current.leafCount}`,
    };
  }
  if (
    curSeq === prevSeq &&
    previous.mmrRoot !== null &&
    current.mmrRoot !== previous.mmrRoot
  ) {
    return {
      ok: false,
      reason: "history was rewritten: same length, different root",
    };
  }
  return { ok: true };
}

/**
 * Build and sign, without writing anything.
 *
 * Split out so a caller can decide the *order* of the two durable effects. The
 * anchor embeds the receipt, so it does not need the file to exist — appending
 * first means a failed append leaves no published receipt behind.
 */
export function buildSignedCheckpointReceipt(
  db: DatabaseSync,
  opts: { sign?: boolean; keyPath?: string } = {},
): SignedCheckpointReceipt {
  const receipt = buildCheckpointReceipt(db);
  return opts.sign === false
    ? receipt
    : signCheckpointReceipt(
        receipt,
        loadOrCreateCheckpointKey(opts.keyPath).privateKey,
      );
}

export function writeCheckpointReceipt(
  outPath: string,
  signed: SignedCheckpointReceipt,
): SignedCheckpointReceipt {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(signed, null, 2), "utf8");
  return signed;
}

export function exportCheckpoint(
  db: DatabaseSync,
  outPath: string,
  opts: { sign?: boolean; keyPath?: string } = {},
): SignedCheckpointReceipt {
  const signed = buildSignedCheckpointReceipt(db, opts);
  return writeCheckpointReceipt(outPath, signed);
}
