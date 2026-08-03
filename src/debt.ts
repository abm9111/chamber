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
import { verifyPin, isCitableSourceKind } from "./pins.ts";
import type { RejectedSource } from "./types.ts";

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
  /** Pins actually written to belief_source, in the order they were attached. */
  attached: string[];
  /** Hits that could not become pins, and why. */
  rejected: RejectedSource[];
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
    /**
     * Embedding space to query. Left unset, retrieval resolves the same "auto"
     * embedder `upsertDocument` defaults to — which is what `chamber ingest`
     * and `chamber ask` both write and read. This was hardcoded to
     * `local-hash-v1` while everything else resolved "auto" (→ minilm-l6-v2-q
     * whenever the ONNX model is on disk); `searchVector` filters on
     * `e.model = ?`, so every query landed in an empty space and every debt on
     * a real corpus came back "no retrieval hits above threshold". Debt is the
     * gate's only recoverable state — a claim blocked by debt stays blocked
     * until a pin pays it — so a dead payment path is a one-way door. Set it
     * explicitly only to force a space, e.g. for hermetic tests.
     */
    model?: string;
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
      attached: [],
      rejected: [],
    };
  }

  const k = opts.k ?? 5;
  const minScore = opts.minScore ?? 0.15;
  let hits = searchVector(db, debt.claim_text, {
    k,
    minScore,
    model: opts.model,
  });
  if (opts.useCode !== false) {
    // Deliberately *not* hybrid, unlike `ask` and `search`.
    //
    // Auto-pay below is a gate: it closes a debt with no human in the loop when
    // `best.score >= 0.35`, and that threshold is expressed on the cosine
    // scale. Hybrid retrieval reorders by a fused score while leaving `score`
    // as cosine, so the row landing at index 0 would no longer be the
    // highest-cosine row and a calibrated gate constant would silently start
    // meaning something else. Recalibrating an auto-pay threshold is its own
    // change with its own evidence; it is not a free rider on a retrieval fix.
    const codeHits = searchCode(db, debt.claim_text, {
      k: 3,
      model: opts.model,
      hybrid: false,
    });
    // The code corpus is written by indexCodeTree in its own default space
    // (local-hash-v1) regardless of what the vault corpus used, so scores from
    // the two legs are only strictly comparable when both resolve to the same
    // embedder. This list is a ranked *proposal* for a human to confirm, not a
    // gate verdict, so a merged order that is approximately right is
    // acceptable; nothing downstream treats the ordering as evidence.
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
      attached: [],
      rejected: [],
    };
  }

  const best = hits[0]!;
  // Attach proposed sources to belief if present.
  //
  // This is the second writer of belief_source; commitBelief is the first. It
  // used to bypass verifyPin entirely and write `ref_id = sourceRef ?? documentId`
  // under a kind it guessed from the hit — so a vault hit landed as
  // `ref_id = "notes/aed.md"`, and `chamber verify` (which re-checks every
  // stored pin *by document id*) reported `not_found` on a belief whose
  // evidence was perfectly healthy. An integrity check that cries wolf on good
  // data is worse than none: it trains its operator to ignore it.
  //
  // Both writers now agree on what a valid pin is, because both go through
  // verifyPin and both key on the document id.
  const attached: string[] = [];
  const rejected: RejectedSource[] = [];
  for (const h of hits.slice(0, 3)) {
    if (!isCitableSourceKind(h.sourceKind)) {
      rejected.push({ refId: h.documentId, reason: "kind_unregistered" });
      continue;
    }
    const verdict = verifyPin(db, {
      kind: h.sourceKind,
      refId: h.documentId,
      snapshotHash: h.snapshotHash,
    });
    if (!verdict.ok) {
      rejected.push({ refId: h.documentId, reason: verdict.reason! });
      continue;
    }
    // No belief to hang it on: the pin verified, but a belief_source row needs
    // a belief_id, so record it as proposed evidence and let the human see it.
    if (!debt.belief_id) {
      attached.push(h.documentId);
      continue;
    }
    try {
      db.prepare(
        `INSERT INTO belief_source (
           id, belief_id, kind, ref_id, snapshot_hash, provenance, pays_subclaim, retriever_family
         ) VALUES (?, ?, ?, ?, ?, 'vector', ?, ?)`,
      ).run(
        newId("src"),
        debt.belief_id,
        h.sourceKind,
        h.documentId,
        h.snapshotHash,
        debt.id,
        "chamber-vector",
      );
      attached.push(h.documentId);
    } catch (err) {
      // Duplicate or FK. Reported rather than swallowed: a pin that verified
      // and still did not land is exactly the state that made this bug
      // invisible for as long as it was.
      rejected.push({ refId: h.documentId, reason: `not_written: ${String(err)}` });
    }
  }

  const auto =
    opts.autoPay === true || process.env.CHAMBER_AUTO_PAY_DEBT === "1";
  const strong = best.score >= 0.35;

  // Auto-pay closes a debt without a human ever looking, so it must be backed
  // by a pin that verified — not merely by a similarity score. Retrieval
  // proximity is not warrant (see the module header); a debt marked `paid` with
  // zero stored evidence is the gate lying about itself.
  if (auto && strong && attached.length > 0) {
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
        pins: attached,
      }),
    );
    return {
      debtId: debt.id,
      claimText: debt.claim_text,
      hits,
      status: "paid",
      reason: `auto-paid via ${best.title ?? best.documentId} score=${best.score.toFixed(3)}`,
      attached,
      rejected,
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
      pins: attached,
      rejected,
    }),
  );

  return {
    debtId: debt.id,
    claimText: debt.claim_text,
    hits,
    status: "proposed_paid",
    reason:
      `proposed ${hits.length} source(s), ${attached.length} pinned` +
      `${rejected.length ? `, ${rejected.length} unpinnable` : ""}; ` +
      `best=${best.score.toFixed(3)} — human/epistemology to confirm paid`,
    attached,
    rejected,
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
