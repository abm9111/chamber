/**
 * Citation debt payment from retrieval.
 *
 * Flow:
 *   open debts → search corpus → propose source pins → mark proposed_paid | paid
 *
 * Never auto-pays from embedding similarity alone without content pin + human/epistemology
 * when stakes are consequential (anti-feature: vector proximity ≠ warrant).
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./hash.ts";
import { searchVector, type VectorHit } from "./vector.ts";
import { searchCode } from "./code_index.ts";

export interface OpenDebt {
  id: string;
  claimHash: string;
  beliefId: string | null;
  claimText: string;
  status: string;
  blocking: number;
}

export function listOpenDebts(db: DatabaseSync, limit = 20): OpenDebt[] {
  return db
    .prepare(
      `SELECT id, claim_hash AS claimHash, belief_id AS beliefId,
              claim_text AS claimText, status, blocking
       FROM citation_debt
       WHERE status IN ('pending','proposed_paid') AND blocking = 1
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(limit) as OpenDebt[];
}

export interface DebtPaymentProposal {
  debtId: string;
  claimText: string;
  hits: VectorHit[];
  status: "proposed_paid" | "insufficient" | "paid";
  reason: string;
}

/**
 * Propose payment for one debt using vector/code search.
 * Default: mark proposed_paid (needs human/epistemology to promote to paid)
 * unless CHAMBER_AUTO_PAY_DEBT=1 and best score >= threshold.
 */
export function proposeDebtPayment(
  db: DatabaseSync,
  debtId: string,
  opts: {
    k?: number;
    minScore?: number;
    autoPay?: boolean;
    useCode?: boolean;
  } = {},
): DebtPaymentProposal {
  const debt = db
    .prepare(
      `SELECT id, claim_hash, belief_id, claim_text, status, blocking
       FROM citation_debt WHERE id = ?`,
    )
    .get(debtId) as
    | {
        id: string;
        claim_hash: string;
        belief_id: string | null;
        claim_text: string;
        status: string;
        blocking: number;
      }
    | undefined;

  if (!debt) {
    return {
      debtId,
      claimText: "",
      hits: [],
      status: "insufficient",
      reason: "debt not found",
    };
  }

  const k = opts.k ?? 5;
  const minScore = opts.minScore ?? 0.15;
  let hits = searchVector(db, debt.claim_text, {
    k,
    minScore,
    model: "local-hash-v1",
  });
  if (opts.useCode !== false) {
    const codeHits = searchCode(db, debt.claim_text, { k: 3 });
    const seen = new Set(hits.map((h) => h.documentId));
    for (const h of codeHits) {
      if (!seen.has(h.documentId) && h.score >= minScore * 0.8) {
        hits.push(h);
      }
    }
    hits.sort((a, b) => b.score - a.score);
    hits = hits.slice(0, k);
  }

  if (hits.length === 0) {
    return {
      debtId,
      claimText: debt.claim_text,
      hits: [],
      status: "insufficient",
      reason: "no retrieval hits above threshold",
    };
  }

  const best = hits[0]!;
  // Attach proposed sources to belief if present
  if (debt.belief_id) {
    for (const h of hits.slice(0, 3)) {
      const srcId = newId("src");
      try {
        db.prepare(
          `INSERT INTO belief_source (
             id, belief_id, kind, ref_id, snapshot_hash, provenance, pays_subclaim, retriever_family
           ) VALUES (?, ?, ?, ?, ?, 'vector', ?, ?)`,
        ).run(
          srcId,
          debt.belief_id,
          h.sourceKind === "x_tweet" ? "x_tweet" : "vault_page",
          h.sourceRef ?? h.documentId,
          h.snapshotHash,
          debt.id,
          "chamber-vector",
        );
      } catch {
        /* duplicate or FK — skip */
      }
    }
  }

  const auto =
    opts.autoPay === true || process.env.CHAMBER_AUTO_PAY_DEBT === "1";
  const strong = best.score >= 0.35;

  if (auto && strong) {
    db.prepare(
      `UPDATE citation_debt
       SET status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    ).run(debt.id);
    db.prepare(
      `INSERT INTO gate_event (id, gate, action, subject_kind, subject_id, detail_json)
       VALUES (?, 'debt', 'passed', 'debt', ?, ?)`,
    ).run(
      newId("ge"),
      debt.id,
      JSON.stringify({
        mode: "auto_pay",
        score: best.score,
        doc: best.documentId,
      }),
    );
    return {
      debtId: debt.id,
      claimText: debt.claim_text,
      hits,
      status: "paid",
      reason: `auto-paid via ${best.title ?? best.documentId} score=${best.score.toFixed(3)}`,
    };
  }

  db.prepare(
    `UPDATE citation_debt SET status = 'proposed_paid' WHERE id = ? AND status = 'pending'`,
  ).run(debt.id);
  db.prepare(
    `INSERT INTO gate_event (id, gate, action, subject_kind, subject_id, detail_json)
     VALUES (?, 'debt', 'escalated', 'debt', ?, ?)`,
  ).run(
    newId("ge"),
    debt.id,
    JSON.stringify({
      mode: "proposed",
      score: best.score,
      doc: best.documentId,
    }),
  );

  return {
    debtId: debt.id,
    claimText: debt.claim_text,
    hits,
    status: "proposed_paid",
    reason: `proposed ${hits.length} source(s); best=${best.score.toFixed(3)} — human/epistemology to confirm paid`,
  };
}

/** Human/epistemology confirms payment. */
export function confirmDebtPaid(
  db: DatabaseSync,
  debtId: string,
  by: "human" | "epistemology" = "human",
): boolean {
  const r = db
    .prepare(
      `UPDATE citation_debt
       SET status = 'paid',
           paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           waived_by = NULL
       WHERE id = ? AND status IN ('pending','proposed_paid')`,
    )
    .run(debtId);
  if (Number(r.changes ?? 0) < 1) return false;
  db.prepare(
    `INSERT INTO gate_event (id, gate, action, subject_kind, subject_id, detail_json)
     VALUES (?, 'debt', 'passed', 'debt', ?, ?)`,
  ).run(newId("ge"), debtId, JSON.stringify({ confirmed_by: by }));
  return true;
}

/** Propose payment for all open pending debts. */
export function proposeAllDebtPayments(
  db: DatabaseSync,
  opts?: Parameters<typeof proposeDebtPayment>[2],
): DebtPaymentProposal[] {
  const open = listOpenDebts(db, 50).filter((d) => d.status === "pending");
  return open.map((d) => proposeDebtPayment(db, d.id, opts));
}
