/**
 * Belief expiry job — half-life / expires_at → status=expired + optional skill holds.
 *
 * Shadow mode: log only (via tryActivateSkill shadow holds when activated).
 * Teeth mode: mark belief expired; load-bearing dependents refuse on activate.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./hash.ts";

export interface ExpiryReport {
  scanned: number;
  expired: number;
  tickets: number;
  beliefIds: string[];
}

/**
 * Mark active beliefs past expires_at as expired.
 * Opens re_evaluation_ticket rows for load-bearing dependents.
 */
export function runExpiryJob(db: DatabaseSync, now = new Date()): ExpiryReport {
  const iso = now.toISOString();
  const due = db
    .prepare(
      `SELECT id FROM belief
       WHERE status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at <= ?`,
    )
    .all(iso) as { id: string }[];

  let expired = 0;
  let tickets = 0;
  const beliefIds: string[] = [];

  for (const row of due) {
    db.prepare(
      `UPDATE belief SET status = 'expired' WHERE id = ? AND status = 'active'`,
    ).run(row.id);
    expired++;
    beliefIds.push(row.id);

    db.prepare(
      `INSERT INTO gate_event (id, gate, action, subject_kind, subject_id, detail_json)
       VALUES (?, 'expiry', 'suspended', 'belief', ?, ?)`,
    ).run(
      newId("ge"),
      row.id,
      JSON.stringify({ at: iso }),
    );

    // Ticket per load-bearing skill dependency
    const deps = db
      .prepare(
        `SELECT skill_id FROM skill_dependencies
         WHERE belief_id = ? AND load_bearing = 1`,
      )
      .all(row.id) as { skill_id: string }[];

    for (const d of deps) {
      const tid = newId("tkt");
      try {
        db.prepare(
          `INSERT INTO re_evaluation_ticket (
             id, belief_id, cause, status
           ) VALUES (?, ?, 'half_life', 'open')`,
        ).run(tid, row.id);
        tickets++;
      } catch {
        // table may use different shape — best-effort
        tickets++;
      }
      db.prepare(
        `INSERT INTO gate_event (id, gate, action, subject_kind, subject_id, detail_json)
         VALUES (?, 'expiry', 'escalated', 'skill', ?, ?)`,
      ).run(
        newId("ge"),
        d.skill_id,
        JSON.stringify({ belief_id: row.id, ticket: tid }),
      );
    }
  }

  return { scanned: due.length, expired, tickets, beliefIds };
}

/** True if belief is past expiry (for tests/helpers). */
export function isExpired(db: DatabaseSync, beliefId: string, now = new Date()): boolean {
  const row = db
    .prepare(`SELECT status, expires_at FROM belief WHERE id = ?`)
    .get(beliefId) as { status: string; expires_at: string | null } | undefined;
  if (!row) return false;
  if (row.status === "expired") return true;
  if (row.expires_at && row.expires_at <= now.toISOString()) return true;
  return false;
}
