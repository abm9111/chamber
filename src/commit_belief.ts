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
import { embedLocalBatch } from "./embedder.ts";
import { cosineSimilarity } from "./vector.ts";
import { claimsDifferMaterially } from "./claim_asymmetry.ts";
import type {
  CommitBeliefInput,
  CommitResult,
  EpistemicType,
  ParaphraseCheckState,
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

/**
 * Cosine above which two claims are treated as the same assertion.
 *
 * **Measured 2026-08-09 against `fixtures/paraphrase_calibration.json`
 * (25 pairs) with minilm-l6-v2-q, and the measurement is not flattering.**
 *
 * At this threshold: 2 of 5 true paraphrases missed, and 8 of 17
 * non-restatements blocked. True paraphrases score 0.715–0.917;
 * non-restatements score 0.082–0.991. Those ranges overlap almost completely,
 * so **no threshold classifies the set** — the sweep finds no false-positive-free
 * value anywhere between 0.50 and 0.99.
 *
 * What gets wrongly blocked matters more than the count. All three
 * `number_swap` pairs are blocked, including "within 30 days" against "within
 * 14 days" at 0.910 — so an operator *correcting* an indebted claim is refused
 * on the grounds that the correction restates it. Both negations are blocked
 * too ("enforces" vs "does not enforce", 0.904). Cosine over a bag-of-meaning
 * embedding cannot distinguish "says the same thing" from "says the opposite
 * about the same thing", and that distinction is the entire job.
 *
 * The number is left at 0.8 deliberately: moving it trades one failure for the
 * other rather than fixing anything (0.90 catches 1 of 5 paraphrases and still
 * blocks 4 non-restatements). Re-run `npm run calibrate:paraphrase` before
 * changing it, and read `docs/KNOWN_LIMITATIONS.md` — the honest conclusion is
 * that this leg needs a different mechanism, not a better constant.
 *
 * **That mechanism now exists beside it.** `claimsDifferMaterially`
 * (`src/claim_asymmetry.ts`) runs after this threshold and drops the block where
 * the two claims conflict on a number or in negation polarity, which takes the
 * false positives from 8 to 3 on the same set without costing a true paraphrase.
 * This constant is therefore no longer the whole gate, and the counts above
 * describe the cosine leg alone.
 *
 * The exact-hash leg is unaffected and still blocks verbatim repeats.
 */
export const DEBT_PARAPHRASE_THRESHOLD = 0.8;

/**
 * Cosine thresholds are a property of the embedding model, not of the idea.
 *
 * 0.8 was measured on MiniLM: a genuine paraphrase scored 0.834 and an unrelated
 * sentence 0.030. Different models put unrelated text at different baselines —
 * nomic-embed-text in particular reports high similarity between short
 * unrelated strings — so carrying this number across would refuse commits that
 * restate nothing. A model with no measured threshold gets no threshold: the
 * gate reports that it could not run rather than applying a number borrowed
 * from somewhere else.
 *
 * To add one, measure it the way the MiniLM entry was measured — a labelled set
 * with near-paraphrases, contradictions, entity swaps and, for a bilingual
 * corpus, cross-lingual restatements — and record the model id beside it.
 */
export const CALIBRATED_THRESHOLDS: Readonly<Record<string, number>> = {
  // Keyed on the MODEL id, not the EmbedderKind. `kind` is transport: ollama
  // resolves its model from CHAMBER_OLLAMA_EMBED_MODEL, so a single "ollama"
  // entry would apply a nomic-calibrated number to mxbai or bge-m3 — the
  // borrowed-number failure this table exists to prevent, one env var away.
  "minilm-l6-v2-q": DEBT_PARAPHRASE_THRESHOLD, // measured 2026-08-09, 25 pairs
};

/**
 * How many open debts one commit will embed.
 *
 * The ollama path spawns a curl per text with a 30s ceiling, so an unbounded
 * candidate set puts N round-trips on the request path. Capping bounds that —
 * and the cap is announced rather than silent, because a gate that quietly
 * examined 32 of 200 candidates and reported "no match" is making a claim it
 * did not check.
 */
const MAX_PARAPHRASE_CANDIDATES = 32;

/**
 * Longest claim text worth embedding, in characters.
 *
 * `scripts/embed_minilm.py` sets `enable_truncation(max_length=256)`, so
 * anything past roughly a thousand characters of prose is silently dropped
 * before the vector is produced. Two long claims that agree for their first 256
 * tokens and contradict afterwards therefore embed to the same point — measured
 * at 0.991 in `fixtures/paraphrase_calibration.json`. A comparison over text the
 * model never saw is not a weak signal, it is a fabricated one.
 *
 * ~1000 characters is deliberately conservative against a 256-token window.
 */
const CLAIM_TEXT_EMBED_LIMIT = 1000;

/**
 * Open blocking debts whose claim says the same thing as `text` in different
 * words. `claim_hash` cannot find these — it is sha256 over normalised text,
 * so "within 30 days" and "during the 30 days after purchase" are two unrelated
 * keys, and debt that blocks only exact repetition blocks nothing a model
 * writes twice.
 *
 * `semantic` is false when the embedder degraded to the hash fallback mid-call.
 * Hash vectors encode character n-grams, not meaning, so comparing them here
 * would produce a confident number with nothing behind it — the caller is told
 * the check did not run rather than being handed that number.
 */
function paraphraseBlockingDebts(
  db: DatabaseSync,
  text: string,
  excludeHash: string,
): { debts: { id: string }[]; semantic: boolean; attempted: boolean } {
  const rows = db
    .prepare(
      `SELECT id, claim_text FROM citation_debt
       WHERE blocking = 1
         AND status IN ('pending','proposed_paid')
         AND claim_hash != ?
         AND claim_text IS NOT NULL
         AND claim_text != ''
       -- Deterministic order, because MAX_PARAPHRASE_CANDIDATES truncates this
       -- list. Without it the cap took an arbitrary 32 of N and the truncation
       -- warning described a sample nobody could reproduce.
       ORDER BY created_at DESC, id DESC`,
    )
    .all(excludeHash) as unknown as { id: string; claim_text: string }[];
  // Nothing open to compare against: the gate had no work, which is not the
  // same as having run, and not the same as having been skipped. Reporting it
  // as either would put a claim in the verdict that no evidence supports — and
  // it also means the common case never spawns the embedder under the lock.
  if (rows.length === 0) return { debts: [], semantic: true, attempted: false };

  // One batch, not one call per debt: embedMinilm shells out to python3, so
  // per-row embedding would put a process spawn per open debt on every commit.
  // `embedLocalBatch` throws where singular `embedLocal` degrades: the batch
  // path has no mid-call hash fallback, so a python3 that is missing, lacks
  // onnxruntime, OOMs or times out raises instead of returning hash vectors.
  // Unhandled, that escaped into the commit's outer catch and PARKED every
  // assertion made while any blocking debt was open — a broken embedder taking
  // down the ledger rather than softening one check. It is the same outcome the
  // `semantic: false` branch below already describes, so it is reported the
  // same way: the check did not run, and the caller is told.
  // The embedder truncates at 256 tokens (scripts/embed_minilm.py), and
  // `claim_text` has no length bound in the schema. Two claims sharing a long
  // prefix and diverging only past the cut embed IDENTICALLY — measured at 0.991
  // on `long_shared_prefix_divergent_tail` in the calibration set, for two
  // claims that contradict each other. Comparing text the embedder never read
  // is worse than not comparing: it produces a confident number about nothing.
  // Skip those rather than score them.
  const withinWindow = rows.filter(
    (r) => r.claim_text.length <= CLAIM_TEXT_EMBED_LIMIT,
  );
  if (withinWindow.length < rows.length) {
    console.warn(
      `chamber: NOTE — ${rows.length - withinWindow.length} open debt(s) have ` +
        `claim text longer than the embedder's window and were not compared. ` +
        `Their exact-hash block still applies.`,
    );
  }
  const candidates = withinWindow.slice(0, MAX_PARAPHRASE_CANDIDATES);
  // Measured against the post-window list, not the raw rows: otherwise skipping
  // an over-long debt made the cap warning claim a truncation that never
  // happened ("comparing the first 0"), which is its own small lie.
  if (withinWindow.length > candidates.length) {
    console.warn(
      `chamber: NOTE — ${withinWindow.length} comparable open blocking debts, ` +
        `comparing the first ${candidates.length}. The remainder were not ` +
        `examined by this commit.`,
    );
  }

  let embeds;
  try {
    embeds = embedLocalBatch([text, ...candidates.map((r) => r.claim_text)]);
  } catch {
    return { debts: [], semantic: false, attempted: true };
  }
  // A short or padded result would silently mis-pair claims with debts, since
  // the comparison below indexes rows by position.
  if (embeds.length !== candidates.length + 1)
    return { debts: [], semantic: false, attempted: true };
  if (embeds.some((e) => e.kind === "hash"))
    return { debts: [], semantic: false, attempted: true };

  // No calibrated threshold for this model means no comparison. Borrowing
  // MiniLM's 0.8 for a model whose unrelated-text baseline sits higher would
  // refuse commits that restate nothing — a false positive in a gate whose
  // whole value is that its refusals are trustworthy.
  const model = embeds[0]!.model;
  if (embeds.some((e) => e.model !== model)) {
    console.warn(
      "chamber: NOTE — the embedding batch mixed models; the semantic debt " +
        "check did not run rather than compare vectors from different spaces.",
    );
    return { debts: [], semantic: false, attempted: true };
  }
  const threshold = CALIBRATED_THRESHOLDS[model];
  if (threshold === undefined) {
    console.warn(
      `chamber: NOTE — no calibrated paraphrase threshold for model "${model}"; ` +
        `the semantic debt check did not run. Run \`npm run calibrate:paraphrase\` ` +
        `and record one before relying on it.`,
    );
    return { debts: [], semantic: false, attempted: true };
  }

  const target = embeds[0]!.vector;
  const debts: { id: string }[] = [];
  const suppressed: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i]!;
    if (cosineSimilarity(target, embeds[i + 1]!.vector) < threshold) continue;
    // Cosine says "close". Close is not the same as "the same claim", and the
    // calibration measured exactly how often that gap refuses a correction: at
    // 0.80 every number swap and every negation in the labelled set is blocked,
    // so an operator fixing "30 days" to "14 days" is told they are repeating
    // themselves. This narrows the block where the text carries evidence
    // against it. It can only ever remove a block — see src/claim_asymmetry.ts
    // for why that direction is not negotiable.
    const asym = claimsDifferMaterially(text, row.claim_text);
    if (asym.differs) {
      suppressed.push(`${row.id} (${asym.reason}: ${asym.detail})`);
      continue;
    }
    debts.push({ id: row.id });
  }
  if (suppressed.length > 0) {
    console.warn(
      `chamber: NOTE — ${suppressed.length} open debt(s) embedded close to this ` +
        `claim but were not treated as restatements of it: ${suppressed.join("; ")}. ` +
        `Their exact-hash block still applies.`,
    );
  }
  return { debts, semantic: true, attempted: true };
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
    // Decided before the gate exists, so it reports that rather than nothing.
    return {
      ok: false,
      status: "REJECTED",
      reason: "fast path may only commit observation|inference; belief-typed commit must escalate",
      paraphraseCheck: "not_reached",
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
  /**
   * What survived verification, plus the corpus position each pin resolved to.
   *
   * The position is captured HERE, from the verdict, rather than re-queried
   * later: this is the only moment the row is known to exist. `ref_id` is an
   * opaque document id that stops resolving the instant ingest deletes the row,
   * and a pin that cannot name its own position can only ever be reported as
   * `not_found` — see the `pinned_ref` column comment in sql/schema.sql.
   */
  const verifiedSources: {
    src: SourceRef;
    pinnedRef: string | null;
    pinnedRoot: string | null;
  }[] = [];
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
  /**
   * Only assertions are subject to the paraphrase gate, so only they can report
   * on it. Stamping `"ran"` on an observation — where the check is skipped by
   * construction and no embedding is ever attempted — told a reader the exact
   * opposite of the truth, in the one field added to remove that confusion.
   */
  // Defaults to the honest answer for a verdict returned before the gate. Set to
  // `not_applicable` immediately for types the gate does not cover, and to the
  // real result once the gate runs.
  let paraphraseCheckState: ParaphraseCheckState = ASSERTION.has(type)
    ? "not_reached"
    : "not_applicable";
  const withRejected = <T extends CommitResult>(result: T): T => ({
    ...result,
    ...(rejectedSources.length > 0 ? { rejectedSources } : {}),
    paraphraseCheck: paraphraseCheckState,
  });

  const hash = claimHash(type, text);
  const beliefId = newId("blf");
  const expiresAt =
    halfLifeSeconds && halfLifeSeconds > 0
      ? new Date(Date.now() + halfLifeSeconds * 1000).toISOString()
      : null;

  /**
   * Recorded here, written in the `finally` below — after the transaction has
   * committed or rolled back, so a refusal cannot erase it.
   *
   * The check itself stays *inside* the lock. It was hoisted out once to keep a
   * python3 spawn from holding BEGIN IMMEDIATE, and that traded a contention
   * problem for a correctness one: a paraphrase debt minted between an outside
   * read and the lock is invisible to an in-lock re-check, because re-checking
   * can only prune ids the earlier read already found — it never re-runs the
   * similarity search. Two units against the one database this repo ships, and
   * an unsupported claim the gate exists to refuse commits as a citable belief
   * while the verdict reports the gate as having run. FM-6 says check and write
   * are one transaction; that is the law, and the spawn is the cost of it.
   */
  let degradedReason: string | null = null;

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
        // A belief-kind source has no corpus position to record.
        if (citedBelief(s.refId)) {
          verifiedSources.push({ src: s, pinnedRef: null, pinnedRoot: null });
        }
        else rejectedSources.push({ refId: s.refId, reason: "belief_not_found" });
        continue;
      }
      const verdict = verifyPin(db, {
        kind: s.kind,
        refId: s.refId,
        snapshotHash: s.snapshotHash,
      });
      if (verdict.ok) {
        verifiedSources.push({
          src: s,
          pinnedRef: verdict.sourceRef ?? null,
          pinnedRoot: verdict.ingestRoot ?? null,
        });
      }
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

    // Open blocking debts on this claim_hash + inherited from revision chain +
    // debts on the same claim worn as different words. All three reads happen
    // under the same lock as the write they authorise (FM-6).
    const directDebts = openBlockingDebts(db, hash);
    const inherited = inheritDebtsAlongChain(db, revisionOf);
    const paraphrase = ASSERTION.has(type)
      ? paraphraseBlockingDebts(db, text, hash)
      : { debts: [], semantic: true, attempted: false };
    if (!paraphrase.attempted && ASSERTION.has(type)) {
      // Reached the gate, but there was nothing open to compare against, so no
      // embedding ran. Calling that "ran" asserted a comparison that never
      // happened — and contradicted this callee's own contract, which says an
      // empty candidate set is "not the same as having run".
      paraphraseCheckState = "no_candidates";
    }
    if (paraphrase.attempted) {
      paraphraseCheckState = paraphrase.semantic ? "ran" : "skipped";
      if (!paraphrase.semantic) {
        degradedReason =
          "embedder unavailable or non-semantic; paraphrase check did not run";
      }
    }
    const blocking = [...directDebts, ...inherited, ...paraphrase.debts];
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
         provenance, pays_subclaim, retriever_family, pinned_ref, pinned_root
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { src: s, pinnedRef, pinnedRoot } of verifiedSources) {
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
        pinnedRef,
        pinnedRoot,
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
  } finally {
    // After COMMIT or ROLLBACK, so a refusal cannot erase it — and outside the
    // transaction, so it is not the thing that fails when the lock is
    // contended. Best-effort by design: a failure to record that the gate was
    // degraded must not turn a decided commit into a thrown exception, which is
    // what happened when this call sat inline and `appendAudit` rethrew
    // SQLITE_BUSY straight past the fail-closed handler above.
    if (degradedReason) {
      try {
        appendAudit(db, {
          category: "gate",
          action: "debt:degraded",
          subjectKind: "claim_hash",
          subjectId: hash,
          turnId,
          detail: { gate: "debt", check: "paraphrase", reason: degradedReason },
        });
      } catch (err) {
        // The verdict stands — a failure to *record* a degradation must not turn
        // a decided commit into a thrown exception. But it must not be silent
        // either: this row is the only durable trace that the gate did not run,
        // so losing it quietly reproduces the exact defect the row was added to
        // fix, one level up. Audible on stderr, once per failure.
        console.warn(
          `chamber: WARNING — the paraphrase gate was degraded for claim ${hash.slice(0, 12)}… ` +
            `and the audit row recording that could not be written ` +
            `(${err instanceof Error ? err.message : String(err)}). ` +
            `This commit's verdict reports paraphraseCheck="skipped"; the ledger does not.`,
        );
      }
    }
  }
}
