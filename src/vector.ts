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
  score: number;
  sourceKind: string;
  sourceRef: string | null;
  title: string | null;
  body: string;
  snapshotHash: string;
  model: string;
}

export function upsertDocument(
  db: DatabaseSync,
  input: UpsertDocumentInput,
): { id: string; model: string; dims: number } {
  const id = input.id ?? newId("vdoc");
  const body = input.body;
  const snapshot = sha256(
    [input.title ?? "", body, input.sourceRef ?? ""].join("\n"),
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

  return { id, model, dims };
}

export function deleteDocument(db: DatabaseSync, id: string): boolean {
  const r = db.prepare(`DELETE FROM vector_document WHERE id = ?`).run(id);
  return Number(r.changes ?? 0) > 0;
}

export interface SearchOptions {
  k?: number;
  minScore?: number;
  sourceKind?: VectorSourceKind;
  model?: string;
  /** Hybrid: also require FTS5 match; rank = 0.7*cosine + 0.3*fts_boost */
  ftsQuery?: string;
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

  let sql = `
    SELECT d.id, d.source_kind, d.source_ref, d.title, d.body, d.snapshot_hash,
           e.model, e.dims, e.vector_blob
    FROM vector_embedding e
    JOIN vector_document d ON d.id = e.document_id
    WHERE e.model = ? AND e.dims = ?
  `;
  const params: (string | number)[] = [model, qVec.length];
  if (opts.sourceKind) {
    sql += ` AND d.source_kind = ?`;
    params.push(opts.sourceKind);
  }

  const rows = db.prepare(sql).all(...params) as {
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

  // Optional FTS candidate set
  let ftsBoost = new Map<string, number>();
  if (opts.ftsQuery && opts.ftsQuery.trim()) {
    try {
      const ftsRows = db
        .prepare(
          `SELECT d.id AS id, bm25(vector_document_fts) AS rank
           FROM vector_document_fts
           JOIN vector_document d ON d.rowid = vector_document_fts.rowid
           WHERE vector_document_fts MATCH ?
           ORDER BY rank
           LIMIT 50`,
        )
        .all(opts.ftsQuery) as { id: string; rank: number }[];
      // bm25: lower is better — convert to 0..1-ish boost
      for (const fr of ftsRows) {
        const boost = 1 / (1 + Math.max(0, fr.rank));
        ftsBoost.set(fr.id, boost);
      }
    } catch {
      // FTS query syntax errors — ignore hybrid leg
      ftsBoost = new Map();
    }
  }

  const scored: VectorHit[] = [];
  for (const row of rows) {
    if (ftsBoost.size > 0 && !ftsBoost.has(row.id)) continue;
    let vec: Float32Array;
    try {
      vec = blobToFloat32(row.vector_blob);
    } catch {
      continue;
    }
    if (vec.length !== qVec.length) continue;
    let score = cosineSimilarity(qVec, vec);
    if (ftsBoost.size > 0) {
      const boost = ftsBoost.get(row.id) ?? 0;
      score = 0.7 * score + 0.3 * boost;
    }
    if (score < minScore) continue;
    scored.push({
      documentId: row.id,
      score,
      sourceKind: row.source_kind,
      sourceRef: row.source_ref,
      title: row.title,
      body: row.body,
      snapshotHash: row.snapshot_hash,
      model: row.model,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
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
