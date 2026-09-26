/**
 * The rest of a split section, for a retrieved piece of it.
 *
 * A section over the passage budget is split into pieces that share one
 * heading path (`title`) and sit at adjacent `#pN` positions of one file.
 * Retrieval ranks pieces independently, so it can return one and not the
 * others — and the model then answers from part of a section as if it were
 * all of it. Measured on the vault, 2026-09-26: the filament note's Tier 1
 * table was split with its header, Eryone and Geeetech in p32 and Elegoo alone
 * in p33; retrieval returned p33, and every answer named 4 of 8 brands. 8,242
 * of 18,755 sections in that vault are split.
 *
 * Each sibling is its own row with its own pin, so it goes to the model as its
 * own numbered passage — citing it verifies exactly like citing a hit. Nothing
 * here widens what a citation can prove.
 *
 * A section is (source_kind, ingestRoot, file, title) *and* one unbroken run
 * of piece numbers, and its pieces are the rows whose source_ref is exactly
 * `file#p<digits>`. Two roots can hold the
 * same relative path under the same headings, and a file may itself be named
 * `a#pfoo` — both are other notes, and a first version showed them as part of
 * this one (review, 2026-09-26).
 */

import type { DatabaseSync } from "node:sqlite";
import { passagePathOf } from "./chunk.ts";

/** Pieces shown per section, retrieved pieces included. */
export const SIBLINGS_PER_HIT = 5;
/** Passages shown in total, hits and siblings together, as a multiple of k. */
export const SIBLING_TOTAL_FACTOR = 2;
/** `citedIndices` reads one or two digits: a passage numbered 100 is uncitable. */
export const MAX_PASSAGES = 99;

export interface PassageRow {
  documentId: string;
  sourceRef: string | null;
  title: string | null;
  body: string;
  snapshotHash: string;
  sourceKind: string;
}

export interface SiblingExpansion {
  passages: PassageRow[];
  /**
   * Pieces not shown, of the sections the given passages belong to. Asked
   * after the answer, with the ids it cites: a cut section matters only when
   * the answer draws on it. Announcing every cut put a "may be partial" note
   * on 9 of 10 vault answers, which is a note nobody reads.
   */
  omittedFromCited: (citedDocumentIds: Iterable<string>) => number;
}

interface Row {
  id: string;
  source_ref: string;
  title: string | null;
  body: string;
  snapshot_hash: string;
  source_kind: string;
  meta: string | null;
}

interface Section {
  key: string;
  /** Every piece of the section, in file order. */
  pieces: PassageRow[];
  /** Ids of the pieces retrieval itself returned. */
  hits: Set<string>;
  shown: Set<string>;
}

function pieceIndex(sourceRef: string): number | undefined {
  const m = /#p(\d+)$/.exec(sourceRef);
  return m ? Number(m[1]) : undefined;
}

function ingestRootOf(meta: string | null): string | null {
  if (!meta) return null;
  try {
    const root = (JSON.parse(meta) as { ingestRoot?: unknown }).ingestRoot;
    return typeof root === "string" && root !== "" ? root : null;
  } catch {
    return null;
  }
}

function byPiece(a: PassageRow, b: PassageRow): number {
  return (pieceIndex(a.sourceRef ?? "") ?? 0) - (pieceIndex(b.sourceRef ?? "") ?? 0);
}

/**
 * `hits` grouped into their sections, sections in the rank order of their
 * best hit, each section's shown pieces contiguous and in file order. Every
 * hit is shown — a sibling never displaces something retrieval ranked.
 * Siblings fill the remaining room section by section, nearest a hit first.
 *
 * Counting is per real section: a first version keyed sections by the hit
 * that found them, so two hits in one section double-counted what was cut,
 * and a section whose pieces another hit had claimed reported nothing cut.
 */
export function withSiblings<T extends PassageRow>(
  db: DatabaseSync,
  hits: T[],
  k: number,
): SiblingExpansion {
  // Never below one section's cap (k=1 showed half a table), never above
  // what a citation can name.
  const total = Math.min(
    MAX_PASSAGES,
    Math.max(hits.length, k * SIBLING_TOTAL_FACTOR, SIBLINGS_PER_HIT),
  );
  const metaOf = db.prepare(`SELECT metadata_json AS meta FROM vector_document WHERE id = ?`);
  // A range on source_ref, not substr(): the range can use the source_ref
  // index, where substr() scanned every row of the kind (~140 ms per ask on a
  // 44k-row vault, measured in review). '#p' < '#q', so [file#p, file#q)
  // holds every ref starting with file#p; the digits test narrows it to this
  // file's own pieces.
  //
  // source_kind is filtered below, not here: with it in the WHERE clause the
  // planner chose idx_vector_doc_kind and scanned the whole kind anyway
  // (EXPLAIN QUERY PLAN, 2026-09-26) — the range alone is what selects.
  const piecesOf = db.prepare(
    `SELECT id, source_ref, title, body, snapshot_hash, source_kind, metadata_json AS meta
       FROM vector_document
      WHERE source_ref >= ? AND source_ref < ? AND title IS ?`,
  );

  const sections = new Map<string, Section>();
  const order: (Section | PassageRow)[] = [];

  for (const h of hits) {
    const at = h.sourceRef ? pieceIndex(h.sourceRef) : undefined;
    if (!h.sourceRef || at === undefined) {
      order.push(h);
      continue;
    }
    const root = ingestRootOf(
      (metaOf.get(h.documentId) as { meta: string | null } | undefined)?.meta ?? null,
    );
    const file = passagePathOf(h.sourceRef);
    const rows = (piecesOf.all(`${file}#p`, `${file}#q`, h.title) as unknown as Row[])
      .filter((r) => r.source_kind === h.sourceKind)
      .filter((r) => /^\d+$/.test(r.source_ref.slice(file.length + 2)))
      .filter((r) => ingestRootOf(r.meta) === root);
    // One section is one unbroken run of #pN around the hit. The title alone
    // is a heading path, and a file can repeat it — eight `## Entry` sections
    // in a daily log — so keying on title merged unrelated sections and
    // reported pieces "cut" that were never split (round-2 review).
    const byIndex = new Map(rows.map((r) => [pieceIndex(r.source_ref)!, r]));
    let lo = at;
    while (byIndex.has(lo - 1)) lo--;
    let hi = at;
    while (byIndex.has(hi + 1)) hi++;
    const key = JSON.stringify([h.sourceKind, root, file, h.title, lo]);
    let s = sections.get(key);
    if (!s) {
      const pieces: PassageRow[] = [];
      for (let i = lo; i <= hi; i++) {
        const r = byIndex.get(i);
        if (!r) continue;
        pieces.push({
          documentId: r.id,
          sourceRef: r.source_ref,
          title: r.title,
          body: r.body,
          snapshotHash: r.snapshot_hash,
          sourceKind: r.source_kind,
        });
      }
      s = { key, pieces, hits: new Set(), shown: new Set() };
      sections.set(key, s);
      order.push(s);
    }
    // A hit the query did not return (a caller-built row) is still shown.
    if (!s.pieces.some((p) => p.documentId === h.documentId)) s.pieces.push(h);
    s.pieces.sort(byPiece);
    s.hits.add(h.documentId);
    s.shown.add(h.documentId);
  }

  let room = total - hits.length;
  for (const s of sections.values()) {
    const hitAt = s.pieces
      .filter((p) => s.hits.has(p.documentId))
      .map((p) => pieceIndex(p.sourceRef!)!);
    const distance = (p: PassageRow): number =>
      Math.min(...hitAt.map((h) => Math.abs(pieceIndex(p.sourceRef!)! - h)));
    const candidates = s.pieces
      .filter((p) => !s.shown.has(p.documentId))
      .sort((a, b) => distance(a) - distance(b));
    const cap = Math.max(SIBLINGS_PER_HIT, s.hits.size);
    for (const p of candidates) {
      if (room <= 0 || s.shown.size >= cap) break;
      s.shown.add(p.documentId);
      room--;
    }
  }

  const passages: PassageRow[] = [];
  for (const o of order) {
    if ("key" in o) passages.push(...o.pieces.filter((p) => o.shown.has(p.documentId)));
    else passages.push(o);
  }

  const sectionOf = new Map<string, Section>();
  for (const s of sections.values()) for (const p of s.pieces) sectionOf.set(p.documentId, s);
  return {
    passages,
    omittedFromCited: (cited) => {
      const cut = new Set<Section>();
      for (const id of cited) {
        const s = sectionOf.get(id);
        if (s) cut.add(s);
      }
      let n = 0;
      for (const s of cut) n += s.pieces.length - s.shown.size;
      return n;
    },
  };
}
