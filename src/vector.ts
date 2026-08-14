/**
 * Local vector search for Chamber corpus.
 *
 * - Documents + Float32 embeddings in SQLite
 * - Cosine similarity k-NN in process (no server)
 * - Default embedder: MiniLM-L6-v2 quantized ONNX (384-d) when model present
 * - Fallback: local-hash-v1; inject via upsertDocument({ embedding })
 *
 * Feeds future citation-debt payment (snapshot_hash + span pins).
 */

import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { newId, sha256 } from "./hash.ts";
import { embedLocal, MINILM_MODEL } from "./embedder.ts";

export type VectorSourceKind =
  | "vault_page"
  | "x_tweet"
  | "transcript"
  | "note"
  | "skill"
  | "other";

export const LOCAL_HASH_MODEL = "local-hash-v1";
export const LOCAL_HASH_DIMS = 256;

// ─── vector math ─────────────────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("cosine: dim mismatch");
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function float32ToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToFloat32(blob: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.byteLength % 4 !== 0) {
    throw new Error("vector blob length not multiple of 4");
  }
  // Copy into aligned ArrayBuffer
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

function l2Normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/**
 * Zero-dependency local embedder.
 * Feature-hash character n-grams (3–5) into fixed dims; L2-normalized.
 * Not semantic SOTA — good enough for local demos + tests; swap via injected vectors.
 */
export function localHashEmbed(
  text: string,
  dims = LOCAL_HASH_DIMS,
): Float32Array {
  const v = new Float32Array(dims);
  const norm = text.toLowerCase().normalize("NFKC");
  const padded = `  ${norm}  `;
  for (let n = 3; n <= 5; n++) {
    for (let i = 0; i + n <= padded.length; i++) {
      const gram = padded.slice(i, i + n);
      const h = createHash("sha256").update(gram).digest();
      const idx = h.readUInt32BE(0) % dims;
      const sign = h[4]! & 1 ? 1 : -1;
      v[idx]! += sign;
    }
  }
  // light token boost
  for (const tok of norm.split(/\W+/).filter(Boolean)) {
    const h = createHash("sha256").update(`T:${tok}`).digest();
    const idx = h.readUInt32BE(0) % dims;
    v[idx]! += 2;
  }
  return l2Normalize(v);
}

// ─── document API ────────────────────────────────────────────────────────────

export interface UpsertDocumentInput {
  id?: string;
  sourceKind: VectorSourceKind;
  sourceRef?: string;
  title?: string;
  body: string;
  metadata?: Record<string, unknown>;
  /** If omitted, localHashEmbed(body) is used */
  embedding?: Float32Array;
  model?: string;
}

export interface VectorHit {
  documentId: string;
  /**
   * Cosine similarity against the query in this document's embedding space.
   *
   * Deliberately *not* the fused score: `minScore` is expressed on this scale,
   * every existing caller compares against it on this scale, and a number whose
   * meaning changes depending on whether a lexical leg happened to run is not a
   * number anyone can threshold. Ordering uses `fusedScore ?? score`.
   */
  score: number;
  sourceKind: string;
  sourceRef: string | null;
  title: string | null;
  body: string;
  snapshotHash: string;
  model: string;
  /**
   * The lexical leg's contribution for this passage, in [0,1]. Absent when the
   * lexical leg did not run.
   *
   * Three factors: the share of the query's own idf mass the passage contains
   * (`lexicalStrength`), how rare the rarest term in the query is against this
   * corpus (`queryRarity`), and a taper that zeroes the contribution at the
   * edge of the bm25 pool (`candidateTaper`). The first alone saturates at 1.0
   * for any single-term query; the second is what keeps a common word from
   * buying the full `LEXICAL_WEIGHT`.
   */
  lexicalScore?: number;
  /** The value results were ranked by. Absent when retrieval was semantic-only. */
  fusedScore?: number;
  /** Which leg(s) put this row in the result. Absent when only one leg ran. */
  retrievedBy?: "semantic" | "lexical" | "both";
}

/**
 * A passage's identity is where it is, not when it was first seen.
 *
 * `newId` is sha256 over `Date.now()`-plus-`Math.random()`, so every row minted
 * a fresh identity and rebuilding the index renamed the entire corpus. Measured
 * on the live database: a from-scratch rebuild on 2026-08-05 re-created all
 * 28,627 rows, and every belief committed the day before reported `not_found`
 * against evidence that was still there, byte-identical, at the same passage
 * index. Re-indexing is routine, so the effect was a total-loss drift alarm
 * fired precisely when nothing had changed — the one failure a drift detector
 * cannot afford, because it teaches the operator to ignore it.
 *
 * Deriving the id from (kind, ref) makes a rebuild re-mint the same id for the
 * same passage, so pins survive by construction. Rows written before this keep
 * their random ids: ingest passes the existing id through `idByRef`, so they are
 * updated in place rather than duplicated.
 *
 * This does not cover a note whose passages renumber under an edit — that
 * changes the ref, and a pin to it should report drift, because that passage
 * really did move. `verifyPin`'s content fallback is what catches those.
 *
 * The ingest root is part of the identity, not decoration: `sourceRef` is
 * relative to its root, so two roots can each hold `research/note.md#p0`, and
 * keying on the ref alone merged them into one row — one vault silently
 * answering with another's text. Roots are kept distinct here for the same
 * reason ingest tracks them separately.
 */
export function stableDocumentId(
  sourceKind: VectorSourceKind,
  sourceRef?: string,
  ingestRoot?: unknown,
): string {
  if (!sourceRef) return newId("vdoc");
  const root = typeof ingestRoot === "string" ? ingestRoot : null;
  return `vdoc_${sha256(JSON.stringify([sourceKind, root, sourceRef])).slice(0, 16)}`;
}

export function upsertDocument(
  db: DatabaseSync,
  input: UpsertDocumentInput,
): { id: string; model: string; dims: number; replaced: boolean } {
  const id =
    input.id ??
    stableDocumentId(input.sourceKind, input.sourceRef, input.metadata?.ingestRoot);
  const body = input.body;
  // JSON.stringify of a fixed 3-element array, NOT [...].join("\n"): joining is
  // not injective across its own separator, so {title:"X", body:"Y\nZ"} and
  // {title:"X\nY", body:"Z"} minted one identical pin. Moving a newline from the
  // end of a title to the start of a body was therefore undetectable drift —
  // precisely what a content pin exists to catch, and vault notes are multi-line
  // markdown. JSON escapes separators inside each field, so the array framing
  // is unambiguous about where fields end — but that alone does not make the
  // formula injective: title/sourceRef are nullable, and defaulting to "" —
  // `input.title ?? ""` — *before* building the array collapsed NULL and ""
  // to the same element, reopening the identical undetectable-drift bug one
  // level up. `?? null` below keeps NULL and "" distinct and only normalizes
  // `undefined` (which JSON.stringify would otherwise also render as `null`
  // inside the array) — see vaultPageHash in src/pins.ts for the full
  // account. Must stay byte-identical to it.
  const snapshot = sha256(
    JSON.stringify([input.title ?? null, body, input.sourceRef ?? null]),
  );
  let model: string;
  let vec: Float32Array;
  if (input.embedding) {
    model = input.model ?? "injected";
    vec = l2Normalize(input.embedding);
  } else if (input.model === LOCAL_HASH_MODEL) {
    model = LOCAL_HASH_MODEL;
    vec = localHashEmbed(body);
  } else {
    // Default: real MiniLM when available, else hash
    const emb = embedLocal(body, input.model === MINILM_MODEL ? "minilm" : "auto");
    model = input.model ?? emb.model;
    vec = emb.vector;
  }
  const dims = vec.length;

  const existing = db
    .prepare(`SELECT id FROM vector_document WHERE id = ?`)
    .get(id) as { id: string } | undefined;

  // Whether this call destroyed a passage. Since identity is (kind, root, ref),
  // a caller reusing a ref silently replaced the row it did not know was there —
  // `chamber index` printed "indexed <id>" and an unchanged corpus size while
  // the earlier excerpt disappeared, taking any pin to it with it. Re-ingest
  // relies on exactly this overwrite, so the fix is to report it, not block it.
  const replaced = !!existing;

  if (existing) {
    db.prepare(
      `UPDATE vector_document
       SET source_kind = ?, source_ref = ?, title = ?, body = ?,
           snapshot_hash = ?, metadata_json = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    ).run(
      input.sourceKind,
      input.sourceRef ?? null,
      input.title ?? null,
      body,
      snapshot,
      input.metadata ? JSON.stringify(input.metadata) : null,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO vector_document (
         id, source_kind, source_ref, title, body, snapshot_hash, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.sourceKind,
      input.sourceRef ?? null,
      input.title ?? null,
      body,
      snapshot,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
  }

  db.prepare(
    `INSERT INTO vector_embedding (document_id, model, dims, vector_blob)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       model = excluded.model,
       dims = excluded.dims,
       vector_blob = excluded.vector_blob,
       embedded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(id, model, dims, float32ToBlob(vec));

  return { id, model, dims, replaced };
}

export function deleteDocument(db: DatabaseSync, id: string): boolean {
  const r = db.prepare(`DELETE FROM vector_document WHERE id = ?`).run(id);
  return Number(r.changes ?? 0) > 0;
}

// ─── lexical leg (FTS5) ──────────────────────────────────────────────────────

/**
 * Weights of the two legs. They sum to 1 and both legs are mapped onto [0,1]
 * *before* they are mixed, so the sum is a genuine convex combination rather
 * than the old `0.7*cosine + 0.3*(1/(1+bm25))`, which mixed a bounded
 * similarity with a reciprocal of an unbounded, corpus-dependent score.
 *
 * The lexical share is the minority share on purpose: an incidental match on a
 * mid-frequency word must be able to reorder near-ties, never to overturn a
 * clear semantic winner. See `lexicalStrength` for why 0.3 of a *calibrated*
 * lexical score is nonetheless enough to lift a rare proper noun.
 */
export const SEMANTIC_WEIGHT = 0.7;
export const LEXICAL_WEIGHT = 0.3;

/**
 * How deep the bm25 candidate list keeps its *full* lexical contribution.
 *
 * Rows past this depth are still retrieved — see `LEXICAL_TAPER_FACTOR` — but
 * their contribution decays, because a hard edge here is a ranking cliff. Two
 * adjacent bm25 scores differing in the fourth decimal used to differ by the
 * whole `LEXICAL_WEIGHT` in the fused score purely because one of them was the
 * 50th row and the other the 51st.
 */
export const LEXICAL_CANDIDATE_LIMIT = 50;

/**
 * The bm25 pool runs this many times deeper than `LEXICAL_CANDIDATE_LIMIT`,
 * and the lexical contribution tapers linearly to exactly zero across the
 * extra depth.
 *
 * The taper exists to make the truncation continuous, not to rank: inside the
 * first `LEXICAL_CANDIDATE_LIMIT` rows the contribution is untouched, so bm25
 * magnitude remains the only signal there. Past it the factor slides to 0 at
 * the pool edge, which is what the rows *outside* the pool already get. A
 * passage one row on the wrong side of the boundary therefore loses a rounding
 * error rather than the entire lexical weight.
 */
export const LEXICAL_TAPER_FACTOR = 4;

/**
 * Cap on tokens taken from user text. A pathological paste would otherwise
 * become a several-thousand-term OR, and each term costs one df probe.
 */
export const MAX_LEXICAL_TERMS = 32;

/**
 * Ceiling on the rows scanned to establish a term's document frequency.
 *
 * df only feeds idf, and idf is flat and near-zero for anything this common, so
 * stopping early changes the weighting of "the" by a rounding error while
 * keeping a stopword's probe O(cap) instead of O(corpus).
 *
 * The error it can introduce is one-directional, and deliberately so. A capped
 * df is never larger than the true df, and both consumers are monotone in the
 * safe direction:
 *
 *  - `bm25Idf` decreases in df, so an under-counted df *raises* idf, *raises*
 *    the `idfMass` denominator, and therefore *lowers* `lexicalStrength`. A
 *    capped term can only under-sell a passage, never over-sell one.
 *  - `queryRarity` would move the other way — an under-counted df reads as
 *    rarer — so a df that actually reached the cap is treated there as
 *    maximally common instead of being trusted. See `queryRarity`.
 *
 * So the cap can only deflate the lexical contribution, and a deflated lexical
 * contribution cannot promote anything: the semantic leg is untouched and the
 * fusion is a sum of non-negative terms. It also does not fire on any corpus
 * near this size — the cap is ~49% of the 20,447-passage vault corpus, whose
 * most common indexed token ("the") reaches df 8,963.
 */
const DF_SCAN_CAP = 10_000;

export type LexicalMode = "terms" | "phrase";

export interface LexicalOptions {
  /** Raw user text. Sanitised here; never interpolated into SQL. */
  query: string;
  /**
   * `terms` (default): every token becomes a quoted literal OR'd together, so
   * the leg is a *recall* leg — a passage matching one distinctive token is a
   * candidate. `phrase`: the tokens become one exact FTS5 phrase.
   */
  mode?: LexicalMode;
  /**
   * Make the lexical leg authoritative: only lexical matches are returned.
   * This is the old (wrong-by-default) behaviour, kept because a quoted phrase
   * or a distinctive identifier genuinely should narrow — but opt-in, because
   * as a default it discards every passage that answers the question in words
   * the asker did not happen to use.
   */
  require?: boolean;
  /**
   * bm25 depth kept at full contribution (default `LEXICAL_CANDIDATE_LIMIT`).
   * The pool actually scanned is `LEXICAL_TAPER_FACTOR` times this, with the
   * contribution tapering to zero across the remainder.
   */
  limit?: number;
}

/**
 * The lexical leg could not run.
 *
 * `searchVector` throws this rather than degrading, because a lexical leg that
 * disappears does not fail — it quietly returns worse answers, and the caller
 * has no way to tell that from "the corpus does not contain it". A caller that
 * would rather answer semantically than not at all opts in by passing
 * `onLexicalError`, and then owes the user a visible note.
 */
export class LexicalSearchError extends Error {
  readonly matchExpr: string;
  constructor(matchExpr: string, cause: unknown) {
    super(
      `lexical retrieval failed for MATCH ${matchExpr}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "LexicalSearchError";
    this.matchExpr = matchExpr;
    this.cause = cause;
  }
}

/**
 * Split user text into FTS5-safe tokens.
 *
 * Unicode letters, digits and `_` only. Everything else — quotes, hyphens,
 * parentheses, colons, `*` — is a separator, which is what makes the result
 * safe: the characters that carry meaning in the MATCH grammar cannot appear
 * in a token, so quoting a token can never be escaped out of. `_` is kept so
 * `snake_case` survives as a phrase (FTS5's unicode61 tokenizer splits on it
 * on both the query and the indexing side, so the two still agree).
 */
function allLexicalTokens(text: string): string[] {
  return text.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/**
 * The same tokens, capped at `MAX_LEXICAL_TERMS` — what the leg actually
 * searches for. The gap between this and `allLexicalTokens` is a silent
 * degradation, which is why `lexicalQueryNotices` reports it.
 */
function lexicalTokens(text: string): string[] {
  return allLexicalTokens(text).slice(0, MAX_LEXICAL_TERMS);
}

/**
 * Something the lexical leg silently did to the user's query.
 *
 * Both cases below are indistinguishable from an honest empty result at the
 * point where the user reads it — the same failure mode `LexicalSearchError`
 * exists to prevent, one level earlier in the pipeline. They are not errors
 * (the search still runs and still returns its best answer), so they are
 * reported rather than thrown, and every command that runs a lexical leg is
 * expected to print them.
 */
export interface LexicalNotice {
  kind: "truncated" | "no_terms";
  message: string;
}

/**
 * Report what `toMatchExpression` will quietly do to `text`.
 *
 * - `no_terms`: sanitisation left nothing to match on. `--exact "((()))"`, an
 *   emoji-only query and a zero-width space all reach the corpus as *no query
 *   at all* and come back "no hits", which reads as "the corpus does not
 *   contain that phrase" — a claim this search never actually tested.
 * - `truncated`: the query ran past `MAX_LEXICAL_TERMS` and the tail was
 *   dropped. A distinctive identifier pasted at word 40 of a wall of text is
 *   then not searched for, and it is exactly the term the user was counting on.
 */
export function lexicalQueryNotices(text: string): LexicalNotice[] {
  const all = allLexicalTokens(text);
  if (all.length === 0) {
    return [
      {
        kind: "no_terms",
        message:
          "the keyword leg had nothing to search for: no letters or digits " +
          "survived sanitisation, so any 'no hits' below is about the query, " +
          "not about the corpus",
      },
    ];
  }
  if (all.length > MAX_LEXICAL_TERMS) {
    const dropped = all.slice(MAX_LEXICAL_TERMS);
    const shown = dropped.slice(0, 5).join(", ");
    return [
      {
        kind: "truncated",
        message:
          `the keyword leg used the first ${MAX_LEXICAL_TERMS} of ` +
          `${all.length} terms; ${dropped.length} were not searched for ` +
          `(${shown}${dropped.length > 5 ? ", …" : ""})`,
      },
    ];
  }
  return [];
}

/**
 * Translate user text into an FTS5 MATCH expression, or null if there is
 * nothing to match on.
 *
 * Every token is wrapped in double quotes, which in FTS5 makes it a string
 * literal: `AND`, `OR`, `NOT`, `NEAR` and a trailing `-` stop being operators
 * and become the words the user typed. The reported query
 * `gbrain Hindsight memory bolt-ons revealed preference` is a syntax error
 * verbatim (`no such column: ons`); sanitised it is a plain 7-term disjunction.
 */
export function toMatchExpression(
  text: string,
  mode: LexicalMode = "terms",
): string | null {
  const tokens = lexicalTokens(text);
  if (tokens.length === 0) return null;
  if (mode === "phrase") return `"${tokens.join(" ")}"`;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * The idf SQLite's fts5 `bm25()` uses, reproduced exactly.
 *
 * Classic Robertson idf, floored at 1e-6 where it would go non-positive — i.e.
 * a term in more than about half the corpus contributes essentially nothing.
 * "Exactly" is the point: this value is the denominator of `lexicalStrength`,
 * whose numerator is a sum of these same idfs weighted by term-frequency
 * saturation. Use the `log(1 + x)` variant instead and the ratio stops being a
 * fraction of anything — verified against fts5 directly (a single term with
 * tf=1 in an average-length document returns `bm25 = -idf`).
 */
function bm25Idf(total: number, df: number): number {
  const idf = Math.log((total - df + 0.5) / (df + 0.5));
  return idf <= 0 ? 1e-6 : idf;
}

/** Document frequency of `token`, saturating at `DF_SCAN_CAP` — see there. */
function documentFrequency(db: DatabaseSync, token: string): number {
  const row = db
    .prepare(
      `SELECT count(*) AS c FROM (
         SELECT rowid FROM vector_document_fts
         WHERE vector_document_fts MATCH ? LIMIT ?
       )`,
    )
    .get(`"${token}"`, DF_SCAN_CAP) as { c: number };
  return row?.c ?? 0;
}

/**
 * The question's tokens rare enough that every document containing one could
 * have fit in a `k`-sized retrieval — so if none of them made it, the ranking
 * actively excluded every occurrence of a term that rare. That is the
 * retrieval-miss class `runAsk`'s disclosure probe exists to catch, and tying
 * the ceiling to the caller's own `k` is what keeps this from being one more
 * magic constant: "rare" means "small relative to what was shown", not an
 * absolute.
 *
 * df = 0 tokens are excluded — a term the corpus does not contain cannot have
 * been missed, only absent. Rarest first, so a caller that truncates keeps
 * the most tellable misses.
 */
export function rareQueryTokens(
  db: DatabaseSync,
  text: string,
  dfCeiling: number,
): string[] {
  const seen = new Set<string>();
  const out: { token: string; df: number }[] = [];
  for (const token of lexicalTokens(text)) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const df = documentFrequency(db, token);
    if (df > 0 && df <= dfCeiling) out.push({ token, df });
  }
  return out.sort((a, b) => a.df - b.df).map((t) => t.token);
}

/**
 * Normalise SQLite's bm25 onto [0,1] *without* looking at the other candidates.
 *
 * The denominator is the query's own idf mass — the total information content
 * of the terms the user typed, measured against this corpus. So the score reads
 * as "what fraction of what you asked for does this passage actually contain",
 * which is an absolute quantity: adding or removing decoys does not rescale
 * anybody, and a query nothing matches well produces uniformly small numbers
 * instead of anointing its own least-bad candidate 1.0.
 *
 * That last property is why this is not min-max fusion. Min-max normalisation
 * of either leg makes the top candidate 1.0 and the bottom 0.0 *by definition*,
 * so a natural-language question whose answer shares no wording with it would
 * see some irrelevant passage that happens to contain one of its function words
 * promoted to a perfect lexical score — fixing lexical recall by breaking
 * semantic recall. It is also why this is not reciprocal-rank fusion: RRF sees
 * only ordinal position, so "matched the one rare proper noun in the corpus"
 * and "matched the word `for`" are both just rank 1, and the second would carry
 * exactly as much weight as the first. The magnitude of bm25 is the signal here
 * — it is idf-weighted, so rarity is already priced in — and RRF throws it away.
 *
 * `min(1, …)` because bm25's term-frequency saturation can push a single term's
 * contribution above its idf (up to k1+1) when a passage repeats it.
 *
 * That last paragraph about rarity is only true because `queryRarity` enforces
 * it; this ratio on its own does not, and the clamp above is where it breaks.
 * The denominator is the query's *own* idf mass, so for a one-term query the
 * ratio is `idf(t)·tfSat / idf(t)` — the term drops out, tfSat pushes the rest
 * past 1, and essentially every passage containing the term clamps to exactly
 * 1.0 whether the term is `zarvox` or `the`. That is precisely the RRF failure
 * disclaimed above, plus a cliff at the candidate cut that RRF does not have.
 * Measured on the 20,447-passage vault corpus, `memory` returned 50 candidates
 * all at 1.0000. Relative strength *within* a query is what this function
 * measures; it cannot express how much the query was worth asking, and
 * `queryRarity` supplies that missing absolute factor.
 */
function lexicalStrength(bm25Score: number, idfMass: number): number {
  if (idfMass <= 0) return 0;
  return Math.min(1, Math.abs(bm25Score) / idfMass);
}

/**
 * How much lexical weight this query has *earned*, in [0,1].
 *
 * `lexicalStrength` is a share of the query's own idf mass, which makes it
 * blind in exactly one place: a query whose terms all have similar df
 * normalises that df away. Every passage containing the single word `the`
 * scored a perfect lexical 1.0 and collected the full `LEXICAL_WEIGHT`, so
 * 50 essentially arbitrary passages were each handed a 0.3 fused-score bonus
 * over the rest of the corpus. This factor is the absolute counterweight: it
 * asks how rare the *rarest* term the user typed actually is, against this
 * corpus, on a scale that does not move when the query changes.
 *
 * The rarest term is the right one to ask about because the leg is a
 * disjunction — a passage becomes a candidate by matching any single term, so
 * the best case for the query as a whole is the best term in it. Padding a
 * distinctive identifier with stopwords must not dilute it.
 *
 * The gauge is classic idf `log(N/df)` over its own maximum `log(N)`, i.e. the
 * rarity of a term appearing in exactly one document. Deliberately *not* the
 * Robertson `bm25Idf` used inside bm25: that variant goes non-positive for any
 * term in more than about half the corpus and is floored at 1e-6, so on a small
 * corpus it collapses to the floor and would zero out the lexical leg for terms
 * that discriminate perfectly there (a codename in 2 of 3 passages). Classic
 * idf is monotone in df across the whole range and lands exactly on 1.0 at
 * df = 1 for every corpus size, so the reading — "how close to unique is the
 * best word you gave me" — holds on a 3-document corpus and a 20,447-document
 * one alike. Reproducing fts5 exactly matters for the bm25 denominator, where
 * the units have to cancel; it does not matter for a gauge.
 *
 * `minDf` at or above `DF_SCAN_CAP` returns 0: the true df is then unknown and
 * only ever larger, and guessing "rare" from a truncated scan is the one way
 * this could inflate a score. A term in ≥ 10,000 documents has no rarity worth
 * defending anyway.
 */
function queryRarity(total: number, minDf: number): number {
  // A corpus of 0 or 1 documents cannot be reordered by anything, so the gauge
  // has nothing to say and `log(total)` is not usable as a denominator.
  if (total <= 1) return 1;
  if (minDf <= 0) return 1;
  if (minDf >= DF_SCAN_CAP) return 0;
  const rarity = Math.log(total / minDf) / Math.log(total);
  return Math.min(1, Math.max(0, rarity));
}

/**
 * Weight of a bm25 candidate at 0-indexed rank `rank` in a pool of `pool` rows.
 *
 * Flat 1 for the first `core` rows, then linear to 0 at the pool edge. The
 * point is continuity at the truncation, not ranking: rows outside the pool
 * contribute 0, so a taper that reaches 0 there makes crossing the boundary
 * cost nothing. Before this, candidate #50 and #51 on the vault corpus differed
 * by 0.04% of bm25 and by the entire `LEXICAL_WEIGHT` after fusion.
 */
function candidateTaper(rank: number, core: number, pool: number): number {
  if (rank < core) return 1;
  if (rank >= pool) return 0;
  return (pool - rank) / (pool - core);
}

export interface SearchOptions {
  k?: number;
  minScore?: number;
  sourceKind?: VectorSourceKind;
  /**
   * Restrict retrieval to a set of kinds. Applied in SQL, not by filtering the
   * result, so `k` still returns k *eligible* hits instead of however many of
   * the top k happened to qualify. An empty array means "no kind is eligible"
   * and returns nothing — the fail-closed reading, not "no filter"; callers
   * that want no filter omit the option. Composes with `sourceKind` (both
   * apply) rather than overriding it.
   */
  sourceKinds?: readonly VectorSourceKind[];
  model?: string;
  /**
   * Run the lexical leg as well. Omitted, retrieval is vector-only and byte-for
   * -byte what it always was.
   */
  lexical?: LexicalOptions;
  /**
   * Opt in to degrading to semantic-only when the lexical leg fails, instead of
   * the default `throw`. Whatever is passed here is obliged to tell the user.
   */
  onLexicalError?: (err: LexicalSearchError) => void;
  /**
   * Told which embedding model the query actually embedded with. The semantic
   * leg filters corpus rows on exactly that model, so a query that silently
   * degraded (MiniLM corpus, hash-embedded query) sees zero semantic rows —
   * "nothing matches" with no cause named. A caller that compares this
   * against the corpus's dominant model can name the cause; see runAsk.
   */
  onQueryEmbedded?: (model: string) => void;
}

export function searchVector(
  db: DatabaseSync,
  query: string | Float32Array,
  opts: SearchOptions = {},
): VectorHit[] {
  const k = opts.k ?? 8;
  const minScore = opts.minScore ?? 0.05;

  let qVec: Float32Array;
  let model: string;
  if (typeof query !== "string") {
    qVec = l2Normalize(query);
    model = opts.model ?? "injected";
  } else if (opts.model === LOCAL_HASH_MODEL) {
    qVec = localHashEmbed(query);
    model = LOCAL_HASH_MODEL;
  } else {
    const emb = embedLocal(
      query,
      opts.model === MINILM_MODEL ? "minilm" : "auto",
    );
    qVec = emb.vector;
    model = opts.model ?? emb.model;
  }
  opts.onQueryEmbedded?.(model);

  // The eligibility filters are built once and applied to *both* legs. The
  // lexical leg reusing them is what keeps the citable-kind gate fail-closed:
  // a bm25 match on a `note` must not become a passage the model can see just
  // because it was found by a different index.
  let where = ` AND e.model = ? AND e.dims = ?`;
  const filterParams: (string | number)[] = [model, qVec.length];
  if (opts.sourceKind) {
    where += ` AND d.source_kind = ?`;
    filterParams.push(opts.sourceKind);
  }
  if (opts.sourceKinds) {
    if (opts.sourceKinds.length === 0) return [];
    where += ` AND d.source_kind IN (${opts.sourceKinds.map(() => "?").join(",")})`;
    filterParams.push(...opts.sourceKinds);
  }

  const rows = db
    .prepare(
      `SELECT d.id, d.source_kind, d.source_ref, d.title, d.body, d.snapshot_hash,
              e.model, e.dims, e.vector_blob
       FROM vector_embedding e
       JOIN vector_document d ON d.id = e.document_id
       WHERE 1 = 1${where}`,
    )
    .all(...filterParams) as {
    id: string;
    source_kind: string;
    source_ref: string | null;
    title: string | null;
    body: string;
    snapshot_hash: string;
    model: string;
    dims: number;
    vector_blob: Buffer;
  }[];

  type Row = (typeof rows)[number];
  const rowById = new Map<string, Row>();
  const cosine = new Map<string, number>();
  for (const row of rows) {
    let vec: Float32Array;
    try {
      vec = blobToFloat32(row.vector_blob);
    } catch {
      continue;
    }
    if (vec.length !== qVec.length) continue;
    rowById.set(row.id, row);
    cosine.set(row.id, cosineSimilarity(qVec, vec));
  }

  const toHit = (id: string, extra?: Partial<VectorHit>): VectorHit => {
    const row = rowById.get(id)!;
    return {
      documentId: row.id,
      score: cosine.get(id)!,
      sourceKind: row.source_kind,
      sourceRef: row.source_ref,
      title: row.title,
      body: row.body,
      snapshotHash: row.snapshot_hash,
      model: row.model,
      ...extra,
    };
  };

  // Semantic candidates, best first. `minScore` gates this leg and only this
  // leg — see the union below.
  const semantic = [...cosine.entries()]
    .filter(([, c]) => c >= minScore)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  if (!opts.lexical) {
    return semantic.slice(0, k).map((id) => toHit(id));
  }

  const lexical = runLexicalLeg(db, opts, where, filterParams, rowById);

  // The union, not the intersection. A passage the query's own words cannot
  // reach is still the passage that answers it; a passage whose cosine is under
  // the threshold but which contains the rare token the user typed is still
  // the one they meant. Requiring both was the defect.
  const candidates = opts.lexical.require
    ? [...lexical.keys()]
    : [...new Set([...semantic, ...lexical.keys()])];

  const semanticSet = new Set(semantic);
  const scored = candidates.map((id) => {
    const cos = cosine.get(id)!;
    const lex = lexical.get(id) ?? 0;
    return toHit(id, {
      lexicalScore: lex,
      // Both terms are already in [0,1]: cosine clamped at 0 (a negative
      // cosine means "unrelated", not "anti-relevant"), lexical normalised
      // against the query's idf mass.
      fusedScore: SEMANTIC_WEIGHT * Math.max(0, cos) + LEXICAL_WEIGHT * lex,
      retrievedBy: lexical.has(id)
        ? semanticSet.has(id)
          ? "both"
          : "lexical"
        : "semantic",
    });
  });

  scored.sort(
    (a, b) =>
      b.fusedScore! - a.fusedScore! ||
      b.score - a.score ||
      a.documentId.localeCompare(b.documentId),
  );
  return scored.slice(0, k);
}

/**
 * Run the FTS5 leg and return documentId -> normalised lexical strength.
 *
 * Returns an empty map when the query has no usable tokens, when none of them
 * appear in the corpus, or when the caller opted into degradation and the leg
 * failed. Throws `LexicalSearchError` otherwise — a silently absent leg is a
 * quality regression that looks exactly like an honest miss.
 */
function runLexicalLeg(
  db: DatabaseSync,
  opts: SearchOptions,
  where: string,
  filterParams: (string | number)[],
  rowById: ReadonlyMap<string, unknown>,
): Map<string, number> {
  const lex = opts.lexical!;
  const out = new Map<string, number>();
  const expr = toMatchExpression(lex.query, lex.mode ?? "terms");
  if (expr === null) return out;

  try {
    const total = countDocuments(db);
    // Sum the idf of the terms that actually occur. A term nobody wrote
    // contributes to no passage's bm25, so counting it in the denominator
    // would deflate every real match for no reason.
    //
    // The same pass records the smallest df seen, which is the rarest term the
    // user actually typed and the input to `queryRarity`. Terms nobody wrote
    // are excluded from that too: an unmatched word says nothing about how
    // discriminating the words that *did* match are.
    let idfMass = 0;
    let minDf = Infinity;
    for (const token of lexicalTokens(lex.query)) {
      const df = documentFrequency(db, token);
      if (df > 0) {
        idfMass += bm25Idf(total, df);
        if (df < minDf) minDf = df;
      }
    }
    if (idfMass <= 0) return out;
    // Scales the contribution, never the membership: a rarity of 0 must still
    // leave the matched rows in the map, or `require: true` — where the map
    // *is* the candidate set — would turn `--exact "the team"` into "no hits"
    // rather than into "these are the passages, ranked semantically".
    const rarity = queryRarity(total, minDf);

    const core = lex.limit ?? LEXICAL_CANDIDATE_LIMIT;
    const pool = core * LEXICAL_TAPER_FACTOR;

    const ftsRows = db
      .prepare(
        `SELECT d.id AS id, bm25(vector_document_fts) AS rank
         FROM vector_document_fts
         JOIN vector_document d ON d.rowid = vector_document_fts.rowid
         JOIN vector_embedding e ON e.document_id = d.id
         WHERE vector_document_fts MATCH ?${where}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(expr, ...filterParams, pool) as {
      id: string;
      rank: number;
    }[];

    for (let i = 0; i < ftsRows.length; i++) {
      const fr = ftsRows[i]!;
      // A row whose embedding blob failed to parse is not retrievable at all;
      // it must not re-enter through the lexical door. Its bm25 position is
      // still consumed — `i` indexes the pool as fts5 ordered it, so the taper
      // does not shift under an unrelated corruption.
      if (!rowById.has(fr.id)) continue;
      out.set(
        fr.id,
        lexicalStrength(fr.rank, idfMass) *
          rarity *
          candidateTaper(i, core, pool),
      );
    }
  } catch (err) {
    const e = new LexicalSearchError(expr, err);
    if (!opts.onLexicalError) throw e;
    opts.onLexicalError(e);
    return new Map();
  }
  return out;
}

// ─── CLI argument parsing ────────────────────────────────────────────────────

export interface ParsedSearchArgs {
  query: string;
  /** Run the lexical leg. Default true — hybrid is the default, not a mode. */
  hybrid: boolean;
  /** Narrow to exact-phrase matches (implies hybrid). */
  exact: boolean;
}

export type ParseSearchResult =
  | ({ ok: true } & ParsedSearchArgs)
  | { ok: false; error: string };

/**
 * Parse `chamber search` arguments.
 *
 * Unknown flags are refused rather than folded into the query: `--hybird` would
 * otherwise search for the literal string "--hybird" and report no hits, which
 * reads as an empty corpus. `--semantic --exact` is refused for the same
 * reason — one of them would have to lose silently.
 */
export function parseSearchArgs(argv: string[]): ParseSearchResult {
  const words: string[] = [];
  let semantic = false;
  let exact = false;
  let flagsEnded = false;

  for (const arg of argv) {
    if (!flagsEnded && arg.startsWith("-")) {
      if (arg === "--") {
        flagsEnded = true;
        continue;
      }
      // `--hybrid` is now the default. It stays accepted so that an existing
      // invocation keeps working and keeps meaning what it says.
      if (arg === "--hybrid") continue;
      if (arg === "--semantic") {
        semantic = true;
        continue;
      }
      if (arg === "--exact") {
        exact = true;
        continue;
      }
      return { ok: false, error: `unknown flag: ${arg}` };
    }
    words.push(arg);
  }

  if (semantic && exact) {
    return {
      ok: false,
      error: "--semantic and --exact contradict: --exact is a lexical filter",
    };
  }
  const query = words.join(" ").trim();
  if (query === "") return { ok: false, error: "a query is required" };
  return { ok: true, query, hybrid: !semantic, exact };
}

export function getDocument(
  db: DatabaseSync,
  id: string,
): {
  id: string;
  sourceKind: string;
  sourceRef: string | null;
  title: string | null;
  body: string;
  snapshotHash: string;
} | null {
  const row = db
    .prepare(
      `SELECT id, source_kind, source_ref, title, body, snapshot_hash
       FROM vector_document WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        source_kind: string;
        source_ref: string | null;
        title: string | null;
        body: string;
        snapshot_hash: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    title: row.title,
    body: row.body,
    snapshotHash: row.snapshot_hash,
  };
}

export function countDocuments(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM vector_document`)
    .get() as { c: number };
  return row?.c ?? 0;
}
