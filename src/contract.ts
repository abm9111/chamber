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
import { missingTerms } from "./claim_support.ts";
import { verifyPin } from "./pins.ts";
import type { RejectedSource, SourceRef } from "./types.ts";

export type ClaimKind = "observation" | "assertion" | "aporia" | "chatter" | "heading";

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
  status: "ALLOWED" | "REFUSED" | "APORIA" | "DEBT" | "UNSUPPORTED" | "HEADING";
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

const ASSERTION_VERB = /\b(is|are|was|were|will|must|always|never|fact:)\b/i;
/** The citation shape `citedIndices` reads (src/ask.ts). */
const CITATION = /\[\d{1,2}\]/;

/**
 * A line that organises an answer rather than saying anything: a markdown
 * heading, a line that is bold end to end, or a short label ending in a colon.
 *
 * Each was committed as an unsourced observation and printed `[UNSUPPORTED]`
 * — one ledger row of noise per heading, on every answer a model formats.
 *
 * The exclusions are what keep this from being a way around the gate. A line
 * with a citation is a claim about its source; a line with an assertion verb
 * is a claim. What is left can still be a fact in label form ("Kingroon
 * cheapest:"), so a heading is printed `[HEADING]` rather than dropped: it is
 * not recorded and not endorsed, and the reader can see it was neither.
 */
function isHeading(text: string): boolean {
  if (CITATION.test(text) || ASSERTION_VERB.test(text)) return false;
  if (/^#{1,6}\s+\S/.test(text)) return true;
  if (/^(\*\*|__)(?:(?!\1).)+\1:?$/.test(text)) return true;
  return text.length <= 80 && text.endsWith(":");
}

/** Heuristic claim classifier — conservative on assertions. */
export function classifyClaims(reply: string): ClassifiedClaim[] {
  // A bullet is a marker followed by whitespace. `^[-*•]\s*` also ate the
  // first `*` of `**bold**`, so every bolded claim was stored as `*Name**…`.
  const lines = reply
    .split(/\n+/)
    .map((l) => l.trim().replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean);
  const out: ClassifiedClaim[] = [];
  for (const text of lines) {
    if (
      // A cited line is a claim about its source, never an aporia: "It is
      // unknown to most that X [1]" took this branch, skipped the support
      // check, and still rendered its pin as a source (review, 2026-09-26).
      !CITATION.test(text) &&
      /\b(i don't know|unknown|uncertain|cannot verify|aporia|no evidence)\b/i.test(
        text,
      )
    ) {
      out.push({ kind: "aporia", text });
    } else if (isHeading(text)) {
      out.push({ kind: "heading", text });
    } else if (
      // A line that cites a source is a claim about it, whatever else it says.
      // Without the citation test, "As noted, X is Y [1]" was chatter: status
      // ALLOWED, never committed, never printed — the claim skipped the gate
      // and the rejection of its citation went nowhere.
      !CITATION.test(text) &&
      /\b(you said|you asked|noted|acknowledged|queued|see spend)\b/i.test(text)
    ) {
      out.push({ kind: "chatter", text });
    } else if (ASSERTION_VERB.test(text) && text.length > 20) {
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
 * Split cited sources into those whose passages contain the claim's specifics
 * and those withheld for lacking them. Only `vault_page` rows have a body to
 * check; any other kind is passed through, and commitBelief drops it as
 * kind_unregistered as before. The check is all-or-nothing over the union of
 * cited passages: a claim whose numbers, names or domains are absent from
 * every one of them keeps no citation at all.
 */
function withholdUnsupported(
  db: DatabaseSync,
  text: string,
  cited: SourceRef[],
): { kept: SourceRef[]; rejected: RejectedSource[] } {
  const read = db.prepare(
    `SELECT body FROM vector_document WHERE id = ? AND source_kind = 'vault_page'`,
  );
  // Only pins that verify are judged here. A row that is missing, or whose
  // content drifted from the pinned hash, is left for commitBelief to reject
  // with its true reason (not_found, hash_mismatch); checking a drifted body
  // would report terms_absent against text the claim never cited.
  const bodyOf = new Map<SourceRef, string>();
  for (const s of cited) {
    if (s.kind !== "vault_page" || !verifyPin(db, s).ok) continue;
    const row = read.get(s.refId) as { body: string } | undefined;
    if (row) bodyOf.set(s, row.body);
  }
  if (bodyOf.size === 0) return { kept: cited, rejected: [] };
  const missing = missingTerms(text, [...bodyOf.values()]);
  if (missing.length === 0) return { kept: cited, rejected: [] };
  const reason = `terms_absent: ${missing.join(", ")}`;
  return {
    kept: cited.filter((s) => !bodyOf.has(s)),
    rejected: [...bodyOf.keys()].map((s) => ({ refId: s.refId, reason })),
  };
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
  const cited: SourceRef[] = (opts.sources ?? []).map((s) => ({
    kind: s.kind,
    refId: s.refId,
    snapshotHash: s.snapshotHash,
    spanHash: s.spanHash,
    provenance: s.provenance,
  }));

  if (claim.kind === "chatter") {
    return { ok: true, status: "ALLOWED", reason: "non-load-bearing chatter" };
  }

  // No commitBelief: nothing is written, so nothing needs a source. Its own
  // status rather than chatter's ALLOWED, which would read as an endorsement.
  if (claim.kind === "heading") {
    return { ok: true, status: "HEADING", reason: "structural line — not recorded" };
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
    // `CommitResult` is a discriminated union: `beliefId` exists only on the
    // ok branch and `reason` only on the failure branch. Reading both off `r`
    // without narrowing compiled to `undefined` at runtime rather than
    // throwing, so this returned `beliefId: undefined` whenever the commit
    // failed while its own signature promises a string — and 300 passing tests
    // never saw it, because nothing crashes when you read a missing property.
    return r.ok
      ? {
          ok: true,
          status: "APORIA",
          reason: "recorded as unknown",
          beliefId: r.beliefId,
          rejectedSources: dropped(r),
        }
      : {
          ok: false,
          status: "APORIA",
          reason: r.reason,
          rejectedSources: dropped(r),
        };
  }

  // A verified pin proves a passage is real, not that it says this claim.
  // Checked here, at the commit, so every caller gets it: runAsk, and the
  // turn / server / Discord / Slack / gateway paths through
  // enforceReplyContract, which accepted `sources` and never checked them.
  const support = withholdUnsupported(db, claim.text, cited);
  const sources = support.kept;
  const rejectedWith = (r: { rejectedSources?: RejectedSource[] }): RejectedSource[] | undefined => {
    const all = [...support.rejected, ...(r.rejectedSources ?? [])];
    return all.length ? all : undefined;
  };

  if (claim.kind === "assertion") {
    // Cited nothing: refusable without opening a transaction, because no
    // verification can change a count of zero.
    if (opts.strict && sources.length === 0) {
      return {
        ok: false,
        status: "REFUSED",
        reason:
          "completion contract: load-bearing assertion lacks source pins (strict)",
        rejectedSources: rejectedWith({}),
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
        rejectedSources: rejectedWith(r),
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
        rejectedSources: rejectedWith(r),
      };
    }
    return {
      ok: true,
      status: "ALLOWED",
      beliefId: r.beliefId,
      rejectedSources: rejectedWith(r),
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
      rejectedSources: rejectedWith(r),
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
      rejectedSources: rejectedWith(r),
    };
  }
  return {
    ok: true,
    status: "UNSUPPORTED",
    reason: "recorded with no verified source — not evidence for anything",
    beliefId: r.beliefId,
    rejectedSources: rejectedWith(r),
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
