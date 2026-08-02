/**
 * SCIP consumer — ingest compiler-accurate indexes; do not generate them.
 *
 * Supported inputs:
 *   1. Chamber graph JSON (see ScipGraphJson)
 *   2. SCIP Index JSON (proto-json style: documents[], metadata)
 *
 * Query: call/type edges for a symbol → evidence pins for debt/code search.
 */

import { readFileSync, existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { newId, sha256 } from "./hash.ts";
import { upsertDocument } from "./vector.ts";

export interface ScipGraphJson {
  format: "chamber_scip_graph_v1";
  documents?: {
    relative_path: string;
    content_hash?: string;
    occurrences?: {
      symbol: string;
      range?: number[]; // [startLine, startChar, endLine, endChar]
      role?: string;
    }[];
  }[];
  symbols?: {
    symbol: string;
    kind?: string;
    display_name?: string;
    documentation?: string;
  }[];
  relationships?: {
    from: string;
    to: string;
    kind: string;
  }[];
}

export interface ScipIngestReport {
  documents: number;
  symbols: number;
  occurrences: number;
  relationships: number;
  source: string;
}

function upsertSymbol(
  db: DatabaseSync,
  symbol: string,
  kind?: string,
  displayName?: string,
  documentation?: string,
): string {
  const existing = db
    .prepare(`SELECT id FROM scip_symbol WHERE symbol = ?`)
    .get(symbol) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE scip_symbol SET kind = COALESCE(?, kind),
         display_name = COALESCE(?, display_name),
         documentation = COALESCE(?, documentation)
       WHERE id = ?`,
    ).run(kind ?? null, displayName ?? null, documentation ?? null, existing.id);
    return existing.id;
  }
  const id = newId("sym");
  db.prepare(
    `INSERT INTO scip_symbol (id, symbol, kind, display_name, documentation)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, symbol, kind ?? null, displayName ?? null, documentation ?? null);
  return id;
}

function upsertDocumentRow(
  db: DatabaseSync,
  path: string,
  contentHash?: string,
): string {
  const existing = db
    .prepare(`SELECT id FROM scip_document WHERE relative_path = ?`)
    .get(path) as { id: string } | undefined;
  if (existing) {
    if (contentHash) {
      db.prepare(`UPDATE scip_document SET content_hash = ? WHERE id = ?`).run(
        contentHash,
        existing.id,
      );
    }
    return existing.id;
  }
  const id = newId("sdoc");
  db.prepare(
    `INSERT INTO scip_document (id, relative_path, content_hash) VALUES (?, ?, ?)`,
  ).run(id, path, contentHash ?? null);
  return id;
}

export function ingestScipGraph(
  db: DatabaseSync,
  graph: ScipGraphJson,
  sourceLabel = "graph",
): ScipIngestReport {
  let documents = 0;
  let symbols = 0;
  let occurrences = 0;
  let relationships = 0;

  for (const s of graph.symbols ?? []) {
    upsertSymbol(db, s.symbol, s.kind, s.display_name, s.documentation);
    symbols++;
  }

  for (const doc of graph.documents ?? []) {
    const docId = upsertDocumentRow(db, doc.relative_path, doc.content_hash);
    documents++;
    for (const occ of doc.occurrences ?? []) {
      const symId = upsertSymbol(db, occ.symbol);
      const range = occ.range ?? [0, 0, 0, 0];
      db.prepare(
        `INSERT INTO scip_occurrence (
           id, document_id, symbol_id, symbol,
           range_start_line, range_start_char, range_end_line, range_end_char, role
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId("occ"),
        docId,
        symId,
        occ.symbol,
        range[0] ?? 0,
        range[1] ?? 0,
        range[2] ?? range[0] ?? 0,
        range[3] ?? 0,
        occ.role ?? "reference",
      );
      occurrences++;
    }
  }

  for (const rel of graph.relationships ?? []) {
    db.prepare(
      `INSERT INTO scip_relationship (id, from_symbol, to_symbol, kind)
       VALUES (?, ?, ?, ?)`,
    ).run(newId("rel"), rel.from, rel.to, rel.kind);
    relationships++;
  }

  // Index definitions into vector corpus for hybrid search
  const defs = db
    .prepare(
      `SELECT s.symbol, s.display_name, s.kind, s.documentation, d.relative_path,
              o.range_start_line
       FROM scip_occurrence o
       JOIN scip_symbol s ON s.id = o.symbol_id
       JOIN scip_document d ON d.id = o.document_id
       WHERE o.role = 'definition'
       LIMIT 500`,
    )
    .all() as {
    symbol: string;
    display_name: string | null;
    kind: string | null;
    documentation: string | null;
    relative_path: string;
    range_start_line: number;
  }[];

  for (const d of defs) {
    const body = [
      d.display_name ?? d.symbol,
      d.kind ? `kind: ${d.kind}` : "",
      d.documentation ?? "",
      `${d.relative_path}:${d.range_start_line}`,
    ]
      .filter(Boolean)
      .join("\n");
    upsertDocument(db, {
      id: `scip_${sha256(d.symbol).slice(0, 20)}`,
      sourceKind: "vault_page",
      sourceRef: `${d.relative_path}:${d.range_start_line}`,
      title: `SCIP ${d.kind ?? "symbol"} ${d.display_name ?? d.symbol}`,
      body,
      metadata: { scip: true, symbol: d.symbol },
      model: "local-hash-v1",
    });
  }

  return { documents, symbols, occurrences, relationships, source: sourceLabel };
}

/**
 * Best-effort parse of SCIP proto-JSON (sourcegraph index JSON dump).
 * Only pulls documents.relative_path + symbols/occurrences when present.
 */
export function parseScipProtoJson(raw: unknown): ScipGraphJson {
  const graph: ScipGraphJson = {
    format: "chamber_scip_graph_v1",
    documents: [],
    symbols: [],
    relationships: [],
  };
  if (!raw || typeof raw !== "object") return graph;
  const root = raw as Record<string, unknown>;

  const docs = (root.documents as unknown[]) ?? [];
  for (const d of docs) {
    if (!d || typeof d !== "object") continue;
    const doc = d as Record<string, unknown>;
    const path = String(doc.relative_path ?? doc.relativePath ?? "");
    if (!path) continue;
    const occurrences: NonNullable<ScipGraphJson["documents"]>[0]["occurrences"] =
      [];
    for (const o of (doc.occurrences as unknown[]) ?? []) {
      if (!o || typeof o !== "object") continue;
      const occ = o as Record<string, unknown>;
      const symbol = String(occ.symbol ?? "");
      if (!symbol) continue;
      const range = (occ.range as number[]) ?? [];
      const roles = occ.symbol_roles ?? occ.symbolRoles;
      let role = "reference";
      if (typeof roles === "number" && roles & 1) role = "definition";
      if (occ.symbol_role === "definition" || occ.role === "definition")
        role = "definition";
      occurrences.push({ symbol, range, role });
    }
    graph.documents!.push({ relative_path: path, occurrences });
  }

  // Some dumps put external_symbols / symbols at top level
  for (const s of (root.symbols as unknown[]) ??
    (root.external_symbols as unknown[]) ??
    []) {
    if (!s || typeof s !== "object") continue;
    const sym = s as Record<string, unknown>;
    const symbol = String(sym.symbol ?? "");
    if (!symbol) continue;
    graph.symbols!.push({
      symbol,
      kind: sym.kind != null ? String(sym.kind) : undefined,
      display_name: String(sym.display_name ?? sym.displayName ?? ""),
      documentation: Array.isArray(sym.documentation)
        ? (sym.documentation as string[]).join("\n")
        : sym.documentation
          ? String(sym.documentation)
          : undefined,
    });
  }

  return graph;
}

export function ingestScipFile(
  db: DatabaseSync,
  filePath: string,
): ScipIngestReport {
  if (!existsSync(filePath)) {
    throw new Error(`SCIP file not found: ${filePath}`);
  }
  const text = readFileSync(filePath, "utf8");
  const raw = JSON.parse(text) as unknown;

  if (
    raw &&
    typeof raw === "object" &&
    (raw as ScipGraphJson).format === "chamber_scip_graph_v1"
  ) {
    return ingestScipGraph(db, raw as ScipGraphJson, filePath);
  }
  const graph = parseScipProtoJson(raw);
  return ingestScipGraph(db, graph, filePath);
}

export interface SymbolEdge {
  from: string;
  to: string;
  kind: string;
}

export function queryCallers(db: DatabaseSync, symbol: string): SymbolEdge[] {
  return db
    .prepare(
      `SELECT from_symbol AS "from", to_symbol AS "to", kind
       FROM scip_relationship
       WHERE to_symbol = ? AND kind IN ('calls','references')`,
    )
    .all(symbol) as SymbolEdge[];
}

export function queryCallees(db: DatabaseSync, symbol: string): SymbolEdge[] {
  return db
    .prepare(
      `SELECT from_symbol AS "from", to_symbol AS "to", kind
       FROM scip_relationship
       WHERE from_symbol = ? AND kind IN ('calls','references')`,
    )
    .all(symbol) as SymbolEdge[];
}

export function findSymbol(
  db: DatabaseSync,
  query: string,
): { symbol: string; displayName: string | null; kind: string | null }[] {
  return db
    .prepare(
      `SELECT symbol, display_name AS displayName, kind FROM scip_symbol
       WHERE symbol LIKE ? OR display_name LIKE ?
       LIMIT 20`,
    )
    .all(`%${query}%`, `%${query}%`) as {
    symbol: string;
    displayName: string | null;
    kind: string | null;
  }[];
}
