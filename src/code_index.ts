/**
 * Merkle + structural hybrid code indexing (no native tree-sitter required).
 *
 * - Split TS/JS/Python by structural boundaries (functions/classes/modules)
 * - Content-address each chunk (snapshot_hash = sha256)
 * - Upsert into vector corpus for hybrid retrieve
 * - File-level Merkle root over chunk hashes (ordered)
 *
 * Upgrade path: swap extractors for real tree-sitter/SCIP later without
 * changing the document schema.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "./hash.ts";
import { merkleParent, buildMerkleLayers } from "./merkle.ts";
import {
  upsertDocument,
  searchVector,
  type VectorHit,
  type LexicalSearchError,
} from "./vector.ts";

export interface CodeChunk {
  path: string;
  lang: "typescript" | "javascript" | "python" | "other";
  kind: "file" | "function" | "class" | "method" | "module_section";
  name: string;
  startLine: number;
  endLine: number;
  body: string;
  snapshotHash: string;
}

export interface FileMerkle {
  path: string;
  chunkCount: number;
  rootHash: string;
  chunkHashes: string[];
}

const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
]);

function langFor(path: string): CodeChunk["lang"] {
  const e = extname(path).toLowerCase();
  if (e === ".ts" || e === ".tsx") return "typescript";
  if (e === ".js" || e === ".jsx" || e === ".mjs" || e === ".cjs")
    return "javascript";
  if (e === ".py") return "python";
  return "other";
}

/** Structural extractors — brace/indent aware, not full AST. */
export function extractChunks(path: string, source: string): CodeChunk[] {
  const lang = langFor(path);
  const lines = source.split(/\r?\n/);
  const chunks: CodeChunk[] = [];

  const push = (
    kind: CodeChunk["kind"],
    name: string,
    start: number,
    end: number,
  ) => {
    const body = lines.slice(start, end + 1).join("\n");
    if (!body.trim()) return;
    chunks.push({
      path,
      lang,
      kind,
      name,
      startLine: start + 1,
      endLine: end + 1,
      body,
      snapshotHash: sha256(`${path}:${start + 1}:${end + 1}\n${body}`),
    });
  };

  if (lang === "python") {
    // top-level def/class blocks by indentation
    let i = 0;
    while (i < lines.length) {
      const m = lines[i]!.match(/^(def|class)\s+([A-Za-z_][\w]*)/);
      if (m) {
        const start = i;
        const baseIndent = lines[i]!.match(/^\s*/)?.[0].length ?? 0;
        i++;
        while (i < lines.length) {
          const line = lines[i]!;
          if (line.trim() === "") {
            i++;
            continue;
          }
          const ind = line.match(/^\s*/)?.[0].length ?? 0;
          if (ind <= baseIndent) break;
          i++;
        }
        push(m[1] === "class" ? "class" : "function", m[2]!, start, i - 1);
        continue;
      }
      i++;
    }
  } else {
    // TS/JS: function/class/const arrow at brace depth 0
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      const fn =
        line.match(
          /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)/,
        ) ||
        line.match(
          /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_][\w]*)\s*=\s*(?:async\s*)?\(/,
        ) ||
        line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_][\w]*)/);
      if (fn) {
        const start = i;
        const kind = /class\s/.test(line) ? "class" : "function";
        let depth = 0;
        let seenBrace = false;
        for (; i < lines.length; i++) {
          for (const ch of lines[i]!) {
            if (ch === "{") {
              depth++;
              seenBrace = true;
            } else if (ch === "}") depth--;
          }
          if (seenBrace && depth === 0) break;
        }
        push(kind, fn[1]!, start, Math.min(i, lines.length - 1));
        i++;
        continue;
      }
      i++;
    }
  }

  // Always include whole file as fallback / context chunk
  push("file", path.split(/[/\\]/).pop() ?? path, 0, lines.length - 1);
  return chunks;
}

export function fileMerkleRoot(chunks: CodeChunk[]): FileMerkle {
  const ordered = chunks
    .filter((c) => c.kind !== "file")
    .sort((a, b) => a.startLine - b.startLine);
  const hashes =
    ordered.length > 0
      ? ordered.map((c) => c.snapshotHash)
      : chunks.map((c) => c.snapshotHash);
  const { root } = buildMerkleLayers(hashes);
  return {
    path: chunks[0]?.path ?? "",
    chunkCount: hashes.length,
    rootHash: root,
    chunkHashes: hashes,
  };
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (CODE_EXT.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

export interface IndexResult {
  files: number;
  chunks: number;
  roots: FileMerkle[];
}

/** Index a directory of code into the vector corpus. */
export function indexCodeTree(
  db: DatabaseSync,
  rootDir: string,
  opts: { model?: string } = {},
): IndexResult {
  const files = walk(rootDir);
  let chunks = 0;
  const roots: FileMerkle[] = [];

  for (const abs of files) {
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // skip huge files
    if (source.length > 400_000) continue;
    const rel = relative(rootDir, abs) || abs;
    const extracted = extractChunks(rel, source);
    const merkle = fileMerkleRoot(extracted);
    roots.push({ ...merkle, path: rel });

    for (const ch of extracted) {
      if (ch.kind === "file" && extracted.length > 1) {
        // prefer structural chunks; keep short files as whole
        if (source.length > 2000) continue;
      }
      upsertDocument(db, {
        id: `code_${ch.snapshotHash.slice(0, 24)}`,
        sourceKind: "vault_page",
        sourceRef: `${ch.path}:${ch.startLine}-${ch.endLine}`,
        title: `${ch.kind} ${ch.name}`,
        body: `// ${ch.path}:${ch.startLine}-${ch.endLine} (${ch.kind})\n${ch.body}`,
        metadata: {
          path: ch.path,
          lang: ch.lang,
          kind: ch.kind,
          startLine: ch.startLine,
          endLine: ch.endLine,
          fileMerkleRoot: merkle.rootHash,
        },
        model: opts.model ?? "local-hash-v1",
      });
      chunks++;
    }
  }

  return { files: files.length, chunks, roots };
}

/**
 * Search code corpus.
 *
 * Hybrid by default, and more obviously right here than anywhere else: a code
 * query is usually a *symbol* — `verifyBeliefSources`, `CITABLE_SOURCE_KINDS` —
 * which is the exact case a sentence embedder has no representation for and an
 * inverted index nails. `hybrid: false` opts out.
 */
export function searchCode(
  db: DatabaseSync,
  query: string,
  opts: {
    k?: number;
    hybrid?: boolean;
    model?: string;
    onLexicalError?: (err: LexicalSearchError) => void;
  } = {},
): VectorHit[] {
  return searchVector(db, query, {
    k: opts.k ?? 8,
    minScore: 0.02,
    sourceKind: "vault_page",
    lexical: opts.hybrid === false ? undefined : { query },
    model: opts.model ?? "local-hash-v1",
    onLexicalError: opts.onLexicalError,
  });
}

export function contentAddress(path: string, body: string): string {
  return createHash("sha256").update(`${path}\n${body}`).digest("hex");
}

// silence unused if tree shakes merkleParent
void merkleParent;
