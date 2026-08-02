/**
 * commit_belief() — transactional belief gate (Chamber week-1).
 *
 * Law:
 * - Gate check + write = one transaction (FM-6)
 * - Debt mint lives HERE, not in the router (FM-4)
 * - Assertion types (belief, commitment) block on open blocking debts
 * - defeater | unknown never mint blocking debt (FM-5)
 * - Defeaters cannot be used as citable sources
 * - claim_hash upsert + debt inheritance across revision_of
 */

import type { DatabaseSync } from "node:sqlite";
import { claimHash, newId } from "./hash.ts";
import type { CommitBeliefInput, CommitResult, EpistemicType } from "./types.ts";

const ASSERTION: ReadonlySet<EpistemicType> = new Set(["belief", "commitment"]);
const RETRACTION: ReadonlySet<EpistemicType> = new Set(["defeater", "unknown"]);

function emitGate(
  db: DatabaseSync,
  row: {
    turnId?: string;
    gate: string;
    action: string;
    subjectKind?: string;
    subjectId?: string;
    detail?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO gate_event (id, turn_id, gate, action, subject_kind, subject_id, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId("ge"),
    row.turnId ?? null,
    row.gate,
    row.action,
    row.subjectKind ?? null,
    row.subjectId ?? null,
    row.detail ? JSON.stringify(row.detail) : null,
  );
}

function openBlockingDebts(
  db: DatabaseSync,
  claimHashValue: string,
): { id: string }[] {
  return db
    .prepare(
      `SELECT id FROM citation_debt
       WHERE claim_hash = ?
         AND blocking = 1
         AND status IN ('pending','proposed_paid')`,
    )
    .all(claimHashValue) as { id: string }[];
}

function inheritDebtsAlongChain(
  db: DatabaseSync,
  startBeliefId: string | null,
): { id: string }[] {
  if (!startBeliefId) return [];
  // Walk revision_of chain and collect open blocking debts on those claim_hashes
  const debts: { id: string }[] = [];
  let current: string | null = startBeliefId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const row = db
      .prepare(`SELECT claim_hash, revision_of FROM belief WHERE id = ?`)
      .get(current) as { claim_hash: string; revision_of: string | null } | undefined;
    if (!row) break;
    debts.push(...openBlockingDebts(db, row.claim_hash));
    current = row.revision_of;
  }
  return debts;
}

export function commitBelief(
  db: DatabaseSync,
  input: CommitBeliefInput,
): CommitResult {
  const {
    type,
    text,
    sources,
    authorFamily,
    sessionId,
    revisionOf = null,
    stakes = "routine",
    path,
    halfLifeSeconds,
    turnId,
  } = input;

  // ── PRE (outside TX is fine for pure validation; TX still fail-closed) ──
  if (path === "fast" && ASSERTION.has(type)) {
    return {
      ok: false,
      status: "REJECTED",
      reason: "fast path may only commit observation|inference; belief-typed commit must escalate",
    };
  }

  for (const s of sources) {
    if (!s.snapshotHash) {
      return { ok: false, status: "REJECTED", reason: "source missing snapshot_hash pin" };
    }
    if (s.kind === "belief") {
      // source kind belief is ok; but epistemic_type defeater as *evidence* is not —
      // callers must not pass defeater rows as sources. Enforce via ref lookup below in TX.
    }
  }

  const hash = claimHash(type, text);
  const beliefId = newId("blf");
  const expiresAt =
    halfLifeSeconds && halfLifeSeconds > 0
      ? new Date(Date.now() + halfLifeSeconds * 1000).toISOString()
      : null;

  try {
    db.exec("BEGIN IMMEDIATE");

    // Parent lock if revising
    if (revisionOf) {
      const parent = db
        .prepare(`SELECT id FROM belief WHERE id = ?`)
        .get(revisionOf);
      if (!parent) {
        db.exec("ROLLBACK");
        return { ok: false, status: "REJECTED", reason: "revision_of parent not found" };
      }
    }

    // Reject defeater-typed beliefs used as sources (FM-5 rider)
    for (const s of sources) {
      if (s.kind === "belief") {
        const srcBel = db
          .prepare(`SELECT epistemic_type FROM belief WHERE id = ?`)
          .get(s.refId) as { epistemic_type: string } | undefined;
        if (srcBel?.epistemic_type === "defeater") {
          db.exec("ROLLBACK");
          emitGate(db, {
            turnId,
            gate: "commit",
            action: "blocked",
            detail: { reason: "defeater_cannot_source" },
          });
          return {
            ok: false,
            status: "REJECTED",
            reason: "defeaters cannot be cited as sources (FM-5)",
          };
        }
      }
    }

    // Open blocking debts on this claim_hash + inherited from revision chain
    const directDebts = openBlockingDebts(db, hash);
    const inherited = inheritDebtsAlongChain(db, revisionOf);
    const blocking = [...directDebts, ...inherited];
    const blockingIds = [...new Set(blocking.map((d) => d.id))];

    if (ASSERTION.has(type) && blockingIds.length > 0) {
      emitGate(db, {
        turnId,
        gate: "debt",
        action: "blocked",
        subjectKind: "claim_hash",
        subjectId: hash,
        detail: { debtIds: blockingIds },
      });
      db.exec("ROLLBACK");
      // audit row in separate implicit autocommit after rollback
      try {
        emitGate(db, {
          turnId,
          gate: "commit",
          action: "blocked",
          subjectKind: "claim_hash",
          subjectId: hash,
          detail: { debtIds: blockingIds },
        });
      } catch {
        /* best-effort */
      }
      return {
        ok: false,
        status: "REJECTED",
        reason: "open blocking citation debt",
        debtIds: blockingIds,
      };
    }

    // Insert belief
    db.prepare(
      `INSERT INTO belief (
         id, content, epistemic_type, claim_hash, half_life_seconds, expires_at,
         revision_of, committed_path, stakes, status, author_family, session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      beliefId,
      text,
      type,
      hash,
      halfLifeSeconds ?? null,
      expiresAt,
      revisionOf,
      path,
      stakes,
      authorFamily,
      sessionId ?? null,
    );

    // Sources
    const insSrc = db.prepare(
      `INSERT INTO belief_source (
         id, belief_id, kind, ref_id, snapshot_hash, span_hash, context_hash,
         provenance, pays_subclaim, retriever_family
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of sources) {
      insSrc.run(
        newId("src"),
        beliefId,
        s.kind,
        s.refId,
        s.snapshotHash,
        s.spanHash ?? null,
        s.contextHash ?? null,
        s.provenance ?? null,
        s.paysSubclaim ?? null,
        s.retrieverFamily ?? null,
      );
    }

    // Mint debts for assertion gaps (FM-4: inside this TX)
    // v1 heuristic: if assertion and sources empty → one blocking debt on full claim
    if (ASSERTION.has(type) && sources.length === 0) {
      const debtId = newId("dbt");
      db.prepare(
        `INSERT INTO citation_debt (
           id, claim_hash, belief_id, claim_text, subclaim, blocking, status
         ) VALUES (?, ?, ?, ?, NULL, 1, 'pending')
         ON CONFLICT(claim_hash, subclaim) DO UPDATE SET
           belief_id = excluded.belief_id,
           status = CASE
             WHEN citation_debt.status IN ('paid','waived') THEN citation_debt.status
             ELSE 'pending'
           END`,
      ).run(debtId, hash, beliefId, text);

      // If conflict path didn't insert our id, still event on claim
      emitGate(db, {
        turnId,
        gate: "debt",
        action: "minted",
        subjectKind: "belief",
        subjectId: beliefId,
        detail: { claim_hash: hash },
      });
    }

    // Move inherited debt rows onto this belief id (debt follows claim)
    for (const d of inherited) {
      db.prepare(`UPDATE citation_debt SET belief_id = ? WHERE id = ?`).run(
        beliefId,
        d.id,
      );
    }

    // Retraction types: mint nothing, block nothing (FM-5)
    if (RETRACTION.has(type)) {
      emitGate(db, {
        turnId,
        gate: "commit",
        action: "passed",
        subjectKind: "belief",
        subjectId: beliefId,
        detail: { type, note: "retraction_path" },
      });
    } else {
      emitGate(db, {
        turnId,
        gate: "commit",
        action: "passed",
        subjectKind: "belief",
        subjectId: beliefId,
        detail: { type, claim_hash: hash },
      });
    }

    // M6: never allow belief-typed rows on fast path (already rejected in PRE;
    // double-check invariant inside TX)
    if (type === "belief" && path === "fast") {
      db.exec("ROLLBACK");
      return {
        ok: false,
        status: "REJECTED",
        reason: "invariant: epistemic_type=belief cannot use committed_path=fast",
      };
    }

    db.exec("COMMIT");
    return { ok: true, beliefId };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    try {
      emitGate(db, {
        turnId,
        gate: "commit",
        action: "failed_closed",
        detail: { error: String(err) },
      });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      status: "PARKED",
      reason: `commit failed closed: ${String(err)}`,
    };
  }
}
