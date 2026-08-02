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
import { classifyClaims, enforceClaimContract } from "./contract.ts";
import { verifyPin } from "./pins.ts";
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

export async function runAsk(
  db: DatabaseSync,
  question: string,
  opts: AskOptions = {},
): Promise<AskResult> {
  const k = opts.k ?? 8;
  const hits = searchVector(db, question, { k, model: opts.model });

  const passages = hits.map((h, i) => ({
    index: i + 1,
    documentId: h.documentId,
    sourceRef: h.sourceRef,
    title: h.title,
    body: h.body,
    snapshotHash: h.snapshotHash,
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
      note:
        countDocuments(db) === 0
          ? "nothing ingested yet — run `chamber ingest <path>`"
          : "nothing in the corpus matches this question",
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
    const sources: {
      kind: "vault_page";
      refId: string;
      snapshotHash: string;
      provenance: "vector";
    }[] = [];

    for (const n of indices) {
      const p = byIndex.get(n);
      if (!p) {
        // No document id exists to name here — the model cited a passage that
        // was never retrieved. Report the index it wrote, which is the only
        // thing it actually said.
        rejected.push({ refId: `[${n}]`, reason: "index_out_of_range" });
        continue;
      }
      // Diagnostic, not the gate. enforceClaimContract -> commitBelief
      // re-verifies every pin inside its own transaction and drops what fails,
      // so an unverified source passed on is reported, never recorded. Running
      // it here too is what lets the caller show *why* a citation vanished.
      const verdict = verifyPin(db, {
        kind: "vault_page",
        refId: p.documentId,
        snapshotHash: p.snapshotHash,
      });
      if (!verdict.ok) {
        rejected.push({ refId: p.documentId, reason: verdict.reason! });
        continue;
      }
      citedRefs.push(p.documentId);
      sources.push({
        kind: "vault_page",
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

    out.push({
      text: claim.text,
      kind: claim.kind,
      status: r.status,
      citedRefs,
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
  };
}
