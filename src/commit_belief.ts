/**
 * commit_belief() — transactional belief gate (Chamber week-1).
 *
 * Law:
 * - Gate check + write = one transaction (FM-6)
 * - Debt mint lives HERE, not in the router (FM-4)
 * - Assertion types (belief, commitment) block on open blocking debts
 * - defeater | unknown never mint blocking debt (FM-5)
 * - Defeaters cannot be used as citable sources
 * - Every corpus citation is verified against the local corpus before it counts
 *   as support; an unverifiable pin is a gap, not evidence
 * - A belief cited as a source must reference a belief row that exists; a pin
 *   with no formula is still not a pin with no check
 * - claim_hash upsert + debt inheritance across revision_of
 */

import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "./audit.ts";
import { claimHash, newId } from "./hash.ts";
import { verifyPin, type BeliefSourceFailure } from "./pins.ts";
import type {
  CommitBeliefInput,
  CommitResult,
  EpistemicType,
  SourceRef,
} from "./types.ts";

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

  // The same decision, into the hash-chained log.
  //
  // `gate_event` is an ordinary table: no prev_hash, no Merkle leaf, nothing
  // that makes an edit detectable. Until this line, the belief gate — the
  // decision this whole system exists to make — wrote only there, while
  // sixteen other modules wrote to the chained `audit_event`. Measured by
  // probes/gate_audit.ts on a live database: 4 gate_event rows, 0 audit_event
  // rows. The strongest claim Chamber makes, tamper-evident audit, covered the
  // bookkeeping around the verdicts and not the verdicts.
  //
  // `appendAudit` rather than `appendAuditInTx` because `emitGate` is called
  // from three different transaction contexts in this file: inside the
  // BEGIN IMMEDIATE, after a ROLLBACK, and before any transaction opens.
  // appendAudit tries BEGIN IMMEDIATE and falls back to the caller's
  // transaction when one is already open, so it is correct in all three.
  //
  // `gate_event` stays as the queryable projection; this is a mirror, not a
  // move, so nothing that reads it changes. A call inside a transaction that
  // later rolls back loses both rows together, which is the existing
  // behaviour of gate_event and keeps the two tables telling one story.
  appendAudit(db, {
    category: "gate",
    action: `${row.gate}:${row.action}`,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    turnId: row.turnId,
    detail: { gate: row.gate, decision: row.action, ...(row.detail ?? {}) },
  });
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
    requireVerifiedSupport = false,
  } = input;

  // ── PRE (outside TX is fine for pure validation; TX still fail-closed) ──
  if (path === "fast" && ASSERTION.has(type)) {
    return {
      ok: false,
      status: "REJECTED",
      reason: "fast path may only commit observation|inference; belief-typed commit must escalate",
    };
  }

  // ── PIN VERIFICATION ───────────────────────────────────────────────────────
  // A non-empty snapshotHash used to be the whole citation gate, so a
  // fabricated pin — a hash of a string that was never stored — committed a
  // consequential claim clean with zero debt (probes/pin_bypass.ts). Each pin
  // is now recomputed from the local corpus, and only what survives counts as
  // support: `verifiedSources`, not `sources`, is what gets written to
  // belief_source and what the debt condition is measured against.
  //
  // Filled inside the transaction below, not here. The old check was pure
  // validation and safe outside it; verifying a pin is a corpus *read*, and
  // FM-6 says the check and the write it authorises are one transaction —
  // otherwise a concurrent writer (the repo ships separate server, jobs and
  // gateway units against one DB) can edit the document between the read and
  // the BEGIN, and support gets written against a body that no longer matches.
  // It also has to be inside the try: an unexpected throw out here would
  // unwind the caller instead of failing closed to PARKED, which is exactly
  // what src/pins.ts assumes it is protected from.
  const verifiedSources: SourceRef[] = [];
  /**
   * Why a citation was refused. `belief`-kind sources are checked for
   * existence rather than by formula, so their failure is not one verifyPin
   * can return and gets its own reason — a caller must be able to tell a
   * corpus row that drifted from an internal edge that points at nothing.
   */
  const rejectedSources: {
    refId: string;
    reason: BeliefSourceFailure;
  }[] = [];

  /**
   * Attach the rejection list to any verdict this call returns. A dropped
   * citation is not always fatal — a claim with other surviving support still
   * commits — so silence would leave the caller unable to tell a confabulated
   * pin from one that was simply never offered.
   */
  const withRejected = <T extends CommitResult>(result: T): T =>
    rejectedSources.length > 0 ? { ...result, rejectedSources } : result;

  const hash = claimHash(type, text);
  const beliefId = newId("blf");
  const expiresAt =
    halfLifeSeconds && halfLifeSeconds > 0
      ? new Date(Date.now() + halfLifeSeconds * 1000).toISOString()
      : null;

  try {
    db.exec("BEGIN IMMEDIATE");

    /**
     * Belief rows named by `belief`-kind citations, read at most once each.
     * Two separate rules need this row — the existence check in the loop
     * below and the FM-5 defeater rider further down — and they must agree on
     * what they saw, so they share one lookup and one cache rather than
     * issuing the same SELECT twice against a corpus another unit may be
     * writing to. `undefined` is a cached answer ("no such belief"), which is
     * why membership is tested with `has`, not truthiness.
     */
    type CitedBelief = { epistemic_type: string } | undefined;
    const citedBeliefs = new Map<string, CitedBelief>();
    const citedBelief = (refId: string): CitedBelief => {
      if (!citedBeliefs.has(refId)) {
        citedBeliefs.set(
          refId,
          db
            .prepare(`SELECT epistemic_type FROM belief WHERE id = ?`)
            .get(refId) as CitedBelief,
        );
      }
      return citedBeliefs.get(refId);
    };

    for (const s of sources) {
      if (!s.snapshotHash) {
        db.exec("ROLLBACK");
        // Shaped like the FM-5 refusal below: roll back first so the audit row
        // lands in autocommit and survives the unwind, then report through
        // `withRejected`. Returning bare discarded every rejection earlier
        // sources in this loop had already accumulated — the exact thing
        // withRejected exists to prevent — and emitted no gate event, so a
        // refusal that dropped citations left nothing in the audit trail.
        emitGate(db, {
          turnId,
          gate: "commit",
          action: "blocked",
          detail: { reason: "source_missing_pin", refId: s.refId },
        });
        return withRejected({
          ok: false,
          status: "REJECTED",
          reason: "source missing snapshot_hash pin",
        });
      }
      if (s.kind === "belief") {
        // A belief citing another belief is an internal edge, not a corpus
        // pin: there is no document to recompute a hash from, so verifyPin's
        // formula cannot apply. Existence still can, and must — `kind:
        // "belief"` on an invented id was probes/pin_bypass.ts one field value
        // away, committing a consequential claim clean with zero debt because
        // nothing was checked at all. An unverifiable pin never counts as
        // support: a source whose belief row does not exist is dropped like
        // any other, and the defeater rule below still judges the rest.
        if (citedBelief(s.refId)) verifiedSources.push(s);
        else rejectedSources.push({ refId: s.refId, reason: "belief_not_found" });
        continue;
      }
      const verdict = verifyPin(db, {
        kind: s.kind,
        refId: s.refId,
        snapshotHash: s.snapshotHash,
      });
      if (verdict.ok) verifiedSources.push(s);
      else rejectedSources.push({ refId: s.refId, reason: verdict.reason! });
    }

    // Parent lock if revising
    if (revisionOf) {
      const parent = db
        .prepare(`SELECT id FROM belief WHERE id = ?`)
        .get(revisionOf);
      if (!parent) {
        db.exec("ROLLBACK");
        return withRejected({
          ok: false,
          status: "REJECTED",
          reason: "revision_of parent not found",
        });
      }
    }

    // Reject defeater-typed beliefs used as sources (FM-5 rider).
    // Deliberately scans `sources`, not `verifiedSources`: this is a rejection
    // rule, so it must see everything the caller *claimed* to cite. The two
    // lists no longer agree on belief-kind entries — one that names no belief
    // row is dropped above — so reading the survivors would let a citation
    // escape this rule by failing an earlier one. Same rows as before, from
    // the cache the existence check already filled.
    for (const s of sources) {
      if (s.kind === "belief") {
        const srcBel = citedBelief(s.refId);
        if (srcBel?.epistemic_type === "defeater") {
          db.exec("ROLLBACK");
          emitGate(db, {
            turnId,
            gate: "commit",
            action: "blocked",
            detail: { reason: "defeater_cannot_source" },
          });
          return withRejected({
            ok: false,
            status: "REJECTED",
            reason: "defeaters cannot be cited as sources (FM-5)",
          });
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
      return withRejected({
        ok: false,
        status: "REJECTED",
        reason: "open blocking citation debt",
        debtIds: blockingIds,
      });
    }

    // ── STRICT: verified support is a precondition, not an IOU ──────────────
    // What `--strict` promises is that a consequential turn cannot answer on
    // nothing. The contract layer enforced that by counting the sources it was
    // *handed* (src/contract.ts), which is a count of citations, not of
    // support: an assertion citing one drifted vault_page arrived with a
    // non-empty list, lost it to hash_mismatch in the loop above, and committed
    // as DEBT — the identical zero-verified-support state that is correctly
    // REFUSED when nothing was cited at all. `verifiedSources` is the only
    // count that means anything here, and it exists only inside this gate,
    // which is why the decision has to be made in here rather than routed out.
    //
    // Refusing inside the transaction is what makes this a refusal rather than
    // a relabelling: no belief row, no belief_source row and no debt is
    // written, so a strict turn that could not be supported leaves the ledger
    // exactly as it found it. Debt is the non-strict answer and is minted
    // further down, unchanged.
    if (
      requireVerifiedSupport &&
      ASSERTION.has(type) &&
      verifiedSources.length === 0
    ) {
      db.exec("ROLLBACK");
      // After the rollback so the audit row lands in autocommit and survives
      // the unwind, matching the source_missing_pin refusal above.
      emitGate(db, {
        turnId,
        gate: "commit",
        action: "blocked",
        subjectKind: "claim_hash",
        subjectId: hash,
        detail: {
          reason: "no_verified_support_strict",
          cited: sources.length,
          rejectedSources,
        },
      });
      return withRejected({
        ok: false,
        status: "REJECTED",
        reason:
          sources.length === 0
            ? "completion contract: load-bearing assertion lacks source pins (strict)"
            : "completion contract: no cited source survived verification (strict)",
      });
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

    // Sources — only what verified. A belief_source row is the record of what
    // holds a claim up, so an unverifiable pin must never appear in it.
    const insSrc = db.prepare(
      `INSERT INTO belief_source (
         id, belief_id, kind, ref_id, snapshot_hash, span_hash, context_hash,
         provenance, pays_subclaim, retriever_family
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of verifiedSources) {
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

    // A dropped citation must leave a trace. Without this, a claim that cited
    // three things and kept one looks identical in the audit log to a claim
    // that cited one — the drop is only visible in the return value, which
    // nothing persists. Inside the TX, so it unwinds with a failed commit.
    if (rejectedSources.length > 0) {
      emitGate(db, {
        turnId,
        gate: "commit",
        action: "absent",
        subjectKind: "belief",
        subjectId: beliefId,
        detail: { rejectedSources },
      });
    }

    // Mint debts for assertion gaps (FM-4: inside this TX)
    // v1 heuristic: an assertion with no *verified* support → one blocking debt
    // on the full claim. Counting `sources` here is what let a fabricated pin
    // buy silence: a citation the corpus cannot confirm is a gap, not support.
    if (ASSERTION.has(type) && verifiedSources.length === 0) {
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
      return withRejected({
        ok: false,
        status: "REJECTED",
        reason: "invariant: epistemic_type=belief cannot use committed_path=fast",
      });
    }

    db.exec("COMMIT");
    return withRejected({ ok: true, beliefId });
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
    return withRejected({
      ok: false,
      status: "PARKED",
      reason: `commit failed closed: ${String(err)}`,
    });
  }
}
