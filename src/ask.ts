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
import { searchVector, countDocuments } from "./vector.ts";
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
  passages: { index: number; documentId: string; sourceRef: string | null }[];
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
  const unfiltered = searchVector(db, question, { k, model: opts.model });
  const uncitable = unfiltered.filter((h) => !isCitableSourceKind(h.sourceKind));
  const hits =
    uncitable.length === 0
      ? unfiltered
      : searchVector(db, question, {
          k,
          model: opts.model,
          sourceKinds: CITABLE_SOURCE_KINDS,
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

  // Zero passages means the model would be answering from nothing but its own
  // weights, at cost, with no citation it could possibly make good on. Skip it
  // entirely rather than pay for confident fabrication and then reject it.
  if (passages.length === 0) {
    return {
      answer: "",
      claims: [],
      passages: [],
      modelCalled: false,
      note: emptyRetrievalNote(db, uncitable),
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
    })),
    modelCalled: true,
    // Alongside the answer, never instead of it: the answer is real and its
    // citations verified, and the operator still needs to know it was formed
    // over a restricted view of the corpus.
    note: uncitable.length > 0 ? withheldNote(uncitable) : undefined,
  };
}
