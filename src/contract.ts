/**
 * Evidence-based completion contracts.
 *
 * Load-bearing claims in an assistant reply must either:
 *   - carry source pins (snapshot_hash), or
 *   - be marked APORIA / unknown, or
 *   - be blocked from commit as belief/commitment
 *
 * This module classifies claims and enforces the gate before commitBelief.
 */

import type { DatabaseSync } from "node:sqlite";
import { commitBelief } from "./commit_belief.ts";
import type { RejectedSource, SourceRef } from "./types.ts";

export type ClaimKind = "observation" | "assertion" | "aporia" | "chatter";

export interface ClassifiedClaim {
  kind: ClaimKind;
  text: string;
}

export interface ContractSource {
  kind: SourceRef["kind"];
  refId: string;
  snapshotHash: string;
  spanHash?: string;
  provenance?: SourceRef["provenance"];
}

export interface ContractResult {
  ok: boolean;
  /**
   * `UNSUPPORTED` is recorded-but-not-evidence: the claim is on the ledger and
   * nothing holds it up. It exists because `ALLOWED` was being printed for a
   * claim with zero `belief_source` rows — every citation it offered had been
   * dropped by the gate, and the drop was visible only in a `gate_event` with
   * `action='absent'` that no surface reads. A status that reads as an
   * endorsement is worse than a refusal, because nobody goes looking.
   */
  status: "ALLOWED" | "REFUSED" | "APORIA" | "DEBT" | "UNSUPPORTED";
  reason?: string;
  beliefId?: string;
  debtIds?: string[];
  /**
   * Citations the commit gate refused to count, and why. Carried on every
   * outcome including success: a claim can commit while some of its citations
   * are dropped, and without this field the caller has no way to render the
   * difference between "cited nothing" and "cited three things, kept none".
   */
  rejectedSources?: RejectedSource[];
}

/** Heuristic claim classifier — conservative on assertions. */
export function classifyClaims(reply: string): ClassifiedClaim[] {
  const lines = reply
    .split(/\n+/)
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  const out: ClassifiedClaim[] = [];
  for (const text of lines) {
    if (
      /\b(i don't know|unknown|uncertain|cannot verify|aporia|no evidence)\b/i.test(
        text,
      )
    ) {
      out.push({ kind: "aporia", text });
    } else if (
      /\b(you said|you asked|noted|acknowledged|queued|see spend)\b/i.test(text)
    ) {
      out.push({ kind: "chatter", text });
    } else if (
      /\b(is|are|was|were|will|must|always|never|fact:)\b/i.test(text) &&
      text.length > 20
    ) {
      out.push({ kind: "assertion", text });
    } else {
      out.push({ kind: "observation", text });
    }
  }
  return out.length ? out : [{ kind: "chatter", text: reply.slice(0, 200) }];
}

/** Citations the commit gate dropped, or undefined when it dropped none. */
function dropped(r: {
  rejectedSources?: RejectedSource[];
}): RejectedSource[] | undefined {
  return r.rejectedSources?.length ? r.rejectedSources : undefined;
}

/**
 * Enforce contract on a single claim before it can become load-bearing.
 * Assertions without sources → commitBelief still runs but mints debt / or refuse mode.
 */
export function enforceClaimContract(
  db: DatabaseSync,
  claim: ClassifiedClaim,
  opts: {
    sources?: ContractSource[];
    sessionId?: string;
    turnId?: string;
    authorFamily?: string;
    /**
     * If true, an assertion left with no *verified* support is REFUSED rather
     * than debt-minted. "No verified support" covers both citing nothing and
     * citing only pins the gate could not confirm — the two states are
     * indistinguishable in what actually holds the claim up, and only the
     * first was ever refused here.
     */
    strict?: boolean;
  } = {},
): ContractResult {
  const sources: SourceRef[] = (opts.sources ?? []).map((s) => ({
    kind: s.kind,
    refId: s.refId,
    snapshotHash: s.snapshotHash,
    spanHash: s.spanHash,
    provenance: s.provenance,
  }));

  if (claim.kind === "chatter") {
    return { ok: true, status: "ALLOWED", reason: "non-load-bearing chatter" };
  }

  if (claim.kind === "aporia") {
    const r = commitBelief(db, {
      type: "unknown",
      text: claim.text,
      sources: [],
      authorFamily: opts.authorFamily ?? "contract",
      sessionId: opts.sessionId,
      path: "deep",
      turnId: opts.turnId,
    });
    return {
      ok: r.ok,
      status: "APORIA",
      reason: r.reason ?? "recorded as unknown",
      beliefId: r.beliefId,
      rejectedSources: dropped(r),
    };
  }

  if (claim.kind === "assertion") {
    // Cited nothing: refusable without opening a transaction, because no
    // verification can change a count of zero.
    if (opts.strict && sources.length === 0) {
      return {
        ok: false,
        status: "REFUSED",
        reason:
          "completion contract: load-bearing assertion lacks source pins (strict)",
      };
    }
    // Cited something: whether any of it *survives* is not knowable out here.
    // This used to be the whole strict guard, and it is a count of citations
    // rather than of support — an assertion citing one drifted vault_page
    // passed it and came back DEBT, which is the same zero-verified-support
    // state the branch above refuses. `requireVerifiedSupport` moves that
    // decision inside the gate transaction, where the survivors are known and
    // where a refusal can still roll back rather than relabel a written row.
    const r = commitBelief(db, {
      type: "belief",
      text: claim.text,
      sources,
      authorFamily: opts.authorFamily ?? "contract",
      sessionId: opts.sessionId,
      path: "deep",
      turnId: opts.turnId,
      requireVerifiedSupport: opts.strict,
    });
    if (!r.ok) {
      return {
        ok: false,
        status: "REFUSED",
        reason: r.reason,
        debtIds: r.debtIds,
        rejectedSources: dropped(r),
      };
    }
    // Unsourced belief path mints debt inside commitBelief
    const debts = db
      .prepare(
        `SELECT id FROM citation_debt WHERE belief_id = ? AND status = 'pending'`,
      )
      .all(r.beliefId!) as { id: string }[];
    if (debts.length > 0) {
      return {
        ok: true,
        status: "DEBT",
        reason: "committed with open citation debt — not load-bearing until paid",
        beliefId: r.beliefId,
        debtIds: debts.map((d) => d.id),
        rejectedSources: dropped(r),
      };
    }
    return {
      ok: true,
      status: "ALLOWED",
      beliefId: r.beliefId,
      rejectedSources: dropped(r),
    };
  }

  // observation — commits with whatever verified support it was given, and
  // nothing else. It used to synthesise a `transcript` pin over its own text
  // when no source was offered, which is circular on its face: the model's own
  // output is not evidence for the model's own output. The gate saw through it
  // — `transcript` has no registered formula, so the pin was dropped as
  // kind_unregistered every single time — but it dropped it as an *error*,
  // filling the audit trail with rejection noise for a citation that was never
  // meant to hold. Offering nothing is honest; the status below is what says so.
  const r = commitBelief(db, {
    type: "observation",
    text: claim.text,
    sources,
    authorFamily: opts.authorFamily ?? "contract",
    sessionId: opts.sessionId,
    path: "fast",
    turnId: opts.turnId,
  });
  if (!r.ok) {
    return {
      ok: false,
      status: "REFUSED",
      reason: r.reason,
      rejectedSources: dropped(r),
    };
  }
  // An observation is not an assertion, so commitBelief mints no debt for it
  // and nothing else would have marked it. Without this the CLI printed a bare
  // `[ALLOWED]` over zero belief_source rows — a claim with no verified support
  // rendering as an endorsement.
  const verified = sources.length - (r.rejectedSources?.length ?? 0);
  if (verified > 0) {
    return {
      ok: true,
      status: "ALLOWED",
      beliefId: r.beliefId,
      rejectedSources: dropped(r),
    };
  }
  return {
    ok: true,
    status: "UNSUPPORTED",
    reason: "recorded with no verified source — not evidence for anything",
    beliefId: r.beliefId,
    rejectedSources: dropped(r),
  };
}

/** Scan assistant reply; enforce contract on each classified claim. */
export function enforceReplyContract(
  db: DatabaseSync,
  reply: string,
  opts: {
    sources?: ContractSource[];
    sessionId?: string;
    turnId?: string;
    strict?: boolean;
  } = {},
): { claims: ClassifiedClaim[]; results: ContractResult[] } {
  const claims = classifyClaims(reply);
  const results = claims.map((c) => enforceClaimContract(db, c, opts));
  return { claims, results };
}
