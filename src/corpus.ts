/**
 * What is actually in the index, as data.
 *
 * Split out of `cmdCorpus` because two callers need the same aggregation and
 * only one of them wants a bar chart: the CLI renders this for a terminal, the
 * MCP server hands it to a model. Keeping the counting in one place is what
 * stops the two surfaces from quietly disagreeing about how many passages
 * there are — the exact class of divergence this project exists to catch.
 */

import type { DatabaseSync } from "node:sqlite";

export interface CorpusGroup {
  /** First path segment — the thing `ingest --exclude` matches. */
  name: string;
  passages: number;
  bytes: number;
  files: number;
}

export interface CorpusStats {
  passages: number;
  files: number;
  bytes: number;
  /** Passage counts per `source_kind`, most common first. */
  byKind: { kind: string; passages: number }[];
  /** Every first-path-segment group, most passages first. */
  groups: CorpusGroup[];
  /** Median passages-per-file — the baseline `fattest` is judged against. */
  medianPassagesPerFile: number;
  /** Files far above the median: the signature of an export, not a note. */
  fattest: { file: string; passages: number }[];
}

export function corpusStats(db: DatabaseSync): CorpusStats {
  const rows = db
    .prepare(
      `SELECT source_ref, source_kind, length(body) AS bytes FROM vector_document`,
    )
    .all() as { source_ref: string; source_kind: string; bytes: number }[];

  const files = new Set<string>();
  const byGroup = new Map<
    string,
    { passages: number; bytes: number; files: Set<string> }
  >();
  const byKind = new Map<string, number>();
  const perFile = new Map<string, number>();
  let bytes = 0;

  for (const r of rows) {
    const file = String(r.source_ref).replace(/#p\d+$/, "");
    files.add(file);
    perFile.set(file, (perFile.get(file) ?? 0) + 1);
    const slash = file.indexOf("/");
    const group = slash === -1 ? "(root)" : file.slice(0, slash);
    const g = byGroup.get(group) ?? {
      passages: 0,
      bytes: 0,
      files: new Set<string>(),
    };
    g.passages += 1;
    g.bytes += r.bytes ?? 0;
    g.files.add(file);
    byGroup.set(group, g);
    byKind.set(r.source_kind, (byKind.get(r.source_kind) ?? 0) + 1);
    bytes += r.bytes ?? 0;
  }

  const median =
    [...perFile.values()].sort((a, b) => a - b)[
      Math.floor(perFile.size / 2)
    ] ?? 1;

  return {
    passages: rows.length,
    files: files.size,
    bytes,
    byKind: [...byKind.entries()]
      .map(([kind, passages]) => ({ kind, passages }))
      .sort((a, b) => b.passages - a.passages),
    groups: [...byGroup.entries()]
      .map(([name, g]) => ({
        name,
        passages: g.passages,
        bytes: g.bytes,
        files: g.files.size,
      }))
      .sort((a, b) => b.passages - a.passages),
    medianPassagesPerFile: median,
    fattest: [...perFile.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .filter(([, n]) => n > median * 8)
      .map(([file, passages]) => ({ file, passages })),
  };
}
