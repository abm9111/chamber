/**
 * Vault question answering with a real citation gate.
 *
 * The model sees passages numbered [1]..[k] and cites those numbers. It never
 * sees a document id and never sees or emits a hash, so it can neither invent
 * an identifier nor forge a pin — index->id and id->hash mapping happen here.
 *
 * Concretely: the only model-derived value that survives into the gate is the
 * integer inside a bracket, and it is used solely as a key into a Map built
 * from this call's own retrieval results. Every `refId` and `snapshotHash`
 * that reaches verifyPin or commitBelief was read out of `vector_document` by
 * searchVector, so a fabricated pin is not rejected — it is unrepresentable.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  searchVector,
  countDocuments,
  lexicalQueryNotices,
  rareQueryTokens,
  type LexicalOptions,
  type LexicalSearchError,
} from "./vector.ts";
import {
  classifyClaims,
  enforceClaimContract,
  type ContractSource,
} from "./contract.ts";
import {
  verifyPin,
  isCitableSourceKind,
  CITABLE_SOURCE_KINDS,
} from "./pins.ts";
import { complete } from "./model.ts";

export type CompleteFn = (prompt: string) => Promise<string>;

export interface AskClaimResult {
  text: string;
  kind: string;
  status: string;
  citedRefs: string[];
  rejected: { refId: string; reason: string }[];
  debtIds: string[];
}

export interface AskResult {
  answer: string;
  claims: AskClaimResult[];
  passages: {
    index: number;
    documentId: string;
    sourceRef: string | null;
    /**
     * How this passage should be shown to a human — see `passageLabel`.
     *
     * A file is now stored as many passage rows, so `sourceRef` alone is
     * `manual.md#p7`: a real location, but not one an operator can read. The
     * label carries the heading breadcrumb alongside it. Rendering a citation
     * as something nobody can check is the failure this whole project exists
     * to prevent, so the renderable form is part of the result rather than
     * something each caller re-derives.
     */
    label: string;
  }[];
  modelCalled: boolean;
  /**
   * Why retrieval returned what it did, when that is not self-evident from the
   * answer. Set both when nothing could be retrieved (and so no answer exists)
   * and when an answer *was* produced over a corpus some of whose matching
   * passages were withheld as uncitable — the second case is not a failure and
   * must be rendered next to the answer, not in place of it.
   */
  note?: string;
}

export interface AskOptions {
  /** Injected completion. When absent, `complete()` runs and records spend. */
  complete?: CompleteFn;
  /** Refuse assertions with zero verified sources instead of minting debt. */
  strict?: boolean;
  /** Passages to retrieve. Keep <= 99; see citedIndices. */
  k?: number;
  turnId?: string;
  sessionId?: string;
  /**
   * Embedding space to query. Left unset, retrieval resolves the same "auto"
   * embedder that `upsertDocument` (and therefore `chamber ingest`) defaults
   * to, so the query lands in the space the corpus was actually written into.
   *
   * Pinning a model here would be wrong in both directions: a corpus ingested
   * on a machine without the ONNX model is stored under `local-hash-v1` and a
   * MiniLM-pinned query matches nothing (`searchVector` filters on
   * `e.model = ?`), so every question would answer "nothing in the corpus
   * matches"; and if the model file is present but its Python runtime is not,
   * `embedLocal(q, "minilm")` throws rather than falling back — `ingest` and
   * `search` keep working while `ask` dies. Set it explicitly only to force a
   * space, e.g. `"local-hash-v1"` for hermetic tests.
   */
  model?: string;
  /**
   * Run the lexical leg alongside the vector leg. On by default: a question
   * naming something distinctive — a project codename, an identifier, a
   * person — is exactly the case a sentence embedder has no representation for,
   * and it is also the case a user is most confident the corpus contains.
   * Set false for a deliberately vector-only comparison.
   */
  hybrid?: boolean;
  /**
   * Treat the question as an exact phrase and retrieve only passages that
   * contain it. Narrowing, so opt-in; implies `hybrid`.
   */
  exact?: boolean;
}

const SYSTEM = [
  "Answer the question using ONLY the numbered passages below.",
  "After each claim you make, cite the passage number in square brackets, e.g. [2].",
  "If the passages do not answer the question, say \"I don't know\" and cite nothing.",
  "Never cite a number that is not listed below.",
].join("\n");

export function buildPrompt(
  question: string,
  passages: {
    index: number;
    title: string | null;
    sourceRef: string | null;
    body: string;
  }[],
): string {
  const rendered = passages
    .map(
      (p) =>
        `[${p.index}] ${p.title ?? "untitled"} (${p.sourceRef ?? "?"})\n${p.body}`,
    )
    .join("\n\n");
  return `${SYSTEM}\n\nPASSAGES:\n${rendered}\n\nQUESTION: ${question}`;
}

/**
 * Extract the distinct passage numbers cited in one claim, in order.
 *
 * Only a bare bracketed integer counts: `[1a]`, `[ 2 ]` and `[]` are prose.
 * The 1-2 digit bound caps this at passage 99 — beyond that a citation is not
 * seen at all and its claim reads as unsupported, which mints debt or refuses
 * under strict. That is the fail-closed direction, and `k` defaults to 8.
 */
export function citedIndices(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** What was dropped, why it can never be cited, and how to make it citable. */
function uncitableReason(uncitable: { sourceKind: string }[]): string {
  const kinds = [...new Set(uncitable.map((h) => h.sourceKind))].sort();
  return (
    `source kind ${kinds.join("/")} has no registered pin formula, so a ` +
    "citation to one could never verify. Re-index as vault_page " +
    "(`chamber index vault_page <title> <body> [ref]`) or use `chamber ingest`."
  );
}

/**
 * Explain an empty retrieval, distinguishing the three reasons it happens.
 *
 * "Nothing matches" and "everything that matches is uncitable" look identical
 * from the outside and mean opposite things: the first says ingest more, the
 * second says the corpus already holds the answer under a source kind that can
 * never back a claim. Silently conflating them is how filtering at retrieval
 * would trade one silent failure for another — a user who ran
 * `chamber index note …` would be told their own note does not exist.
 */
function emptyRetrievalNote(
  db: DatabaseSync,
  uncitable: { sourceKind: string }[],
): string {
  if (countDocuments(db) === 0) {
    return "nothing ingested yet — run `chamber ingest <path>`";
  }
  if (uncitable.length === 0) {
    return "nothing in the corpus matches this question";
  }
  return (
    `${uncitable.length} matching passage(s) are not citable: ` +
    uncitableReason(uncitable)
  );
}

/**
 * The same exclusion, reported when the answer still happens.
 *
 * The note above only ever fired when the filtered retrieval came back
 * completely empty, so in a mixed corpus — the normal case for a vault that
 * has ever seen `chamber index note …` — the operator was told nothing at all.
 * The best-matching passage could be withheld while a weaker citable one was
 * cited, and the claim then rendered `ALLOWED` against a passage that does not
 * contain the fact. The gate is not breached (the citation genuinely verifies)
 * and this is not a status change; it is the difference between "supported by
 * what you were shown" and "supported by everything the corpus has", which the
 * operator otherwise has no way to see.
 */
function withheldNote(uncitable: { sourceKind: string }[]): string {
  return (
    `${uncitable.length} matching passage(s) were withheld from the model ` +
    `and are not reflected in the answer above: ` +
    uncitableReason(uncitable)
  );
}

/**
 * What a dead lexical leg costs, said out loud.
 *
 * `searchVector` throws by default precisely so this cannot be forgotten. The
 * degradation is real — exact-term recall is gone — and it is invisible in the
 * answer, so it belongs next to it.
 */
function lexicalDegradedNote(e: { message: string }): string {
  return (
    "keyword (FTS5) retrieval was unavailable, so this answer used vector " +
    "similarity alone and a passage containing an exact rare term may have " +
    `been missed: ${e.message}`
  );
}

function joinNotes(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => p !== undefined && p !== "");
  return kept.length === 0 ? undefined : kept.join("; also: ");
}

/**
 * The retrieval-miss disclosure: an answer formed over the wrong passages is
 * indistinguishable from a right one — every claim can verify individually
 * while the passage that actually answers the question was never shown. That
 * is the lived failure this probe exists for, and it is the "green suite over
 * a broken gate" pattern reproduced at the retrieval layer.
 *
 * One extra `searchVector` call, only when the question contains rare terms
 * (df ≤ the ask's own k — see `rareQueryTokens` for why that ceiling is not a
 * magic number), in require mode so only passages actually containing a rare
 * term return. Any hit the model was not shown is named next to the answer.
 * Worded as "not among the passages shown", never "your answer is wrong" —
 * the probe proves presence elsewhere, not error here.
 */
function findMissedExactMatches(
  db: DatabaseSync,
  question: string,
  shown: { documentId: string }[],
  k: number,
  model: string | undefined,
  onLexicalError: (e: LexicalSearchError) => void,
): { term: string; label: string }[] {
  // The df lookup reads the FTS table directly, so a corpus whose FTS index
  // is broken throws here — before the probe's own searchVector could route
  // the failure into `onLexicalError`. The probe must not turn a degraded
  // leg into a crashed ask: the main path's lexical leg hits the same broken
  // table and reports it through `lexicalDegradedNote`, whose wording ("a
  // passage containing an exact rare term may have been missed") already
  // covers exactly what this probe can no longer check.
  let terms: string[];
  try {
    terms = rareQueryTokens(db, question, k);
  } catch {
    return [];
  }
  if (terms.length === 0) return [];
  const query = terms.join(" ");
  const probe = searchVector(db, query, {
    k: 3,
    model,
    sourceKinds: CITABLE_SOURCE_KINDS,
    lexical: { query, mode: "terms", require: true },
    onLexicalError,
  });
  const shownIds = new Set(shown.map((s) => s.documentId));
  const misses: { term: string; label: string }[] = [];
  for (const h of probe) {
    if (shownIds.has(h.documentId)) continue;
    const body = h.body.toLowerCase();
    const term = terms.find((t) => body.includes(t.toLowerCase()));
    if (!term) continue;
    misses.push({
      term,
      label: passageLabel(h.sourceRef, h.title, h.documentId),
    });
    if (misses.length === 2) break;
  }
  return misses;
}

function missedExactNote(
  misses: { term: string; label: string }[],
): string | undefined {
  if (misses.length === 0) return undefined;
  return misses
    .map(
      (m) =>
        `an exact match for "${m.term}" was not among the passages shown to ` +
        `the model: ${m.label}`,
    )
    .join("; also: ");
}

/**
 * The corpus's dominant embedding model versus the model the query actually
 * embedded with. The semantic leg filters on the query's own model, so when a
 * MiniLM corpus meets a hash-embedded query (python without onnxruntime on
 * the spawned server's PATH — KNOWN_LIMITATIONS entry 15's operator-facing
 * symptom), semantic retrieval sees zero rows and "nothing matches" names no
 * cause. This names it, alongside the answer, in the same note channel every
 * other retrieval caveat uses.
 */
function embedderMismatchNote(
  db: DatabaseSync,
  queryModel: string | undefined,
): string | undefined {
  if (queryModel === undefined) return undefined;
  const dominant = db
    .prepare(
      `SELECT model FROM vector_embedding GROUP BY model
        ORDER BY COUNT(*) DESC LIMIT 1`,
    )
    .get() as { model: string } | undefined;
  if (!dominant || dominant.model === queryModel) return undefined;
  return (
    `the question embedded as ${queryModel} but most of the corpus is ` +
    `embedded as ${dominant.model} — semantic retrieval cannot see across ` +
    `that split, so this answer leaned on exact-word matching only. If the ` +
    `corpus side is minilm, check CHAMBER_PYTHON points at a python with ` +
    `onnxruntime`
  );
}

/**
 * Render one retrieved passage as a location a human can actually go to.
 *
 * `path#p7 — Ops Manual › Courier Reconciliation` rather than a bare document
 * id or a bare chunk ref: the path says which file to open, the ordinal
 * disambiguates repeated headings, and the breadcrumb says where in the file
 * to look. Falls back to the ref, then the id, so a corpus row written by
 * something other than `chamber ingest` still renders as *something*
 * addressable instead of an empty string.
 */
export function passageLabel(
  sourceRef: string | null,
  title: string | null,
  documentId: string,
): string {
  const where = sourceRef ?? documentId;
  return title !== null && title.trim() !== "" ? `${where} — ${title}` : where;
}

export async function runAsk(
  db: DatabaseSync,
  question: string,
  opts: AskOptions = {},
): Promise<AskResult> {
  const k = opts.k ?? 8;
  // Retrieve unfiltered first, purely so the passages a citation cannot be made
  // out of are *counted*. Filtering them away in SQL is still what happens —
  // see CITABLE_SOURCE_KINDS: a row of any other kind cannot verify (no
  // registered formula) and cannot be stored as support (belief_source.kind
  // CHECK), so putting one in front of the model buys a citation that is
  // guaranteed to be rejected, and the rejection lands as blocking debt on the
  // claim hash, refusing that assertion permanently. Filter before spending,
  // not after. But a silent filter is its own failure, so the drop is measured
  // here and reported below.
  //
  // When the top-k is already all citable — every corpus written only by
  // `chamber ingest`, `indexCodeTree` or `scip` — the unrestricted top-k and
  // the restricted top-k are the same rows by construction, so the second
  // query is skipped and this costs one query, as before. Only a genuinely
  // mixed corpus pays for the re-query, and that is the case that has
  // something to report.
  // Hybrid by default. The two searchVector calls below share one lexical
  // spec and one failure sink, so a degraded leg is reported once rather than
  // per query.
  const lexical: LexicalOptions | undefined =
    opts.hybrid === false && opts.exact !== true
      ? undefined
      : {
          query: question,
          mode: opts.exact === true ? "phrase" : "terms",
          require: opts.exact === true,
        };
  // What the lexical leg quietly did to the question before searching for it —
  // dropped its tail at MAX_LEXICAL_TERMS, or found nothing in it to search
  // for at all. Neither is an error, and neither is visible in the answer, so
  // both ride along on the same note as the other retrieval caveats.
  const lexicalNotice =
    lexical === undefined
      ? undefined
      : lexicalQueryNotices(question)
          .map((n) => n.message)
          .join("; ") || undefined;
  let lexicalError: LexicalSearchError | undefined;
  let queryEmbedModel: string | undefined;
  const onQueryEmbedded = (m: string): void => {
    queryEmbedModel = m;
  };
  // Answering semantically is better than not answering, but only if the user
  // is told the answer was formed without the lexical leg — otherwise a broken
  // index is indistinguishable from a corpus that does not contain the answer,
  // which is the silent quality regression this whole change exists to remove.
  const onLexicalError = (e: LexicalSearchError): void => {
    lexicalError = e;
  };

  const unfiltered = searchVector(db, question, {
    k,
    model: opts.model,
    lexical,
    onLexicalError,
    onQueryEmbedded,
  });
  const uncitable = unfiltered.filter((h) => !isCitableSourceKind(h.sourceKind));
  const hits =
    uncitable.length === 0
      ? unfiltered
      : searchVector(db, question, {
          k,
          model: opts.model,
          sourceKinds: CITABLE_SOURCE_KINDS,
          lexical,
          onLexicalError,
        });

  const passages = hits.map((h, i) => ({
    index: i + 1,
    documentId: h.documentId,
    sourceRef: h.sourceRef,
    title: h.title,
    body: h.body,
    snapshotHash: h.snapshotHash,
    sourceKind: h.sourceKind,
  }));

  // Skipped under `exact`: the user already aimed the lexical leg, and a
  // probe that re-finds what exact mode just retrieved would either be
  // redundant or — firing on some other rare term — teach operators the note
  // is noise. Runs on the zero-passages path too: "nothing was shown, and an
  // exact match exists" is the strongest version of the disclosure.
  const missedExact =
    opts.exact === true
      ? []
      : findMissedExactMatches(db, question, hits, k, opts.model, onLexicalError);

  // Zero passages means the model would be answering from nothing but its own
  // weights, at cost, with no citation it could possibly make good on. Skip it
  // entirely rather than pay for confident fabrication and then reject it.
  if (passages.length === 0) {
    return {
      answer: "",
      claims: [],
      passages: [],
      modelCalled: false,
      note: joinNotes(
        emptyRetrievalNote(db, uncitable),
        embedderMismatchNote(db, queryEmbedModel),
        missedExactNote(missedExact),
        lexicalError && lexicalDegradedNote(lexicalError),
        lexicalNotice,
      ),
    };
  }

  const prompt = buildPrompt(question, passages);
  const answer = opts.complete
    ? await opts.complete(prompt)
    : (
        await complete(db, {
          messages: [{ role: "user", content: prompt }],
          channel: "chat",
          turnId: opts.turnId,
          sessionId: opts.sessionId,
        })
      ).text;

  const byIndex = new Map(passages.map((p) => [p.index, p]));
  const claims = classifyClaims(answer);
  const out: AskClaimResult[] = [];

  for (const claim of claims) {
    const indices = citedIndices(claim.text);
    const citedRefs: string[] = [];
    const rejected: { refId: string; reason: string }[] = [];
    const sources: ContractSource[] = [];

    for (const n of indices) {
      const p = byIndex.get(n);
      if (!p) {
        // No document id exists to name here — the model cited a passage that
        // was never retrieved. Report the index it wrote, which is the only
        // thing it actually said.
        rejected.push({ refId: `[${n}]`, reason: "index_out_of_range" });
        continue;
      }
      // The pin must claim what the row actually IS. Hardcoding "vault_page"
      // here was the whole bug: verifyPin binds source_kind in its lookup, so
      // a retrieved `note`/`x_tweet`/`skill`/`other` row resolved to no row at
      // all and came back `not_found` — the gate telling the operator a real,
      // correctly-cited passage was a hallucination, then minting blocking
      // debt on the claim hash that refused that assertion forever.
      //
      // Retrieval above already restricts to citable kinds, so this guard is
      // unreachable today; it stays because it is the thing that makes the
      // kind flow through as a *type* rather than a cast, and because a widened
      // filter must fail as "no formula for this kind", never as "your document
      // does not exist".
      if (!isCitableSourceKind(p.sourceKind)) {
        rejected.push({ refId: p.documentId, reason: "kind_unregistered" });
        continue;
      }
      // Diagnostic, not the gate. enforceClaimContract -> commitBelief
      // re-verifies every pin inside its own transaction and drops what fails,
      // so an unverified source passed on is reported, never recorded. Running
      // it here too is what lets the caller show *why* a citation vanished.
      const verdict = verifyPin(db, {
        kind: p.sourceKind,
        refId: p.documentId,
        snapshotHash: p.snapshotHash,
      });
      if (!verdict.ok) {
        rejected.push({ refId: p.documentId, reason: verdict.reason! });
        continue;
      }
      citedRefs.push(p.documentId);
      sources.push({
        kind: p.sourceKind,
        refId: p.documentId,
        snapshotHash: p.snapshotHash,
        provenance: "vector",
      });
    }

    // Per claim, not per reply: enforceReplyContract applies one source list to
    // every claim it classifies, so a claim citing [3] would be credited with
    // [5]'s pin too. enforceClaimContract is also the commit path — it calls
    // commitBelief itself, so calling commitBelief here would double-commit.
    const r = enforceClaimContract(db, claim, {
      sources,
      strict: opts.strict,
      turnId: opts.turnId,
      sessionId: opts.sessionId,
    });

    // A pin can pass the diagnostic above and still be dropped by the commit
    // transaction — another unit sharing this DB may edit the row in between,
    // which is exactly why commitBelief re-verifies rather than trusting the
    // caller. Fold those drops in, and take them back out of citedRefs: a
    // source that was not written must not be rendered as one that was.
    // Otherwise the only record of the drop is a gate_event nothing reads.
    const droppedAtCommit = new Set(
      (r.rejectedSources ?? []).map((rj) => rj.refId),
    );
    for (const rj of r.rejectedSources ?? []) {
      if (!rejected.some((x) => x.refId === rj.refId)) rejected.push(rj);
    }

    out.push({
      text: claim.text,
      kind: claim.kind,
      status: r.status,
      citedRefs: citedRefs.filter((id) => !droppedAtCommit.has(id)),
      rejected,
      debtIds: r.debtIds ?? [],
    });
  }

  return {
    answer,
    claims: out,
    passages: passages.map((p) => ({
      index: p.index,
      documentId: p.documentId,
      sourceRef: p.sourceRef,
      label: passageLabel(p.sourceRef, p.title, p.documentId),
    })),
    modelCalled: true,
    // Alongside the answer, never instead of it: the answer is real and its
    // citations verified, and the operator still needs to know it was formed
    // over a restricted view of the corpus.
    note: joinNotes(
      uncitable.length > 0 ? withheldNote(uncitable) : undefined,
      embedderMismatchNote(db, queryEmbedModel),
      missedExactNote(missedExact),
      lexicalError && lexicalDegradedNote(lexicalError),
      lexicalNotice,
    ),
  };
}
