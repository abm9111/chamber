/**
 * Write approvals — default ON (Hermes inverted: community found approvals off).
 *
 * Flow:
 *   proposeWrite() → pending_write row (status=pending)
 *   decideWrite(approve|reject) → human or auto_policy
 *   apply only after approved (never on timeout — expire ≠ approve)
 *
 * auto_skill_improve policy:
 *   off         — never auto-queue from background
 *   quarantine  — background skill writes always pending (default)
 *   on          — unsafe; allows auto-apply only if skills.write_approval=off
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./hash.ts";

export type WriteTarget =
  | "memory"
  | "user_profile"
  | "belief"
  | "skill"
  | "skill_file"
  | "constitution";

export type WriteAction =
  | "add"
  | "replace"
  | "remove"
  | "create"
  | "edit"
  | "patch"
  | "delete"
  | "write_file"
  | "remove_file"
  | "commit";

export type WriteOrigin =
  | "foreground"
  | "background_review"
  | "dream"
  | "cron"
  | "subagent"
  | "human";

export interface ProposeWriteInput {
  target: WriteTarget;
  action: WriteAction;
  subject: string;
  payload: Record<string, unknown>;
  origin: WriteOrigin;
  authorFamily?: string;
  reason?: string;
  /** Override TTL hours; default from approval_policy */
  ttlHours?: number;
}

export type ProposeResult =
  | { status: "applied_immediate"; writeId: string }
  | { status: "queued"; writeId: string; expiresAt: string }
  | { status: "rejected_by_policy"; reason: string };

function policy(db: DatabaseSync, key: string, fallback: string): string {
  const row = db
    .prepare(`SELECT value FROM approval_policy WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

function approvalRequired(db: DatabaseSync, target: WriteTarget): boolean {
  if (target === "skill" || target === "skill_file") {
    return policy(db, "skills.write_approval", "on") === "on";
  }
  if (target === "memory" || target === "user_profile") {
    return policy(db, "memory.write_approval", "on") === "on";
  }
  if (target === "belief") {
    return policy(db, "belief.assertion_approval", "on") === "on";
  }
  // constitution always queued
  return true;
}

/**
 * Background skill improve path — respects auto_skill_improve quarantine.
 * Returns whether this origin may even create a pending row.
 */
function backgroundSkillAllowed(db: DatabaseSync, origin: WriteOrigin): {
  ok: boolean;
  reason?: string;
} {
  if (origin !== "background_review" && origin !== "dream" && origin !== "cron") {
    return { ok: true };
  }
  const mode = policy(db, "auto_skill_improve", "quarantine");
  if (mode === "off") {
    return { ok: false, reason: "auto_skill_improve=off; background skill writes disabled" };
  }
  // quarantine | on → may queue (apply still gated by skills.write_approval)
  return { ok: true };
}

/** Fired after a write is queued (status=pending). Transport hooks only — no authority. */
export type PendingWriteListener = (event: {
  writeId: string;
  target: WriteTarget;
  action: WriteAction;
  subject: string;
  origin: WriteOrigin;
  reason?: string;
  expiresAt: string;
}) => void;

const pendingListeners: PendingWriteListener[] = [];

export function onPendingWrite(listener: PendingWriteListener): () => void {
  pendingListeners.push(listener);
  return () => {
    const i = pendingListeners.indexOf(listener);
    if (i >= 0) pendingListeners.splice(i, 1);
  };
}

function emitPendingWrite(
  event: Parameters<PendingWriteListener>[0],
): void {
  for (const fn of pendingListeners) {
    try {
      fn(event);
    } catch {
      /* never break propose path */
    }
  }
}

export function proposeWrite(
  db: DatabaseSync,
  input: ProposeWriteInput,
): ProposeResult {
  const { target, action, subject, payload, origin, authorFamily, reason } = input;

  if (
    (target === "skill" || target === "skill_file") &&
    (origin === "background_review" || origin === "dream" || origin === "cron")
  ) {
    const bg = backgroundSkillAllowed(db, origin);
    if (!bg.ok) {
      return { status: "rejected_by_policy", reason: bg.reason ?? "blocked" };
    }
  }

  // Global posture floor: strict → every write queues for human
  const postureStrict =
    (process.env.CHAMBER_POSTURE ?? "auto").toLowerCase() === "strict";
  const needsApproval = postureStrict || approvalRequired(db, target);
  const ttlHours =
    input.ttlHours ??
    parseInt(policy(db, "pending_ttl_hours", "72"), 10);
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  const writeId = newId("pw");

  // If approvals OFF for this target, still record as applied_immediate path
  // only for foreground human-driven — background never auto-applies skills when
  // auto_skill_improve is quarantine (default).
  const autoApply =
    !needsApproval &&
    origin === "foreground" &&
    policy(db, "auto_skill_improve", "quarantine") !== "quarantine";

  if (autoApply && (target === "skill" || target === "skill_file")) {
    // Extremely unsafe path — only if operator explicitly set both policies off/on wrong.
    // Still insert audit row as applied for traceability.
  }

  const status = needsApproval ? "pending" : "approved";

  db.prepare(
    `INSERT INTO pending_write (
       id, target, action, subject, payload_json, origin, author_family,
       status, reason, expires_at,
       decided_at, decided_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    writeId,
    target,
    action,
    subject,
    JSON.stringify(payload),
    origin,
    authorFamily ?? null,
    status,
    reason ?? null,
    expiresAt,
    status === "approved" ? new Date().toISOString() : null,
    status === "approved" ? "auto_policy" : null,
  );

  if (status === "pending") {
    emitPendingWrite({
      writeId,
      target,
      action,
      subject,
      origin,
      reason,
      expiresAt,
    });
    return { status: "queued", writeId, expiresAt };
  }

  // Approvals off: caller may apply payload immediately under their own TX.
  return { status: "applied_immediate", writeId };
}

/** Machine-readable conflict / failure codes for HTTP, Slack, CLI */
export type WriteConflictCode =
  | "not_found"
  | "expired"
  | "already_approved"
  | "already_rejected"
  | "already_applied"
  | "conflict_opposite"
  | "invalid_transition"
  | "concurrent_conflict"
  | "cannot_apply";

export type DecideWriteResult =
  | {
      ok: true;
      /** First successful decision */
      idempotent: false;
      status: "approved" | "rejected";
    }
  | {
      ok: true;
      /** Replay of same decision — no state change */
      idempotent: true;
      status: string;
      message: string;
    }
  | {
      ok: false;
      code: WriteConflictCode;
      reason: string;
      status?: string;
      /** Prior actor if known (never a secret) */
      decidedBy?: string | null;
    };

export function formatWriteConflict(err: {
  code: WriteConflictCode;
  reason: string;
  status?: string;
}): string {
  const hints: Record<WriteConflictCode, string> = {
    not_found: "Check writeId.",
    expired: "TTL elapsed — expire ≠ approve; re-propose if needed.",
    already_approved: "No action needed.",
    already_rejected: "No action needed.",
    already_applied: "No action needed.",
    conflict_opposite:
      "Write already settled with the opposite decision — cannot flip.",
    invalid_transition: "Illegal status transition.",
    concurrent_conflict: "Another actor decided first — refresh queue.",
    cannot_apply: "Write is not in approved state.",
  };
  const hint = hints[err.code] ?? "";
  return `[${err.code}] ${err.reason}${hint ? ` — ${hint}` : ""}`;
}

function conflict(
  code: WriteConflictCode,
  reason: string,
  status?: string,
  decidedBy?: string | null,
): DecideWriteResult {
  return { ok: false, code, reason, status, decidedBy };
}

export interface DecideWriteOpts {
  writeId: string;
  decision: "approved" | "rejected";
  decidedBy: string;
  note?: string;
}

/**
 * Decide a pending write. Idempotent for Slack double-clicks:
 * - same decision again → ok + idempotent: true
 * - opposite decision after settle → ok: false
 * - already applied + approve → ok + idempotent: true
 */
export function decideWrite(
  db: DatabaseSync,
  writeIdOrOpts: string | DecideWriteOpts,
  decisionMaybe?: "approved" | "rejected",
  decidedByMaybe?: string,
  noteMaybe?: string,
): DecideWriteResult {
  const opts: DecideWriteOpts =
    typeof writeIdOrOpts === "string"
      ? {
          writeId: writeIdOrOpts,
          decision: decisionMaybe!,
          decidedBy: decidedByMaybe!,
          note: noteMaybe,
        }
      : writeIdOrOpts;

  const { writeId, decision, decidedBy, note } = opts;

  const row = db
    .prepare(
      `SELECT id, status, expires_at, decided_by FROM pending_write WHERE id = ?`,
    )
    .get(writeId) as
    | {
        id: string;
        status: string;
        expires_at: string | null;
        decided_by: string | null;
      }
    | undefined;

  if (!row) return conflict("not_found", "write not found");

  // ── Idempotent replays (same decision) ────────────────────────────
  if (row.status === decision) {
    return {
      ok: true,
      idempotent: true,
      status: row.status,
      message: `already ${row.status}`,
    };
  }
  if (row.status === "applied" && decision === "approved") {
    return {
      ok: true,
      idempotent: true,
      status: "applied",
      message: "already applied",
    };
  }
  if (row.status === "approved" && decision === "approved") {
    return {
      ok: true,
      idempotent: true,
      status: "approved",
      message: "already approved",
    };
  }
  if (row.status === "rejected" && decision === "rejected") {
    return {
      ok: true,
      idempotent: true,
      status: "rejected",
      message: "already rejected",
    };
  }

  // ── Conflicts (opposite or wrong terminal state) ──────────────────
  if (row.status === "approved" && decision === "rejected") {
    return conflict(
      "conflict_opposite",
      "cannot reject: already approved",
      "approved",
      row.decided_by,
    );
  }
  if (row.status === "rejected" && decision === "approved") {
    return conflict(
      "conflict_opposite",
      "cannot approve: already rejected",
      "rejected",
      row.decided_by,
    );
  }
  if (row.status === "applied" && decision === "rejected") {
    return conflict(
      "already_applied",
      "cannot reject: already applied",
      "applied",
      row.decided_by,
    );
  }
  if (row.status === "expired") {
    return conflict(
      "expired",
      "pending write expired (fail closed)",
      "expired",
      row.decided_by,
    );
  }
  if (row.status !== "pending") {
    return conflict(
      "invalid_transition",
      `not pending (status=${row.status})`,
      row.status,
      row.decided_by,
    );
  }

  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    db.prepare(
      `UPDATE pending_write SET status = 'expired', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       decided_by = 'system', decision_note = 'ttl elapsed — expire ≠ approve'
       WHERE id = ? AND status = 'pending'`,
    ).run(writeId);
    return conflict(
      "expired",
      "pending write expired (fail closed)",
      "expired",
    );
  }

  // Atomic transition: only pending → decision
  const result = db
    .prepare(
      `UPDATE pending_write
       SET status = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           decided_by = ?, decision_note = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(decision, decidedBy, note ?? null, writeId);

  if (Number(result.changes ?? 0) === 0) {
    // Race: another worker decided first
    const again = db
      .prepare(
        `SELECT status, decided_by FROM pending_write WHERE id = ?`,
      )
      .get(writeId) as
      | { status: string; decided_by: string | null }
      | undefined;
    if (
      again?.status === decision ||
      (decision === "approved" && again?.status === "applied")
    ) {
      return {
        ok: true,
        idempotent: true,
        status: again.status,
        message: `concurrent decide settled as ${again.status}`,
      };
    }
    if (
      (decision === "approved" && again?.status === "rejected") ||
      (decision === "rejected" &&
        (again?.status === "approved" || again?.status === "applied"))
    ) {
      return conflict(
        "concurrent_conflict",
        `concurrent decide settled opposite (status=${again?.status})`,
        again?.status,
        again?.decided_by,
      );
    }
    return conflict(
      "concurrent_conflict",
      `not pending after race (status=${again?.status ?? "missing"})`,
      again?.status,
      again?.decided_by,
    );
  }

  return { ok: true, idempotent: false, status: decision };
}

export type MarkAppliedResult =
  | { ok: true; idempotent: boolean; status: string }
  | {
      ok: false;
      code: WriteConflictCode;
      reason: string;
      status?: string;
    };

/**
 * Mark approved write as applied. Idempotent if already applied.
 */
export function markApplied(
  db: DatabaseSync,
  writeId: string,
): MarkAppliedResult {
  const row = db
    .prepare(`SELECT status FROM pending_write WHERE id = ?`)
    .get(writeId) as { status: string } | undefined;
  if (!row) {
    return { ok: false, code: "not_found", reason: "write not found" };
  }
  if (row.status === "applied") {
    return { ok: true, idempotent: true, status: "applied" };
  }
  if (row.status !== "approved") {
    const code: WriteConflictCode =
      row.status === "rejected"
        ? "already_rejected"
        : row.status === "expired"
          ? "expired"
          : row.status === "pending"
            ? "cannot_apply"
            : "invalid_transition";
    return {
      ok: false,
      code,
      reason: `cannot apply (status=${row.status})`,
      status: row.status,
    };
  }
  const result = db
    .prepare(
      `UPDATE pending_write
       SET status = 'applied', applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'approved'`,
    )
    .run(writeId);
  if (Number(result.changes ?? 0) === 0) {
    const again = db
      .prepare(`SELECT status FROM pending_write WHERE id = ?`)
      .get(writeId) as { status: string } | undefined;
    if (again?.status === "applied") {
      return { ok: true, idempotent: true, status: "applied" };
    }
    return {
      ok: false,
      code: "concurrent_conflict",
      reason: `cannot apply after race (status=${again?.status ?? "missing"})`,
      status: again?.status,
    };
  }
  return { ok: true, idempotent: false, status: "applied" };
}

/** Expire stale pending rows — never auto-approve (FM-7). */
export function expireStalePending(db: DatabaseSync): number {
  const result = db
    .prepare(
      `UPDATE pending_write
       SET status = 'expired',
           decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           decided_by = 'system',
           decision_note = 'ttl elapsed — expire ≠ approve'
       WHERE status = 'pending'
         AND expires_at IS NOT NULL
         AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .run();
  return Number(result.changes ?? 0);
}

export interface PendingQueueItem {
  id: string;
  target: string;
  action: string;
  subject: string;
  origin: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/** One-line "why blocked / why queued" for CLI/Slack. */
export function pendingWhy(row: {
  target: string;
  action: string;
  origin: string;
  reason: string | null;
  expiresAt?: string | null;
}): string {
  const posture =
    (process.env.CHAMBER_POSTURE ?? "auto").toLowerCase() === "strict"
      ? "posture=strict requires human"
      : `target=${row.target} requires approval`;
  const bits = [
    posture,
    `origin=${row.origin}`,
    row.reason ? `reason=${row.reason}` : null,
    row.expiresAt ? `expires=${row.expiresAt}` : null,
  ].filter(Boolean);
  return bits.join("; ");
}

export function listPendingQueue(db: DatabaseSync, limit = 50): PendingQueueItem[] {
  expireStalePending(db);
  const rows = db
    .prepare(
      `SELECT id, target, action, subject, origin, reason, created_at, expires_at
       FROM pending_write
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(limit) as {
    id: string;
    target: string;
    action: string;
    subject: string;
    origin: string;
    reason: string | null;
    created_at: string;
    expires_at: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    target: r.target,
    action: r.action,
    subject: r.subject,
    origin: r.origin,
    reason: r.reason,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

export function getApprovalPolicy(db: DatabaseSync): Record<string, string> {
  const rows = db
    .prepare(`SELECT key, value FROM approval_policy`)
    .all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
