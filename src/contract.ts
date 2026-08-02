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
import { sha256 } from "./hash.ts";
import type { SourceRef } from "./types.ts";

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
  status: "ALLOWED" | "REFUSED" | "APORIA" | "DEBT";
  reason?: string;
  beliefId?: string;
  debtIds?: string[];
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
    /** If true, assertions with zero sources are REFUSED (not merely debt-minted) */
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
    };
  }

  if (claim.kind === "assertion") {
    if (opts.strict && sources.length === 0) {
      return {
        ok: false,
        status: "REFUSED",
        reason:
          "completion contract: load-bearing assertion lacks source pins (strict)",
      };
    }
    const r = commitBelief(db, {
      type: "belief",
      text: claim.text,
      sources,
      authorFamily: opts.authorFamily ?? "contract",
      sessionId: opts.sessionId,
      path: "deep",
      turnId: opts.turnId,
    });
    if (!r.ok) {
      return {
        ok: false,
        status: "REFUSED",
        reason: r.reason,
        debtIds: r.debtIds,
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
      };
    }
    return { ok: true, status: "ALLOWED", beliefId: r.beliefId };
  }

  // observation — prefer transcript pin when possible
  const obsSources =
    sources.length > 0
      ? sources
      : [
          {
            kind: "transcript" as const,
            refId: opts.turnId ?? "contract",
            snapshotHash: sha256(claim.text),
          },
        ];
  const r = commitBelief(db, {
    type: "observation",
    text: claim.text,
    sources: obsSources,
    authorFamily: opts.authorFamily ?? "contract",
    sessionId: opts.sessionId,
    path: "fast",
    turnId: opts.turnId,
  });
  return {
    ok: r.ok,
    status: r.ok ? "ALLOWED" : "REFUSED",
    reason: r.reason,
    beliefId: r.beliefId,
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
