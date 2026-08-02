/**
 * Hierarchical LTM + active forgetting + dream proposals.
 *
 * Layers: working → episodic → semantic → skill_note
 * Forgetting: decay job marks forgotten/decayed; never silent delete of audit trail.
 * Dream: offline scan → memory_proposal rows only (never auto-apply).
 */

import type { DatabaseSync } from "node:sqlite";
import { newId, sha256 } from "./hash.ts";
import { proposeWrite } from "./approvals.ts";
import { appendAudit } from "./audit.ts";
import { recordSpend } from "./spend.ts";

export type MemoryLayer = "working" | "episodic" | "semantic" | "skill_note";

export interface RememberInput {
  layer: MemoryLayer;
  body: string;
  title?: string;
  sourceKind?: string;
  sourceRef?: string;
  snapshotHash?: string;
  beliefId?: string;
  salience?: number;
  halfLifeSeconds?: number;
  /** If true, route through proposeWrite instead of direct insert */
  requireApproval?: boolean;
}

export interface MemoryItem {
  id: string;
  layer: MemoryLayer;
  title: string | null;
  body: string;
  contentHash: string;
  status: string;
  salience: number;
  expiresAt: string | null;
}

const DEFAULT_HALF_LIFE: Record<MemoryLayer, number | null> = {
  working: 3600 * 6, // 6h
  episodic: 3600 * 24 * 14, // 14d
  semantic: null, // durable until explicit forget
  skill_note: null,
};

function expiresFromHalfLife(half: number | null | undefined): string | null {
  if (half == null || half <= 0) return null;
  return new Date(Date.now() + half * 1000).toISOString();
}

export function remember(
  db: DatabaseSync,
  input: RememberInput,
): { ok: boolean; id?: string; status: string; reason?: string; writeId?: string } {
  const half =
    input.halfLifeSeconds !== undefined
      ? input.halfLifeSeconds
      : DEFAULT_HALF_LIFE[input.layer];
  const contentHash = sha256(input.body);
  const expiresAt = expiresFromHalfLife(half ?? null);

  // Raw session/chat text cannot become durable memory without a gate
  const sessionLike =
    input.sourceKind === "session" ||
    input.sourceKind === "transcript" ||
    input.sourceKind === "discord" ||
    input.sourceKind === "slack" ||
    (input.body?.includes("[UNTRUSTED_SURFACE") ?? false);
  if (sessionLike && (input.layer === "semantic" || input.layer === "skill_note" || input.layer === "episodic")) {
    input = { ...input, requireApproval: true };
  }

  if (input.requireApproval || input.layer === "semantic" || input.layer === "skill_note") {
    const q = proposeWrite(db, {
      target: "memory",
      action: "add",
      subject: `${input.layer}:${contentHash.slice(0, 12)}`,
      payload: {
        layer: input.layer,
        body: input.body,
        title: input.title,
        stakes: input.layer === "working" ? "routine" : "routine",
        content_hash: contentHash,
        half_life_seconds: half,
      },
      origin: "foreground",
      authorFamily: "memory",
      reason: `remember ${input.layer}`,
    });
    if (q.status === "queued") {
      return { ok: true, status: "queued", writeId: q.writeId };
    }
    if (q.status === "applied_immediate") {
      // fall through to insert
    } else {
      return { ok: false, status: q.status, reason: "approval blocked" };
    }
  }

  const id = newId("mem");
  db.prepare(
    `INSERT INTO memory_item (
       id, layer, title, body, content_hash,
       source_kind, source_ref, snapshot_hash, belief_id,
       status, salience, half_life_seconds, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    id,
    input.layer,
    input.title ?? null,
    input.body,
    contentHash,
    input.sourceKind ?? "human",
    input.sourceRef ?? null,
    input.snapshotHash ?? contentHash,
    input.beliefId ?? null,
    input.salience ?? 0.5,
    half,
    expiresAt,
  );

  appendAudit(db, {
    category: "ledger",
    action: "memory_write",
    actor: "system",
    detail: { id, layer: input.layer, content_hash: contentHash },
  });

  return { ok: true, id, status: "active" };
}

export function listMemory(
  db: DatabaseSync,
  opts: { layer?: MemoryLayer; status?: string; limit?: number } = {},
): MemoryItem[] {
  const status = opts.status ?? "active";
  const limit = opts.limit ?? 50;
  if (opts.layer) {
    return db
      .prepare(
        `SELECT id, layer, title, body, content_hash AS contentHash,
                status, salience, expires_at AS expiresAt
         FROM memory_item WHERE layer = ? AND status = ?
         ORDER BY salience DESC, created_at DESC LIMIT ?`,
      )
      .all(opts.layer, status, limit) as MemoryItem[];
  }
  return db
    .prepare(
      `SELECT id, layer, title, body, content_hash AS contentHash,
              status, salience, expires_at AS expiresAt
       FROM memory_item WHERE status = ?
       ORDER BY layer, salience DESC LIMIT ?`,
    )
    .all(status, limit) as MemoryItem[];
}

export function touchMemory(db: DatabaseSync, id: string): void {
  db.prepare(
    `UPDATE memory_item
     SET access_count = access_count + 1,
         last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         salience = MIN(1.0, salience + 0.05)
     WHERE id = ? AND status = 'active'`,
  ).run(id);
}

export interface ForgetReport {
  scanned: number;
  decayed: number;
  forgotten: number;
  ids: string[];
}

/**
 * Active forgetting: past expires_at → decayed (working/episodic)
 * or forgotten if salience low. Semantic never auto-forgotten here.
 */
export function runMemoryDecay(db: DatabaseSync, now = new Date()): ForgetReport {
  const iso = now.toISOString();
  const due = db
    .prepare(
      `SELECT id, layer, salience FROM memory_item
       WHERE status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at <= ?`,
    )
    .all(iso) as { id: string; layer: string; salience: number }[];

  let decayed = 0;
  let forgotten = 0;
  const ids: string[] = [];

  for (const row of due) {
    if (row.layer === "semantic" || row.layer === "skill_note") {
      // durable layers: only flag decayed for harvest, don't auto-forget
      db.prepare(
        `UPDATE memory_item SET status = 'decayed', updated_at = ? WHERE id = ?`,
      ).run(iso, row.id);
      decayed++;
    } else if (row.salience < 0.3) {
      db.prepare(
        `UPDATE memory_item
         SET status = 'forgotten', forgotten_at = ?, forget_reason = 'half_life_low_salience', updated_at = ?
         WHERE id = ?`,
      ).run(iso, iso, row.id);
      forgotten++;
    } else {
      db.prepare(
        `UPDATE memory_item SET status = 'decayed', updated_at = ? WHERE id = ?`,
      ).run(iso, row.id);
      decayed++;
    }
    ids.push(row.id);
    appendAudit(db, {
      category: "ledger",
      action: "memory_decay",
      actor: "system",
      detail: { id: row.id, layer: row.layer },
    });
  }

  return { scanned: due.length, decayed, forgotten, ids };
}

export interface DreamProposal {
  id: string;
  kind: string;
  memoryId: string | null;
  rationale: string;
  status: string;
}

/**
 * Dream cycle v0: scan memory, emit proposals only.
 * Never applies — human harvest / approve required.
 */
export function runDreamCycle(db: DatabaseSync): {
  proposals: DreamProposal[];
  spendId: string;
} {
  const proposals: DreamProposal[] = [];

  // 1) Promote high-salience episodic → semantic (proposal only)
  const episodic = db
    .prepare(
      `SELECT id, body, title, salience FROM memory_item
       WHERE layer = 'episodic' AND status = 'active' AND salience >= 0.7
       ORDER BY salience DESC LIMIT 10`,
    )
    .all() as { id: string; body: string; title: string | null; salience: number }[];

  for (const e of episodic) {
    const id = newId("mpr");
    const rationale = `High salience episodic (${e.salience.toFixed(2)}) candidate for semantic promotion`;
    db.prepare(
      `INSERT INTO memory_proposal (
         id, kind, memory_id, from_layer, to_layer, rationale, status
       ) VALUES (?, 'promote', ?, 'episodic', 'semantic', ?, 'pending')`,
    ).run(id, e.id, rationale);

    // Also queue as pending_write for visibility in approval queue
    const q = proposeWrite(db, {
      target: "memory",
      action: "edit",
      subject: e.id,
      payload: {
        stakes: "routine",
        dream: true,
        kind: "promote",
        to_layer: "semantic",
        body: e.body,
      },
      origin: "dream",
      authorFamily: "dream",
      reason: rationale,
    });
    if (q.status === "queued") {
      db.prepare(
        `UPDATE memory_proposal SET pending_write_id = ? WHERE id = ?`,
      ).run(q.writeId, id);
    }

    proposals.push({
      id,
      kind: "promote",
      memoryId: e.id,
      rationale,
      status: "pending",
    });
  }

  // 2) Forget decayed working items with very low salience
  const decayed = db
    .prepare(
      `SELECT id, body FROM memory_item
       WHERE layer = 'working' AND status = 'decayed' AND salience < 0.2
       LIMIT 10`,
    )
    .all() as { id: string; body: string }[];

  for (const d of decayed) {
    const id = newId("mpr");
    const rationale = "Decayed working memory with low salience — propose forget";
    db.prepare(
      `INSERT INTO memory_proposal (
         id, kind, memory_id, from_layer, to_layer, rationale, status
       ) VALUES (?, 'forget', ?, 'working', NULL, ?, 'pending')`,
    ).run(id, d.id, rationale);
    proposals.push({
      id,
      kind: "forget",
      memoryId: d.id,
      rationale,
      status: "pending",
    });
  }

  // 3) Harvest flag: pending_harvest items
  const harvest = db
    .prepare(
      `SELECT id FROM memory_item WHERE status = 'pending_harvest' LIMIT 10`,
    )
    .all() as { id: string }[];
  for (const h of harvest) {
    const id = newId("mpr");
    db.prepare(
      `INSERT INTO memory_proposal (
         id, kind, memory_id, rationale, status
       ) VALUES (?, 'harvest', ?, 'Human harvest requested', 'pending')`,
    ).run(id, h.id);
    proposals.push({
      id,
      kind: "harvest",
      memoryId: h.id,
      rationale: "Human harvest requested",
      status: "pending",
    });
  }

  const spendId = recordSpend(db, {
    channel: "dream",
    model: "dream-v0",
    modelFamily: "local",
    inputTokens: proposals.length * 20,
    outputTokens: proposals.length * 10,
    costUsd: 0.0001 * Math.max(1, proposals.length),
    detail: { proposals: proposals.length },
  });

  appendAudit(db, {
    category: "system",
    action: "dream_cycle",
    actor: "system",
    detail: { count: proposals.length, spendId },
  });

  return { proposals, spendId };
}

/** Accept a memory proposal (human). Applies layer change / forget. */
export function resolveMemoryProposal(
  db: DatabaseSync,
  proposalId: string,
  decision: "accepted" | "rejected",
  by = "human",
): boolean {
  const row = db
    .prepare(
      `SELECT id, kind, memory_id, to_layer, status FROM memory_proposal WHERE id = ?`,
    )
    .get(proposalId) as
    | {
        id: string;
        kind: string;
        memory_id: string | null;
        to_layer: string | null;
        status: string;
      }
    | undefined;
  if (!row || row.status !== "pending") return false;

  if (decision === "rejected") {
    db.prepare(
      `UPDATE memory_proposal
       SET status = 'rejected', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by = ?
       WHERE id = ?`,
    ).run(by, proposalId);
    return true;
  }

  if (row.memory_id && row.kind === "promote" && row.to_layer) {
    db.prepare(
      `UPDATE memory_item SET layer = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    ).run(row.to_layer, row.memory_id);
  }
  if (row.memory_id && row.kind === "forget") {
    db.prepare(
      `UPDATE memory_item
       SET status = 'forgotten', forgotten_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           forget_reason = 'proposal_accepted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    ).run(row.memory_id);
  }

  db.prepare(
    `UPDATE memory_proposal
     SET status = 'accepted', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by = ?
     WHERE id = ?`,
  ).run(by, proposalId);
  return true;
}

export function listMemoryProposals(
  db: DatabaseSync,
  status = "pending",
): DreamProposal[] {
  return db
    .prepare(
      `SELECT id, kind, memory_id AS memoryId, rationale, status
       FROM memory_proposal WHERE status = ? ORDER BY created_at DESC LIMIT 50`,
    )
    .all(status) as DreamProposal[];
}
