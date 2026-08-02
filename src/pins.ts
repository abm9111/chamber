/**
 * Content-pin verification.
 *
 * A pin is only meaningful if the formula that produced it is the same one
 * that checks it. Each source kind therefore registers its own formula, and a
 * kind with no registered formula is unverifiable — never exempt.
 *
 * Verification is a local corpus lookup: no network, no model, safe to call
 * inside a gate transaction.
 */

import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "./hash.ts";

export type PinFailure = "not_found" | "hash_mismatch" | "kind_unregistered";

/**
 * Failure reasons a *stored belief source* can carry, which is a superset of
 * what `verifyPin` itself can return. A `belief`-kind source never reaches
 * verifyPin (see `verifyBeliefSources`) — it fails its own existence check
 * instead, with its own reason, so a caller can tell "this pin's formula
 * disagreed" from "this citation points at a belief row that is gone."
 * commitBelief's own rejection list (src/commit_belief.ts) uses this same
 * union for the identical reason: one definition, so the gate that writes a
 * belief-kind source and the scan that re-checks it later cannot drift apart
 * on what counts as valid.
 */
export type BeliefSourceFailure = PinFailure | "belief_not_found";

export interface PinVerdict {
  ok: boolean;
  reason?: PinFailure;
  actualHash?: string;
  sourceRef?: string | null;
  /**
   * source_kind of the row that was actually matched — always equal to the
   * claimed kind, because the lookup binds it. Surfaced so a caller can show
   * what a verdict was reached against instead of trusting the claim it made.
   */
  sourceKind?: string;
}

export interface PinnedSource {
  kind: string;
  refId: string;
  snapshotHash: string;
}

/**
 * Corpus source kinds a citation can actually be made out of.
 *
 * Two independent walls decide this list, and both land in the same place:
 *
 *  1. `verifyPin` registers a formula for `vault_page` and nothing else, so a
 *     citation of any other kind is unverifiable by construction — it comes
 *     back `kind_unregistered` and can never count as support.
 *  2. `belief_source.kind` (sql/schema.sql) is CHECK-constrained to
 *     `transcript|url|vault_page|x_tweet|belief`, so `note`, `skill` and
 *     `other` cannot be *stored* as support even if a formula existed.
 *
 * `chamber ask` retrieves only these kinds. Showing the model a passage it
 * cannot legally cite is not a neutral act: the model cites it, the pin fails,
 * the assertion mints blocking debt keyed on its claim hash, and that claim is
 * then refused forever — after the tokens have already been paid for. Filtering
 * at retrieval is the fail-closed choice, and it costs nothing in practice
 * because `chamber ingest`, `indexCodeTree` and `scip` all write `vault_page`.
 *
 * This is the one list to extend when a kind gains a formula: adding a kind
 * here without registering its formula in `verifyPin` re-opens exactly the bug
 * this closes, so `isCitableSourceKind` is a narrowing guard rather than a
 * cast — the type system then requires the `verifyPin` call site to agree.
 */
export const CITABLE_SOURCE_KINDS = ["vault_page"] as const;

export type CitableSourceKind = (typeof CITABLE_SOURCE_KINDS)[number];

export function isCitableSourceKind(kind: string): kind is CitableSourceKind {
  return (CITABLE_SOURCE_KINDS as readonly string[]).includes(kind);
}

/**
 * Recompute a vault_page pin from the stored row.
 * Must stay byte-identical to the snapshot formula in upsertDocument
 * (src/vector.ts) — a pin minted there is only checkable if the framing is
 * reproduced exactly here. The round-trip tests in the `pins` suite mint via
 * upsertDocument and verify here, so drift between the two fails the suite.
 *
 * The framing is JSON.stringify of a fixed 3-element array, NOT
 * [...].join("\n"): joining is not injective across its own separator, so
 * {title:"X", body:"Y\nZ"} and {title:"X\nY", body:"Z"} hashed identically.
 * That let a pin verify against a document it was not computed from, and made
 * an edit moving a newline from the end of a title to the start of a body
 * undetectable drift. JSON escapes separators inside each field.
 */
function vaultPageHash(row: {
  title: string | null;
  body: string;
  source_ref: string | null;
}): string {
  return sha256(
    JSON.stringify([row.title ?? "", row.body, row.source_ref ?? ""]),
  );
}

export function verifyPin(db: DatabaseSync, source: PinnedSource): PinVerdict {
  if (source.kind !== "vault_page") {
    return { ok: false, reason: "kind_unregistered" };
  }

  // A non-string refId reaches the SQLite binder raw and throws — `{a:1}`
  // yields "Unknown named parameter 'a'". Model-derived values are passed
  // through here inside a gate transaction, where a throw is not a verdict and
  // unwinds the caller instead of denying it. Fail closed with a verdict.
  if (typeof source.refId !== "string") {
    return { ok: false, reason: "not_found" };
  }

  // source_kind is BOUND, not merely selected. Looking the row up by id alone
  // let any corpus row be verified under the vault_page formula, because
  // upsertDocument applies one formula to every source_kind — so changing a
  // citation's `kind` string turned an unverifiable source into a passing one,
  // defeating "unregistered kinds are unverifiable, not exempt". The kind a
  // citation claims must be the kind the stored row actually has; a mismatch
  // resolves to no row and therefore not_found.
  const row = db
    .prepare(
      `SELECT source_kind, title, body, source_ref FROM vector_document
       WHERE id = ? AND source_kind = ?`,
    )
    .get(source.refId, source.kind) as
    | {
        source_kind: string;
        title: string | null;
        body: string;
        source_ref: string | null;
      }
    | undefined;

  if (!row) return { ok: false, reason: "not_found" };

  const actualHash = vaultPageHash(row);
  if (actualHash !== source.snapshotHash) {
    return {
      ok: false,
      reason: "hash_mismatch",
      actualHash,
      sourceRef: row.source_ref,
      sourceKind: row.source_kind,
    };
  }
  return {
    ok: true,
    actualHash,
    sourceRef: row.source_ref,
    sourceKind: row.source_kind,
  };
}

export interface BeliefDrift {
  beliefId: string;
  content: string;
  total: number;
  verified: number;
  failures: {
    refId: string;
    reason: BeliefSourceFailure;
    sourceRef?: string | null;
  }[];
}

/**
 * Re-check every stored pin against the current corpus.
 *
 * This is where verification stops being tautological: the pin was written
 * when the belief was committed, and the corpus has moved since. Within a
 * single `chamber ask`, `verifyPin` checks a hash against the very row it was
 * just read from — this is the check that can actually fail, because the row
 * it reads now may not be the row a source pin was minted against.
 *
 * A `belief`-kind source is the one exception to "every source goes through
 * verifyPin": a belief citing another belief is not a corpus document, so
 * there is no formula to recompute — verifyPin correctly has none, and this
 * function must not paper over that by calling it anyway. It is checked for
 * existence instead, mirroring the same rule commitBelief already applies
 * when the source is first written (src/commit_belief.ts), so a citation
 * that was valid enough to commit is never later reported broken by a scan
 * that quietly disagrees about what "valid" means for that kind.
 *
 * Read-only: every row visited here is a SELECT — by verifyPin or by the
 * belief-existence check below — and neither one ever writes. Calling this
 * does not change what any future call to it reports.
 */
export function verifyBeliefSources(
  db: DatabaseSync,
  opts: { since?: string } = {},
): BeliefDrift[] {
  const rows = db
    .prepare(
      `SELECT b.id AS belief_id, b.content AS content,
              s.kind AS kind, s.ref_id AS ref_id, s.snapshot_hash AS snapshot_hash
         FROM belief b
         JOIN belief_source s ON s.belief_id = b.id
        WHERE (? IS NULL OR b.created_at >= ?)
        ORDER BY b.created_at DESC`,
    )
    .all(opts.since ?? null, opts.since ?? null) as {
    belief_id: string;
    content: string;
    kind: string;
    ref_id: string;
    snapshot_hash: string;
  }[];

  const byBelief = new Map<string, BeliefDrift>();
  for (const r of rows) {
    let entry = byBelief.get(r.belief_id);
    if (!entry) {
      entry = {
        beliefId: r.belief_id,
        content: r.content,
        total: 0,
        verified: 0,
        failures: [],
      };
      byBelief.set(r.belief_id, entry);
    }
    entry.total += 1;

    if (r.kind === "belief") {
      // A belief citing another belief is an internal ledger edge, not a
      // corpus document: there is no body to recompute a hash from, so
      // routing it through verifyPin always landed on kind_unregistered —
      // correct for a kind with no formula, but "no formula" is not "never
      // verified this drifted." That conflation made a belief-kind source
      // report broken forever, even freshly committed and never touched,
      // which made `chamber verify` exit non-zero on a perfectly healthy
      // chain and taught operators to ignore its failures. A belief's
      // claim_hash is immutable once committed, so nothing about a
      // belief-kind source can drift — it can only vanish — and existence is
      // therefore the whole check, exactly as commitBelief already applies
      // it when the source is first written (src/commit_belief.ts).
      const cited = db
        .prepare(`SELECT id FROM belief WHERE id = ?`)
        .get(r.ref_id) as { id: string } | undefined;
      if (cited) {
        entry.verified += 1;
      } else {
        entry.failures.push({ refId: r.ref_id, reason: "belief_not_found" });
      }
      continue;
    }

    const verdict = verifyPin(db, {
      kind: r.kind,
      refId: r.ref_id,
      snapshotHash: r.snapshot_hash,
    });
    if (verdict.ok) entry.verified += 1;
    else {
      entry.failures.push({
        refId: r.ref_id,
        reason: verdict.reason!,
        sourceRef: verdict.sourceRef,
      });
    }
  }
  return [...byBelief.values()];
}
