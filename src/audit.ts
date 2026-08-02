/**
 * Append-only hash-chained audit trail.
 *
 * entry_hash = sha256(prev_hash || "\n" || canonical JSON of event fields)
 * Tip stored in audit_chain_tip — only mutable structure.
 * On chain break: verifyAuditChain fails; callers fail closed if policy on.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId, sha256 } from "./hash.ts";
import { appendMerkleLeaf } from "./merkle_inc.ts";

export type AuditCategory =
  | "gate"
  | "approval"
  | "spend"
  | "ledger"
  | "skill"
  | "constitution"
  | "session"
  | "system"
  | "security";

export interface AuditAppendInput {
  category: AuditCategory;
  action: string;
  actor?: string;
  actorDetail?: string;
  subjectKind?: string;
  subjectId?: string;
  turnId?: string;
  sessionId?: string;
  profileId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditEventRow {
  seq: number;
  id: string;
  category: string;
  action: string;
  actor: string | null;
  subjectKind: string | null;
  subjectId: string | null;
  turnId: string | null;
  entryHash: string;
  prevHash: string;
  createdAt: string;
  detailJson: string | null;
}

function canonicalPayload(input: AuditAppendInput, id: string, createdAt: string): string {
  // Stable key order for hashing
  const obj = {
    id,
    category: input.category,
    action: input.action,
    actor: input.actor ?? null,
    actorDetail: input.actorDetail ?? null,
    subjectKind: input.subjectKind ?? null,
    subjectId: input.subjectId ?? null,
    turnId: input.turnId ?? null,
    sessionId: input.sessionId ?? null,
    profileId: input.profileId ?? null,
    detail: input.detail ?? null,
    createdAt,
  };
  return JSON.stringify(obj);
}

function chainEnabled(db: DatabaseSync): boolean {
  const row = db
    .prepare(`SELECT value FROM chamber_config WHERE key = 'audit.chain_enabled'`)
    .get() as { value: string } | undefined;
  return (row?.value ?? "on") === "on";
}

function failClosedOnBreak(db: DatabaseSync): boolean {
  const row = db
    .prepare(`SELECT value FROM chamber_config WHERE key = 'audit.fail_closed_on_break'`)
    .get() as { value: string } | undefined;
  return (row?.value ?? "on") === "on";
}

/**
 * Append one audit event inside the caller's transaction when possible.
 * Uses BEGIN IMMEDIATE if not already in a transaction-sensitive path —
 * for embedding inside commit_belief TX, prefer appendAuditInTx.
 */
export function appendAudit(db: DatabaseSync, input: AuditAppendInput): string {
  if (!chainEnabled(db)) {
    // Still record without caring about tip races when disabled — degenerate mode
  }

  const id = newId("aud");
  const createdAt = new Date().toISOString();

  let ownTx = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    ownTx = true;
  } catch {
    // Already in a transaction (e.g. tryActivateSkill) — write in-caller's TX
    ownTx = false;
  }
  try {
    const tip = db
      .prepare(`SELECT last_seq, last_hash FROM audit_chain_tip WHERE id = 1`)
      .get() as { last_seq: number; last_hash: string };

    const prevHash = tip.last_hash;
    const payload = canonicalPayload(input, id, createdAt);
    const entryHash = sha256(`${prevHash}\n${payload}`);

    db.prepare(
      `INSERT INTO audit_event (
         id, category, action, actor, actor_detail, subject_kind, subject_id,
         turn_id, session_id, profile_id, detail_json, prev_hash, entry_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.category,
      input.action,
      input.actor ?? null,
      input.actorDetail ?? null,
      input.subjectKind ?? null,
      input.subjectId ?? null,
      input.turnId ?? null,
      input.sessionId ?? null,
      input.profileId ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
      prevHash,
      entryHash,
      createdAt,
    );

    const newSeq = db
      .prepare(`SELECT seq FROM audit_event WHERE id = ?`)
      .get(id) as { seq: number };

    db.prepare(
      `UPDATE audit_chain_tip
       SET last_seq = ?, last_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = 1`,
    ).run(newSeq.seq, entryHash);

    // Incremental MMR: O(log n) peak update — root stays fresh, no full rebuild
    appendMerkleLeaf(db, entryHash, newSeq.seq);

    if (ownTx) db.exec("COMMIT");
    return id;
  } catch (err) {
    if (ownTx) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}

/**
 * Same as appendAudit but does NOT begin/commit — caller owns the TX.
 * Use inside commit_belief / try_activate_skill transactions.
 */
export function appendAuditInTx(db: DatabaseSync, input: AuditAppendInput): string {
  const id = newId("aud");
  const createdAt = new Date().toISOString();

  const tip = db
    .prepare(`SELECT last_seq, last_hash FROM audit_chain_tip WHERE id = 1`)
    .get() as { last_seq: number; last_hash: string };

  const prevHash = tip.last_hash;
  const payload = canonicalPayload(input, id, createdAt);
  const entryHash = sha256(`${prevHash}\n${payload}`);

  db.prepare(
    `INSERT INTO audit_event (
       id, category, action, actor, actor_detail, subject_kind, subject_id,
       turn_id, session_id, profile_id, detail_json, prev_hash, entry_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.category,
    input.action,
    input.actor ?? null,
    input.actorDetail ?? null,
    input.subjectKind ?? null,
    input.subjectId ?? null,
    input.turnId ?? null,
    input.sessionId ?? null,
    input.profileId ?? null,
    input.detail ? JSON.stringify(input.detail) : null,
    prevHash,
    entryHash,
    createdAt,
  );

  const newSeq = db
    .prepare(`SELECT seq FROM audit_event WHERE id = ?`)
    .get(id) as { seq: number };

  db.prepare(
    `UPDATE audit_chain_tip
     SET last_seq = ?, last_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = 1`,
  ).run(newSeq.seq, entryHash);

  appendMerkleLeaf(db, entryHash, newSeq.seq);

  return id;
}

export interface ChainVerifyResult {
  ok: boolean;
  checked: number;
  brokenAtSeq?: number;
  reason?: string;
}

/** Walk the chain from GENESIS; O(n). Run in dream/cron or before sensitive commits. */
export function verifyAuditChain(db: DatabaseSync): ChainVerifyResult {
  const rows = db
    .prepare(
      `SELECT seq, id, category, action, actor, actor_detail, subject_kind, subject_id,
              turn_id, session_id, profile_id, detail_json, prev_hash, entry_hash, created_at
       FROM audit_event ORDER BY seq ASC`,
    )
    .all() as {
    seq: number;
    id: string;
    category: string;
    action: string;
    actor: string | null;
    actor_detail: string | null;
    subject_kind: string | null;
    subject_id: string | null;
    turn_id: string | null;
    session_id: string | null;
    profile_id: string | null;
    detail_json: string | null;
    prev_hash: string;
    entry_hash: string;
    created_at: string;
  }[];

  let prevHash = "GENESIS";
  let checked = 0;

  for (const r of rows) {
    if (r.prev_hash !== prevHash) {
      return {
        ok: false,
        checked,
        brokenAtSeq: r.seq,
        reason: `prev_hash mismatch at seq=${r.seq}`,
      };
    }
    const input: AuditAppendInput = {
      category: r.category as AuditCategory,
      action: r.action,
      actor: r.actor ?? undefined,
      actorDetail: r.actor_detail ?? undefined,
      subjectKind: r.subject_kind ?? undefined,
      subjectId: r.subject_id ?? undefined,
      turnId: r.turn_id ?? undefined,
      sessionId: r.session_id ?? undefined,
      profileId: r.profile_id ?? undefined,
      detail: r.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : undefined,
    };
    const payload = canonicalPayload(input, r.id, r.created_at);
    const expected = sha256(`${prevHash}\n${payload}`);
    if (expected !== r.entry_hash) {
      return {
        ok: false,
        checked,
        brokenAtSeq: r.seq,
        reason: `entry_hash mismatch at seq=${r.seq}`,
      };
    }
    prevHash = r.entry_hash;
    checked++;
  }

  const tip = db
    .prepare(`SELECT last_hash, last_seq FROM audit_chain_tip WHERE id = 1`)
    .get() as { last_hash: string; last_seq: number };

  if (rows.length > 0 && tip.last_hash !== prevHash) {
    return {
      ok: false,
      checked,
      reason: "tip last_hash does not match final entry_hash",
    };
  }

  return { ok: true, checked };
}

/** Gate: refuse sensitive operations if chain is broken and fail-closed is on. */
export function assertAuditChainOrThrow(db: DatabaseSync): void {
  if (!failClosedOnBreak(db)) return;
  const v = verifyAuditChain(db);
  if (!v.ok) {
    throw new Error(`AUDIT_CHAIN_BROKEN: ${v.reason ?? "unknown"} (seq=${v.brokenAtSeq})`);
  }
}

export function queryAudit(
  db: DatabaseSync,
  filter: {
    category?: AuditCategory;
    subjectId?: string;
    sessionId?: string;
    since?: string;
    limit?: number;
  },
): AuditEventRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.category) {
    clauses.push("category = ?");
    params.push(filter.category);
  }
  if (filter.subjectId) {
    clauses.push("subject_id = ?");
    params.push(filter.subjectId);
  }
  if (filter.sessionId) {
    clauses.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.since) {
    clauses.push("created_at >= ?");
    params.push(filter.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filter.limit ?? 100;
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT seq, id, category, action, actor, subject_kind, subject_id, turn_id,
              entry_hash, prev_hash, created_at, detail_json
       FROM audit_event ${where}
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .all(...params) as {
    seq: number;
    id: string;
    category: string;
    action: string;
    actor: string | null;
    subject_kind: string | null;
    subject_id: string | null;
    turn_id: string | null;
    entry_hash: string;
    prev_hash: string;
    created_at: string;
    detail_json: string | null;
  }[];

  return rows.map((r) => ({
    seq: r.seq,
    id: r.id,
    category: r.category,
    action: r.action,
    actor: r.actor,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    turnId: r.turn_id,
    entryHash: r.entry_hash,
    prevHash: r.prev_hash,
    createdAt: r.created_at,
    detailJson: r.detail_json,
  }));
}

/** Convenience wrappers for common Chamber events */
export function auditGate(
  db: DatabaseSync,
  action: string,
  subject: { kind?: string; id?: string },
  detail?: Record<string, unknown>,
  ctx?: { turnId?: string; sessionId?: string },
): string {
  return appendAudit(db, {
    category: "gate",
    action,
    actor: "system",
    subjectKind: subject.kind,
    subjectId: subject.id,
    turnId: ctx?.turnId,
    sessionId: ctx?.sessionId,
    detail,
  });
}

export function auditApproval(
  db: DatabaseSync,
  action: string,
  writeId: string,
  actor: string,
  detail?: Record<string, unknown>,
): string {
  return appendAudit(db, {
    category: "approval",
    action,
    actor,
    subjectKind: "pending_write",
    subjectId: writeId,
    detail,
  });
}
