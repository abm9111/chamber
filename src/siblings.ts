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
 * Identity is (source_kind, ingestRoot, file, title): two roots can hold the
 * same relative path under the same headings, and a sibling from the wrong
 * root would be a passage from a different note.
 */

import type { DatabaseSync } from "node:sqlite";
import { passagePathOf } from "./chunk.ts";

/** Pieces shown per retrieved passage, the hit included. */
export const SIBLINGS_PER_HIT = 5;
/** Passages shown in total, hits and siblings together, as a multiple of k. */
export const SIBLING_TOTAL_FACTOR = 2;

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

/**
 * `hits` in rank order, each followed by the other pieces of its section in
 * file order, deduplicated, and capped. What did not fit is kept per section,
 * so the answer note can say so exactly when the answer cites a cut section —
 * a section shown in part with no word said is the failure this exists to fix.
 */
export function withSiblings<T extends PassageRow>(
  db: DatabaseSync,
  hits: T[],
  k: number,
): SiblingExpansion {
  // Never below one section's cap: with k=1 a 2k total showed half a table.
  const total = Math.max(hits.length, k * SIBLING_TOTAL_FACTOR, SIBLINGS_PER_HIT);
  const metaOf = db.prepare(`SELECT metadata_json AS meta FROM vector_document WHERE id = ?`);
  const piecesOf = db.prepare(
    `SELECT id, source_ref, title, body, snapshot_hash, source_kind, metadata_json AS meta
       FROM vector_document
      WHERE source_kind = ? AND title IS ?
        AND substr(source_ref, 1, length(?)) = ?`,
  );

  // Every hit is shown first: a sibling never displaces something retrieval
  // actually ranked. Siblings then fill the remaining room, nearest first.
  const out: PassageRow[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    out.push(h);
    seen.add(h.documentId);
  }

  const omittedBy = new Map<string, number>();
  const cut = (hit: string, n: number): void => {
    if (n > 0) omittedBy.set(hit, (omittedBy.get(hit) ?? 0) + n);
  };
  const groups: { hitAt: number; extra: PassageRow[] }[] = [];
  for (const h of hits) {
    if (!h.sourceRef) continue;
    const at = pieceIndex(h.sourceRef);
    if (at === undefined) continue;
    const root = ingestRootOf((metaOf.get(h.documentId) as { meta: string | null } | undefined)?.meta ?? null);
    const prefix = `${passagePathOf(h.sourceRef)}#p`;
    const rows = (piecesOf.all(h.sourceKind, h.title, prefix, prefix) as unknown as (Row & { meta: string | null })[])
      .filter((r) => ingestRootOf(r.meta) === root && pieceIndex(r.source_ref) !== undefined)
      .filter((r) => !seen.has(r.id));
    // Nearest to the hit first, so a cap keeps the pieces most likely to be
    // the rest of what the hit started.
    rows.sort(
      (a, b) =>
        Math.abs(pieceIndex(a.source_ref)! - at) - Math.abs(pieceIndex(b.source_ref)! - at),
    );
    const room = SIBLINGS_PER_HIT - 1;
    cut(h.documentId, rows.length - room);
    const extra: PassageRow[] = [];
    for (const r of rows.slice(0, room)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      extra.push({
        documentId: r.id,
        sourceRef: r.source_ref,
        title: r.title,
        body: r.body,
        snapshotHash: r.snapshot_hash,
        sourceKind: r.source_kind,
      });
    }
    groups.push({ hitAt: out.findIndex((p) => p.documentId === h.documentId), extra });
  }

  // Fill in rank order until the total cap; whatever does not fit is counted.
  const admitted = new Map<string, PassageRow[]>();
  let room = total - out.length;
  for (const g of groups) {
    const take = g.extra.slice(0, Math.max(0, room));
    const hit = out[g.hitAt]!.documentId;
    cut(hit, g.extra.length - take.length);
    room -= take.length;
    admitted.set(hit, take);
  }

  // Each hit's section in file order, hit included, then the next hit.
  const ordered: PassageRow[] = [];
  const sectionOf = new Map<string, string>();
  for (const p of out) {
    const section = [p, ...(admitted.get(p.documentId) ?? [])];
    for (const x of section) sectionOf.set(x.documentId, p.documentId);
    section.sort(
      (a, b) => (pieceIndex(a.sourceRef ?? "") ?? 0) - (pieceIndex(b.sourceRef ?? "") ?? 0),
    );
    ordered.push(...section);
  }
  return {
    passages: ordered,
    omittedFromCited: (cited) => {
      let n = 0;
      const sections = new Set([...cited].map((id) => sectionOf.get(id)).filter(Boolean));
      for (const s of sections) n += omittedBy.get(s!) ?? 0;
      return n;
    },
  };
}
