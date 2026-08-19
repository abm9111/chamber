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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./hash.ts";
import { passagePathOf } from "./chunk.ts";

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
  /**
   * `title` of the row that was actually matched — for a vault passage this is
   * the heading breadcrumb (`policy › Access`), i.e. what occupies that
   * position in the note *now*.
   *
   * Surfaced for the same reason as `sourceKind`: on a `hash_mismatch` the
   * only thing a caller could previously report was the position, and a
   * position is exactly the thing an edit above it silently reassigns. Inserting
   * a section at the top of a note leaves `policy.md#p1` naming a different
   * section than the one the pin was minted against, so a message built from
   * the ref alone points the operator at content they never cited. Absent on
   * `not_found`, because there is no row to have read it from.
   */
  title?: string | null;
  /**
   * Present only when the pin verified via the moved-within-file rescue in
   * `findMovedWithinFile`: the position the pin was committed against
   * (`path#pN`), while `sourceRef` is where the byte-identical passage lives
   * now. Absent on every other verdict — including the by-snapshot-hash
   * relocation above it, where the ref never changed (only the row id did),
   * so "from" and "to" would be the same string.
   */
  relocatedFrom?: string;
}

export interface PinnedSource {
  kind: string;
  refId: string;
  snapshotHash: string;
  /**
   * The `path#pN` this pin was minted against, from `belief_source.pinned_ref`.
   *
   * Only the report path supplies it, and only for stored pins. It exists for
   * the one case `refId` cannot serve: ingest deletes a note's orphaned tail
   * rows when the note shrinks, so a document id can stop resolving while the
   * cited text is still in the corpus a few passages higher. The snapshot hash
   * cannot find it either — the hash contains the abandoned position. Without
   * this the only available verdict is `not_found`, which tells an operator
   * their citation was never real about text they can see.
   *
   * Absent on pins written before the column existed; those keep the old
   * behaviour rather than guessing.
   */
  pinnedRef?: string;
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
 * undetectable drift. JSON escapes separators inside each field, so the array
 * framing itself is unambiguous about where one field ends and the next
 * begins.
 *
 * That is a claim about the separators, not about the whole formula, and it
 * does not by itself make this function injective: title and source_ref are
 * nullable columns, and `row.title ?? ""` — coalescing NULL to "" *before*
 * building the array — collapsed exactly the distinction JSON.stringify was
 * introduced to preserve, because the coalescing ran before the array existed
 * rather than inside it. `JSON.stringify([null, body, ref])` and
 * `JSON.stringify(["", body, ref])` are different strings; `?? ""` made sure
 * the formula never produced the first one, so a title or source_ref that
 * flipped between SQL NULL and "" between ingests hashed identically — the
 * same undetectable-drift failure the array framing above exists to close,
 * reopened one line later. The values below are therefore passed through,
 * not defaulted: NULL stays `null` and "" stays `""`. The one default that
 * remains, `?? null`, is not a coalesce-to-placeholder — it normalizes
 * `undefined` to `null`, because inside a JSON array a bare `undefined`
 * element also serializes to `null`, and leaving that implicit would make the
 * formula correct only by the accident that SQLite always yields `null` and
 * never `undefined` for these columns.
 */
function vaultPageHash(row: {
  title: string | null;
  body: string;
  source_ref: string | null;
}): string {
  return sha256(
    JSON.stringify([row.title ?? null, row.body, row.source_ref ?? null]),
  );
}

export interface VerifyPinOptions {
  /**
   * Resolve a pin whose row is gone by finding the same content elsewhere.
   *
   * Off by default, and only drift *reporting* turns it on. A content hash
   * proves the text is somewhere in the corpus; it does not prove the citation
   * named it. Granting support on that basis lets any refId — including one
   * that names nothing — ride a hash into a belief_source row pointing at
   * nothing, and snapshot hashes are handed back to callers in ask's own
   * ContractSource. That is probes/pin_bypass.ts's defect wearing new clothes.
   *
   * Reporting is different in kind: those rows were already granted through the
   * commit gate, so they named a real row once, and the question is only where
   * that evidence went.
   */
  allowRelocation?: boolean;
}

export function verifyPin(
  db: DatabaseSync,
  source: PinnedSource,
  opts: VerifyPinOptions = {},
): PinVerdict {
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
  type DocRow = {
    source_kind: string;
    title: string | null;
    body: string;
    source_ref: string | null;
    /**
     * Carried for the moved-within-file rescue only: `source_ref` is
     * ROOT-RELATIVE (see stableDocumentId in src/vector.ts), so it does not
     * identify a file on its own. Selected here rather than re-queried there
     * so the rescue compares the pinned row's own root, not a second lookup's.
     */
    metadata_json: string | null;
  };

  let row = db
    .prepare(
      `SELECT source_kind, title, body, source_ref, metadata_json FROM vector_document
       WHERE id = ? AND source_kind = ?`,
    )
    .get(source.refId, source.kind) as DocRow | undefined;

  // `snapshotHash` reaches the binder below, so it needs the guard `refId` got
  // twelve lines above and for the identical reason: a non-string value throws
  // out of the binder ("Unknown named parameter 'a'"), and inside the commit
  // transaction a throw is not a verdict — it unwinds the caller and parks the
  // assertion instead of denying it. Until the relocation lookup existed this
  // value was only ever compared with `!==`, so it never had to be guarded.
  if (opts.allowRelocation && typeof source.snapshotHash !== "string") {
    return { ok: false, reason: "not_found" };
  }

  if (!row && opts.allowRelocation) {
    // The id is where we last saw the evidence; the content hash is the pin.
    // A row can lose its id without losing its content — a from-scratch
    // re-index did exactly that to this corpus, renaming all 28,627 rows and
    // orphaning every belief older than the rebuild. Reporting `not_found`
    // there says "your citation was never real" about text sitting unchanged
    // in the index, so before concluding the evidence is gone, look for it by
    // what it says. `idx_vector_doc_snap` makes this an indexed lookup.
    //
    // The kind is still bound, so this cannot promote an unverifiable kind.
    // Ordered by id so a corpus holding the same passage twice resolves the
    // same way on every run rather than picking arbitrarily.
    row = db
      .prepare(
        `SELECT source_kind, title, body, source_ref, metadata_json FROM vector_document
         WHERE snapshot_hash = ? AND source_kind = ?
         ORDER BY id LIMIT 1`,
      )
      .get(source.snapshotHash, source.kind) as DocRow | undefined;
  }

  if (!row) {
    // The row is gone — but a stored position says where it used to be, and
    // the text may simply have moved up as the note shrank. Report path only,
    // same as every other relocation.
    if (opts.allowRelocation && typeof source.pinnedRef === "string") {
      const moved = findMovedWithinFile(db, source, source.pinnedRef, null);
      if (moved) return moved;
    }
    return { ok: false, reason: "not_found", sourceRef: source.pinnedRef ?? null };
  }

  const actualHash = vaultPageHash(row);
  if (actualHash !== source.snapshotHash) {
    // Report path only: before calling intact evidence broken, check whether
    // it merely moved within its file. See findMovedWithinFile for why the
    // by-snapshot-hash relocation above cannot catch this case.
    if (opts.allowRelocation) {
      const moved = findMovedWithinFile(
        db,
        source,
        row.source_ref,
        row.metadata_json,
      );
      if (moved) return moved;
    }
    return {
      ok: false,
      reason: "hash_mismatch",
      actualHash,
      sourceRef: row.source_ref,
      sourceKind: row.source_kind,
      title: row.title,
    };
  }
  return {
    ok: true,
    actualHash,
    sourceRef: row.source_ref,
    sourceKind: row.source_kind,
    title: row.title,
  };
}

/**
 * The moved-within-file rescue, for the report path only.
 *
 * Measured before it existed (vault backtest, 2026-08-18): one insertion at
 * the top of a note re-slotted every passage below it, and all nine pins on
 * that note fired hash_mismatch while their bodies sat byte-identical one
 * position down. The mechanism is structural, not bad luck: `source_ref`
 * (`path#pN`) participates in the snapshot formula, so a moved passage's
 * stored hash differs from its pin's, and the by-snapshot-hash relocation in
 * verifyPin searches for a hash that embeds the position the passage left —
 * it can rescue a row that lost its *id* (ref unchanged), never one that lost
 * its *position*.
 *
 * So this rescue searches the other way around: take each row still in the
 * pinned file, re-frame its stored [title, body] at the pin's recorded
 * position, and compare through vaultPageHash — the one formula, not a copy.
 * Equality proves the candidate's title and body are byte-identical to what
 * was pinned, with exactly the strength of the primary check; content that
 * merely resembles the pinned passage cannot pass, so this cannot decay into
 * a similarity judgement.
 *
 * Same file only, by construction: the SQL range scan bounds candidates to
 * `path#…` (`'#'` sorts immediately below `'$'`), and because vault filenames
 * legitimately contain `#` (the same reason ingest.ts refuses LIKE for this
 * scan — `%` and `_` are wildcards there), a range hit is confirmed with a
 * passagePathOf equality check before hashing. Byte-identical text in a
 * *different* file stays an alarm: the file is part of what a citation
 * claims, and the backtest measured file-level accuracy at 100% — that is
 * the property being preserved.
 *
 * Bounds of the rescue, stated rather than implied:
 *  - The gate never takes it: only drift reporting passes allowRelocation,
 *    for the reasons on VerifyPinOptions.
 *  - A pin whose row is *gone* (not_found) cannot take it: vdoc ids are
 *    opaque hashes, so with the row deleted there is no recorded position to
 *    re-frame against. A note that shrank past a moved passage therefore
 *    still reports not_found.
 *  - A bare ref (`chamber index` rows, no `#pN`) has no position to have
 *    moved from; skipped.
 *  - A file holding the same passage twice resolves deterministically
 *    (ORDER BY id, like the primary relocation) — and if the pinned instance
 *    was edited while a byte-identical twin survived elsewhere in the file,
 *    the twin rescues the pin and lost support reads as a move.
 *
 *    This is NOT inherited from relocation-by-content generally, and an
 *    earlier version of this comment claimed it was. The primary relocation
 *    matches on `snapshot_hash`, which contains `source_ref` — so it can only
 *    match a row whose title, body AND position are all byte-identical, i.e.
 *    proof that nothing moved. Re-framing deliberately breaks that coupling:
 *    it asks whether some other position's content equals what was pinned,
 *    which is exactly what lets it follow a shifted passage, and exactly what
 *    makes it unable to distinguish "the same paragraph, moved" from "a
 *    different paragraph that reads identically." Content-addressing cannot
 *    separate those without an identity signal this schema does not store
 *    (see KNOWN_LIMITATIONS 6: `source_ref` on `belief_source`). Callers must
 *    therefore not render a relocation as proof the citation is unchanged —
 *    it is proof the pinned text still exists in that file.
 */
function ingestRootOf(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    if (parsed !== null && typeof parsed === "object") {
      const v = (parsed as { ingestRoot?: unknown }).ingestRoot;
      if (typeof v === "string" && v !== "") return v;
    }
  } catch {
    return null;
  }
  return null;
}

function findMovedWithinFile(
  db: DatabaseSync,
  source: PinnedSource,
  pinnedRef: string | null,
  pinnedMetadataJson: string | null,
): PinVerdict | null {
  if (typeof pinnedRef !== "string" || pinnedRef === "") return null;
  const path = passagePathOf(pinnedRef);
  if (path === pinnedRef) return null;
  // `source_ref` is root-relative, so the range scan below bounds candidates to
  // a *string*, not to a file. Two configured roots may each legitimately hold
  // `policy.md#p0` — src/vector.ts's stableDocumentId says so in as many words,
  // and tests/harness.ts I7 pins the behaviour — so without this the rescue
  // reads one vault's passage as another's moved evidence. Confirmed by repro
  // during review: root A's genuinely-edited policy reported `verified`, exit
  // 0, rescued by root B's stale copy of the same relative path.
  //
  // Fail closed: a rescue requires both sides to carry the SAME non-empty
  // ingestRoot. A row with no recorded root (written before roots existed, or
  // by `chamber index`, which records none) is not rescuable — it alarms
  // instead, which is the direction that cannot invent support.
  // When the pinned row still exists, its own recorded root is authoritative.
  // When it is gone (the shrink case), there is no row to ask, so the root is
  // derived from the candidates — and only when they agree. Two configured
  // vaults may each hold `policy.md`, and picking one arbitrarily is how the
  // cross-root defect worked; ambiguity therefore refuses rather than guesses.
  const pinnedRoot =
    pinnedMetadataJson === null ? null : ingestRootOf(pinnedMetadataJson);
  const requireDerivedRoot = pinnedMetadataJson === null;
  if (!requireDerivedRoot && pinnedRoot === null) return null;
  type DocRow = {
    source_kind: string;
    title: string | null;
    body: string;
    source_ref: string | null;
    metadata_json: string | null;
  };
  const candidates = db
    .prepare(
      `SELECT source_kind, title, body, source_ref, metadata_json FROM vector_document
       WHERE source_kind = ? AND source_ref >= ? AND source_ref < ?
       ORDER BY id`,
    )
    .all(source.kind, `${path}#`, `${path}$`) as DocRow[];

  // Derived-root case: every candidate for this relative path must belong to
  // one root, or the path does not identify a file and nothing here can.
  let derivedRoot: string | null = null;
  if (requireDerivedRoot) {
    const roots = new Set<string>();
    for (const c of candidates) {
      if (typeof c.source_ref !== "string" || passagePathOf(c.source_ref) !== path) {
        continue;
      }
      const r = ingestRootOf(c.metadata_json);
      if (r === null) return null; // an unrooted candidate cannot be placed
      roots.add(r);
    }
    if (roots.size !== 1) return null;
    derivedRoot = [...roots][0]!;
  }
  const expectedRoot = requireDerivedRoot ? derivedRoot : pinnedRoot;

  for (const c of candidates) {
    if (c.source_ref === pinnedRef) continue;
    if (typeof c.source_ref !== "string" || passagePathOf(c.source_ref) !== path) {
      continue;
    }
    if (ingestRootOf(c.metadata_json) !== expectedRoot) continue;
    const reframed = vaultPageHash({
      title: c.title,
      body: c.body,
      source_ref: pinnedRef,
    });
    if (reframed === source.snapshotHash) {
      return {
        ok: true,
        actualHash: vaultPageHash(c),
        sourceRef: c.source_ref,
        sourceKind: c.source_kind,
        title: c.title,
        relocatedFrom: pinnedRef,
      };
    }
  }
  return null;
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
    /**
     * Breadcrumb title of the row as it stands *now* — see `PinVerdict.title`.
     * Carried alongside `sourceRef` because the pair is what makes a drift
     * report actionable: the ref is the position the pin was committed
     * against, the title is what occupies that position today, and an edit
     * above the passage is precisely the case where the two disagree.
     */
    title?: string | null;
  }[];
  /**
   * Pins that verified via the moved-within-file rescue: support intact,
   * position changed. Counted in `verified`, never in `failures` — the
   * measured alternative was nine false alarms per top-of-note insertion,
   * which is how an operator learns to ignore the one report this tool
   * exists to make. Report-only information; nothing is rewritten.
   */
  relocations: {
    refId: string;
    /** Position the pin was committed against (`path#pN`). */
    from: string;
    /** Position holding the byte-identical passage now. */
    to: string | null;
    title?: string | null;
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
              s.kind AS kind, s.ref_id AS ref_id, s.snapshot_hash AS snapshot_hash,
              s.pinned_ref AS pinned_ref
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
    pinned_ref: string | null;
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
        relocations: [],
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

    // The one caller that may relocate: every row here was already granted
    // through the commit gate, so it named a real document once and the only
    // open question is where that evidence went. The gate itself
    // (commit_belief, ask, debt) must keep requiring the cited row to exist.
    const verdict = verifyPin(
      db,
      {
        kind: r.kind,
        refId: r.ref_id,
        snapshotHash: r.snapshot_hash,
        pinnedRef: r.pinned_ref ?? undefined,
      },
      { allowRelocation: true },
    );
    if (verdict.ok) {
      entry.verified += 1;
      if (verdict.relocatedFrom) {
        entry.relocations.push({
          refId: r.ref_id,
          from: verdict.relocatedFrom,
          to: verdict.sourceRef ?? null,
          title: verdict.title ?? null,
        });
      }
    } else {
      entry.failures.push({
        refId: r.ref_id,
        reason: verdict.reason!,
        sourceRef: verdict.sourceRef,
        title: verdict.title,
      });
    }
  }
  return [...byBelief.values()];
}

/**
 * The complement of verifyBeliefSources's checked set: beliefs with no
 * belief_source rows at all. Retraction types (`unknown`, `defeater`) commit
 * freely without sources, and an assertion that minted citation debt has
 * nothing pinned yet — none of them can drift, so verify correctly never
 * visits them.
 *
 * Correctly excluded is not the same as visibly excluded. "17 belief(s)
 * checked" over a database holding 29 read as full coverage to the operator,
 * who then spent a morning proving the missing twelve were a design decision
 * and not a silent skip — with SQL, because the summary would not say it.
 * This count exists so the summary can.
 *
 * Takes the same `since` filter as verifyBeliefSources: the two numbers share
 * a summary line, so they must describe the same population or the line is
 * quietly comparing different corpora.
 */
/**
 * Everything one verify run knows, in one struct — the machine-readable
 * contract behind `chamber verify --json`, and the single source the prose
 * path renders from, so a CI consumer and a human reader can never be told
 * different stories by the same run.
 *
 * `broken` counts beliefs with no verified support left; `degraded` counts
 * partial loss. Both fail the run (see the exit-code history in cli.ts —
 * partial evidence loss was once silent to the only machine consumer that
 * existed, and probes/verify_partial_drift.ts guards the fix). The
 * complement fields carry what the checked set excludes: sourceless beliefs
 * (nothing pinned, nothing to drift) and pinned files gone from disk (pins
 * that verify against stored content only — KNOWN_LIMITATIONS entry 5).
 */
export interface VerifyRunReport {
  since: string | null;
  checked: number;
  broken: number;
  degraded: number;
  unsourcedBeliefs: number;
  goneFiles: { file: string; passages: number }[];
  /**
   * Total pins across `beliefs` that verified via the moved-within-file
   * rescue. Outside the exit code for the same reason goneFiles is: nothing
   * the belief cites has changed, and exiting non-zero on it is exactly the
   * false alarm the backtest measured.
   */
  relocatedPins: number;
  beliefs: BeliefDrift[];
}

export function buildVerifyReport(
  db: DatabaseSync,
  opts: { since?: string } = {},
): VerifyRunReport {
  const beliefs = verifyBeliefSources(db, opts);
  let broken = 0;
  let degraded = 0;
  for (const b of beliefs) {
    if (b.failures.length === 0) continue;
    if (b.verified === 0) broken++;
    else degraded++;
  }
  return {
    since: opts.since ?? null,
    checked: beliefs.length,
    broken,
    degraded,
    unsourcedBeliefs: countUnsourcedBeliefs(db, opts),
    goneFiles: findGonePinnedFiles(db),
    relocatedPins: beliefs.reduce((n, b) => n + b.relocations.length, 0),
    beliefs,
  };
}

/**
 * Pinned files that no longer exist on disk — the report-only first slice of
 * closing KNOWN_LIMITATIONS entry 5.
 *
 * A deleted file is never revisited by ingest (the walk only sees files that
 * exist), so its rows keep their stored content, its pins re-hash that stored
 * content and verify forever, and retrieval keeps serving it. "The source was
 * removed from underneath a conclusion" is the strongest version of the event
 * this product exists to catch, and today it is the one case verify actively
 * vouches for. Until tombstones land, verify can at least *say* it.
 *
 * The check is the filesystem, not an ingest manifest, which dissolves the
 * excluded-vs-gone ambiguity that makes the deletion version of this feature
 * dangerous: an excluded file still exists on disk and is correctly not
 * reported; a gone file is gone regardless of why the walk skipped it. Only
 * rows written by `chamber ingest` participate — they carry `ingestRoot` in
 * metadata and a `path#pN` ref; rows from `chamber index` have no on-disk
 * location to check and are skipped, which under-reports rather than
 * false-alarms.
 *
 * Read-only, and deliberately not part of verify's exit code: pins on stored
 * content DO verify, and flipping the exit here would change the scheduled
 * job's contract before tombstones give the operator a way to act.
 */
export function findGonePinnedFiles(
  db: DatabaseSync,
): { file: string; passages: number }[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT d.source_ref AS ref, d.metadata_json AS meta
         FROM belief_source s
         JOIN vector_document d ON d.id = s.ref_id
        WHERE s.kind != 'belief'`,
    )
    .all() as { ref: string | null; meta: string | null }[];

  const byFile = new Map<string, number>();
  for (const r of rows) {
    if (!r.ref || !r.meta) continue;
    let root: unknown;
    try {
      root = (JSON.parse(r.meta) as { ingestRoot?: unknown }).ingestRoot;
    } catch {
      continue;
    }
    if (typeof root !== "string" || root === "") continue;
    const file = join(root, passagePathOf(r.ref));
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }

  const gone: { file: string; passages: number }[] = [];
  for (const [file, passages] of byFile) {
    if (!existsSync(file)) gone.push({ file, passages });
  }
  return gone.sort((a, b) => b.passages - a.passages);
}

export function countUnsourcedBeliefs(
  db: DatabaseSync,
  opts: { since?: string } = {},
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM belief b
        WHERE NOT EXISTS (SELECT 1 FROM belief_source s WHERE s.belief_id = b.id)
          AND (? IS NULL OR b.created_at >= ?)`,
    )
    .get(opts.since ?? null, opts.since ?? null) as { c: number };
  return row.c;
}
