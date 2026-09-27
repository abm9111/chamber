/**
 * `chamber_check`: the check an agent runs on its own claims about the user's
 * notes, without Chamber's model.
 *
 * `ask` checks claims its own model wrote. An agent that reads the vault with
 * its own tools (Claude Code's Read and Grep) had nothing to check against:
 * telling it "verify here" would have been false. This takes the agent's
 * claims and the notes it says they came from, and runs the same term check
 * the commit gate runs — every number, name, domain, file name and count in
 * the claim must occur in the cited text.
 *
 * Read-only unless `record` is set. Recording goes through the ordinary
 * commit gate (enforceClaimContract), and only for claims this check found
 * supported — so a failed check never mints citation debt.
 *
 * The state question, asked of this guard: the agent read the file on disk,
 * Chamber judges the indexed copy. A note edited since the last ingest would
 * be judged on text the agent never read — a pass over old text, or a flag
 * for a sentence the note now contains. So each cited file is re-split from
 * disk and compared with the index first, and a file that differs is STALE
 * and not judged.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { passagePathOf, splitPassages } from "./chunk.ts";
import { joinPrepared, preparePassage, specificTerms, termsMissingIn, type PreparedText } from "./claim_support.ts";
import { enforceClaimContract, type ContractSource } from "./contract.ts";
import { splitFrontmatter } from "./ingest.ts";

/** One claim per call, usually opening with its subject: check that word too. */
const OPENINGS = { openings: true } as const;

export const MAX_CHECK_CLAIMS = 50;
export const MAX_CHECK_SOURCES = 10;
export const MAX_CHECK_CLAIM_CHARS = 2000;

export interface CheckInput {
  text: string;
  /** Absolute paths, `file.md#p3` refs as `chamber_ask` prints them, or passage ids. */
  sources: string[];
}

export type CheckStatus =
  | "SUPPORTED"
  | "TERMS_ABSENT"
  | "NO_TERMS"
  | "STALE"
  | "NOT_FOUND"
  | "NO_SOURCE";

export interface CheckResult {
  text: string;
  status: CheckStatus;
  terms: string[];
  missing: string[];
  /** The indexed passages the claim was judged against, as `file#pN`. */
  checkedRefs: string[];
  /**
   * A small set of those that together hold every term the note has (greedy,
   * not guaranteed minimal): what a reader should open, and what `record` pins.
   */
  foundIn: string[];
  /** One line per source that did not resolve or is stale, naming it. */
  problems: string[];
  /** Set only when `record` committed the claim. */
  recorded?: { status: string; beliefId?: string; reason?: string };
}

interface Row {
  id: string;
  ref: string;
  body: string;
  hash: string;
  root: string | null;
}

function readRoot(json: string | null): string | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (v !== null && typeof v === "object") {
      const r = (v as { ingestRoot?: unknown }).ingestRoot;
      if (typeof r === "string") return r;
    }
  } catch {
    // unreadable metadata: no known root
  }
  return null;
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The path with links resolved and each component in its on-disk case. */
function nativeReal(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

const inside = (rel: string): boolean => rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);

class Index {
  private readonly byFile = new Map<string, Row[]>();
  private roots: string[] | undefined;
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Every passage of `file` (a root-relative path), grouped by recorded root. */
  passagesOf(file: string): Row[] {
    const cached = this.byFile.get(file);
    if (cached) return cached;
    const like = `${file.replace(/[\\%_]/g, "\\$&")}#p%`;
    const rows = (
      this.db
        .prepare(
          `SELECT id, source_ref, body, snapshot_hash, metadata_json FROM vector_document
           WHERE source_kind = 'vault_page' AND (source_ref LIKE ? ESCAPE '\\' OR source_ref = ?)`,
        )
        .all(like, file) as {
        id: string;
        source_ref: string;
        body: string;
        snapshot_hash: string;
        metadata_json: string | null;
      }[]
    )
      // LIKE matched `file#p…`; keep only refs whose path is exactly `file`.
      .filter((r) => passagePathOf(r.source_ref) === file)
      .map((r) => ({
        id: r.id,
        ref: r.source_ref,
        body: r.body,
        hash: r.snapshot_hash,
        root: readRoot(r.metadata_json),
      }));
    this.byFile.set(file, rows);
    return rows;
  }

  private readonly prepared = new Map<string, PreparedText>();
  /** Each passage is normalised once per call, however many claims cite it. */
  prep(row: Row): PreparedText {
    let p = this.prepared.get(row.id);
    if (!p) {
      p = preparePassage(row.body);
      this.prepared.set(row.id, p);
    }
    return p;
  }

  byId(id: string): Row | undefined {
    const r = this.db
      .prepare(
        `SELECT id, source_ref, body, snapshot_hash, metadata_json FROM vector_document
         WHERE id = ? AND source_kind = 'vault_page'`,
      )
      .get(id) as
      | { id: string; source_ref: string | null; body: string; snapshot_hash: string; metadata_json: string | null }
      | undefined;
    if (!r || !r.source_ref) return undefined;
    return { id: r.id, ref: r.source_ref, body: r.body, hash: r.snapshot_hash, root: readRoot(r.metadata_json) };
  }

  /**
   * The indexed note that is this file on disk, found by name then by real
   * path. A folder reached through a link is indexed under the link's name
   * and walked once, so the note's real path matched no row (review A).
   */
  sameFile(real: string): { r: string; rel: string } | undefined {
    const name = real.split(sep).pop() ?? "";
    const like = `%${name.replace(/[\\%_]/g, "\\$&")}#p%`;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT source_ref, metadata_json FROM vector_document
         WHERE source_kind = 'vault_page' AND source_ref LIKE ? ESCAPE '\\'`,
      )
      .all(like) as { source_ref: string; metadata_json: string | null }[];
    for (const row of rows) {
      const root = readRoot(row.metadata_json);
      const rel = passagePathOf(row.source_ref);
      if (root !== null && rel.split("/").pop() === name && nativeReal(resolve(root, rel)) === real) {
        return { r: root, rel };
      }
    }
    return undefined;
  }

  ingestRoots(): string[] {
    this.roots ??= (
      this.db
        .prepare(
          `SELECT DISTINCT json_extract(metadata_json, '$.ingestRoot') AS root FROM vector_document
           WHERE source_kind = 'vault_page' AND metadata_json IS NOT NULL`,
        )
        .all() as { root: unknown }[]
    )
      .map((r) => r.root)
      .filter((r): r is string => typeof r === "string");
    return this.roots;
  }
}

const NO_ROOT = (src: string): string =>
  `${src}: indexed without a recorded note folder, so it cannot be compared with the disk — run \`chamber ingest\``;

interface Resolved {
  rows: Row[];
  problem?: string;
  stale?: boolean;
}

/**
 * One cited source → the indexed passages it names. An absolute path is
 * mapped through the ingest roots recorded on the rows; only a file that is
 * indexed is ever read from disk, so a path outside the corpus reads nothing.
 */
function resolveSource(index: Index, raw: string, freshness: Map<string, string | null>): Resolved {
  const src = raw.trim();
  if (src === "") return { rows: [], problem: "empty source" };
  if (/^vdoc_[0-9a-f]+$/.test(src)) {
    const row = index.byId(src);
    if (!row) return { rows: [], problem: `${src}: no such passage in the index` };
    if (row.root === null) return { rows: [], problem: NO_ROOT(src) };
    const stale = staleness(index, passagePathOf(row.ref), row.root, freshness);
    return stale ? { rows: [], problem: stale, stale: true } : { rows: [row] };
  }

  const expanded = src.startsWith("~/") ? `${homedir()}${src.slice(1)}` : src;
  const passage = /#p(\d+)$/.exec(expanded);
  const pathPart = passage ? expanded.slice(0, passage.index) : expanded;

  let file: string;
  let root: string | null = null;
  if (isAbsolute(pathPart)) {
    // Two readings of the path against each root, because ingest keys a note
    // by the path it walked: as written (a note inside a symlinked folder is
    // indexed under the link's name) and with links resolved (~/Vault → the
    // real vault). Anything else — the target of a linked folder, a path in
    // other letter case on macOS — is matched by real path in sameFile()
    // (review A, 2026-09-27).
    const hits = index.ingestRoots().flatMap((r) =>
      [relative(r, resolve(pathPart)), relative(realOrSelf(r), realOrSelf(pathPart))]
        .filter(inside)
        .map((rel) => ({ r, rel: rel.split(sep).join("/") })),
    );
    if (hits.length === 0) return { rows: [], problem: `${src}: not under any ingest root — not indexed` };
    // The deepest root that holds the file: a note under a nested root belongs
    // to it, unless that root excluded it and an outer root indexed it.
    hits.sort((a, b) => a.rel.length - b.rel.length);
    const holder =
      hits.find((h) => index.passagesOf(h.rel).some((r) => r.root === h.r)) ??
      index.sameFile(nativeReal(pathPart)) ??
      hits[0]!;
    root = holder.r;
    file = holder.rel;
  } else {
    file = pathPart.replace(/^\.\//, "");
  }

  let rows = index.passagesOf(file);
  if (root !== null) rows = rows.filter((r) => r.root === root);
  // A row with no recorded root — written before roots were, or by the code
  // and SCIP indexers — has no file on disk this check can compare, and a
  // verdict on it would be the one judgement here with no freshness check
  // behind it (review of chamber_check: a legacy row and a code_index row
  // both came back SUPPORTED for files that did not exist).
  if (rows.length > 0 && rows.every((r) => r.root === null)) return { rows: [], problem: NO_ROOT(src) };
  rows = rows.filter((r) => r.root !== null);
  if (rows.length === 0) {
    return {
      rows: [],
      problem: `${src}: not in the index${isAbsolute(pathPart) ? " (excluded, or never ingested)" : " — pass the absolute path"}`,
    };
  }
  const roots = new Set(rows.map((r) => r.root));
  if (roots.size > 1) {
    return { rows: [], problem: `${src}: held by ${roots.size} ingest roots — pass the absolute path` };
  }
  const stale = staleness(index, file, rows[0]!.root, freshness);
  if (stale) return { rows: [], problem: stale, stale: true };
  if (passage) {
    const want = `${file}#p${passage[1]}`;
    const row = rows.find((r) => r.ref === want);
    return row ? { rows: [row] } : { rows: [], problem: `${src}: the note has no passage p${passage[1]} in the index` };
  }
  return { rows };
}

/**
 * Does the index still hold what the file on disk says? Re-split exactly as
 * ingest does and compare passage by passage. Returns a problem line, or
 * undefined when the index matches. Rows without a root never get here —
 * resolveSource refuses them.
 */
function staleness(
  index: Index,
  file: string,
  root: string | null,
  cache: Map<string, string | null>,
): string | undefined {
  const key = `${root ?? ""}\u0000${file}`;
  if (cache.has(key)) return cache.get(key) ?? undefined;
  let problem: string | null = null;
  if (root !== null) {
    const rows = index.passagesOf(file).filter((r) => r.root === root);
    problem = readAndCompare(resolve(root, file), root, file, rows);
  }
  cache.set(key, problem);
  return problem ?? undefined;
}

/**
 * Compare the file on disk with its indexed passages, reading it only if it is
 * safe to. Opened without following a final symlink and without blocking, then
 * checked to be a regular file of plausible size before a byte is read:
 * - a FIFO put in a note's place hung the whole MCP server in readFileSync;
 * - a note swapped for a link to a file ingest never indexed (a dot-folder,
 *   an excluded path) was read and compared;
 * - a note grown to 100 MB cost 1.5 GB to decide it was stale
 * (review A, 2026-09-27). A link anywhere in the directory part must still
 * resolve inside the root, as ingest requires.
 * Returns a problem line, or null when the disk matches the index.
 */
function readAndCompare(full: string, root: string, file: string, rows: Row[]): string | null {
  if (!inside(relative(nativeReal(root), nativeReal(full)))) {
    return `${file}: now resolves outside its ingest root — not read, not judged`;
  }
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `${file}: indexed, but no longer on disk — run \`chamber prune\``;
    if (code === "ELOOP") return `${file}: is now a symbolic link — not read, not judged`;
    return `${file}: indexed, but unreadable on disk (${code ?? "error"}) — not judged`;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return `${file}: is no longer a regular file — not read, not judged`;
    const indexedBytes = rows.reduce((n, r) => n + Buffer.byteLength(r.body), 0);
    if (st.size > indexedBytes * 8 + 1_000_000) {
      return `${file}: changed on disk since the last ingest (far larger than the indexed copy) — run \`chamber ingest\``;
    }
    const disk = splitPassages(splitFrontmatter(readFileSync(fd, "utf8")).body);
    const indexed = new Map(rows.map((r) => [r.ref, r.body]));
    const same = disk.length === indexed.size && disk.every((p) => indexed.get(`${file}#p${p.index}`) === p.body);
    return same ? null : `${file}: changed on disk since the last ingest — run \`chamber ingest\``;
  } finally {
    closeSync(fd);
  }
}

/**
 * Greedy set cover: repeatedly take the passage holding the most terms not yet
 * covered. Taking every passage with any term pinned 17 of 58 passages of a
 * real note because one term ("NVIDIA") ran through all of them; the passage
 * that states the claim holds every term at once and is taken first.
 */
function cover(index: Index, terms: string[], rows: Row[]): Row[] {
  const held = rows.map((r) => {
    const miss = new Set(termsMissingIn(terms, index.prep(r)));
    return { r, has: new Set(terms.filter((t) => !miss.has(t))) };
  });
  const left = new Set(terms);
  const chosen: Row[] = [];
  while (left.size > 0) {
    let best: { r: Row; has: Set<string> } | undefined;
    let gain = 0;
    for (const h of held) {
      const g = [...h.has].filter((t) => left.has(t)).length;
      if (g > gain) {
        gain = g;
        best = h;
      }
    }
    if (!best) break;
    chosen.push(best.r);
    for (const t of best.has) left.delete(t);
  }
  return chosen;
}

/** Check each claim against the notes it cites. Writes nothing unless `record`. */
export function checkClaims(
  db: DatabaseSync,
  claims: CheckInput[],
  opts: { record?: boolean } = {},
): CheckResult[] {
  if (claims.length > MAX_CHECK_CLAIMS) {
    throw new Error(`chamber_check: at most ${MAX_CHECK_CLAIMS} claims per call (got ${claims.length}) — nothing was checked`);
  }
  // Every limit is checked before the first claim is judged: with `record`,
  // a limit that failed on claim 2 threw after claim 1 was committed, and the
  // caller took the error to mean nothing was written (review of chamber_check).
  claims.forEach((c, i) => {
    if (c.text.trim().length > MAX_CHECK_CLAIM_CHARS) {
      throw new Error(`chamber_check: claims[${i}] is over ${MAX_CHECK_CLAIM_CHARS} characters — nothing was checked`);
    }
    if (c.sources.length > MAX_CHECK_SOURCES) {
      throw new Error(`chamber_check: claims[${i}] has over ${MAX_CHECK_SOURCES} sources — nothing was checked`);
    }
  });
  const index = new Index(db);
  const freshness = new Map<string, string | null>();
  return claims.map((c) => {
    const text = c.text.trim();
    const terms = specificTerms(text, OPENINGS);
    const base = {
      text,
      terms,
      missing: [] as string[],
      checkedRefs: [] as string[],
      foundIn: [] as string[],
      problems: [] as string[],
    };
    if (c.sources.length === 0) return { ...base, status: "NO_SOURCE" };

    const rows = new Map<string, Row>();
    let stale = false;
    for (const s of c.sources) {
      const r = resolveSource(index, s, freshness);
      if (r.problem) base.problems.push(r.problem);
      if (r.stale) stale = true;
      for (const row of r.rows) rows.set(row.id, row);
    }
    // Any stale source leaves the claim unjudged: the agent's reading of that
    // note and the index's copy of it disagree, and either verdict would be
    // about text one of them never saw.
    if (stale) return { ...base, status: "STALE" };
    if (rows.size === 0) return { ...base, status: "NOT_FOUND" };

    const judged = [...rows.values()];
    base.checkedRefs = judged.map((r) => r.ref);
    const missing = termsMissingIn(terms, joinPrepared(judged.map((r) => index.prep(r))));
    const holders = cover(index, terms, judged);
    base.foundIn = holders.map((r) => r.ref);
    if (missing.length > 0) return { ...base, status: "TERMS_ABSENT", missing };
    // Nothing specific to check: the term check passes vacuously, and calling
    // that SUPPORTED would certify any sentence against any note.
    if (terms.length === 0) return { ...base, status: "NO_TERMS" };

    const result: CheckResult = { ...base, status: "SUPPORTED" };
    if (opts.record) {
      // Pin only the covering passages: a whole-note citation pinned to every
      // passage — or to every passage naming a common term — would report
      // drift for an edit anywhere in the note.
      const sources: ContractSource[] = holders.map((r) => ({
        kind: "vault_page",
        refId: r.id,
        snapshotHash: r.hash,
      }));
      const r = enforceClaimContract(
        db,
        { kind: "assertion", text },
        { sources, strict: true, authorFamily: "mcp_check" },
      );
      result.recorded = { status: r.status, beliefId: r.beliefId, reason: r.reason };
    }
    return result;
  });
}

const EXPLAIN: Record<CheckStatus, string> = {
  SUPPORTED: "every term Chamber recognises occurs in the cited text",
  TERMS_ABSENT: "the cited text does not contain",
  NO_TERMS: "nothing specific to check (no number, name, domain, file name or count) — only that the source exists",
  STALE: "not judged — the note on disk no longer matches the index, or could not be safely read",
  NOT_FOUND: "not judged — no cited source could be resolved to an indexed note",
  NO_SOURCE: "not judged — cited nothing",
};

/** "notes/a.md (58 passages)", or the refs themselves when a passage was cited. */
function describeChecked(refs: string[]): string {
  const byFile = new Map<string, number>();
  for (const ref of refs) byFile.set(passagePathOf(ref), (byFile.get(passagePathOf(ref)) ?? 0) + 1);
  if (refs.length <= 2) return refs.join(", ");
  return [...byFile].map(([f, n]) => `${f} (${n} passage${n === 1 ? "" : "s"})`).join(", ");
}

export function formatCheck(results: CheckResult[], recorded: boolean): string {
  const count = (s: CheckStatus): number => results.filter((r) => r.status === s).length;
  const out = [
    `${results.length} claim(s): ${count("SUPPORTED")} supported · ${count("TERMS_ABSENT")} terms absent · ` +
      `${count("NO_TERMS")} nothing to check · ${count("STALE") + count("NOT_FOUND") + count("NO_SOURCE")} not judged`,
    "",
  ];
  for (const r of results) {
    out.push(`[${r.status}] ${r.text}`);
    out.push(
      r.status === "TERMS_ABSENT"
        ? `     ${EXPLAIN[r.status]}: ${r.missing.join(", ")}`
        : `     ${EXPLAIN[r.status]}`,
    );
    if (r.checkedRefs.length) out.push(`     checked: ${describeChecked(r.checkedRefs)}`);
    if (r.foundIn.length) {
      const shown = r.foundIn.slice(0, 4).join(", ");
      const label = r.status === "SUPPORTED" ? "found in" : "other terms in";
      out.push(`     ${label}: ${shown}${r.foundIn.length > 4 ? ` (+${r.foundIn.length - 4} more)` : ""}`);
    }
    for (const p of r.problems) out.push(`     ${p}`);
    if (r.recorded) {
      out.push(
        `     recorded: ${r.recorded.status}${r.recorded.beliefId ? ` ${r.recorded.beliefId}` : ""}` +
          (r.recorded.reason ? ` — ${r.recorded.reason}` : ""),
      );
    }
  }
  out.push(
    "",
    "SUPPORTED means the specifics are in the note, not that the sentence means what the note means: " +
      "a negated, reversed or misattributed claim built from the note's own words passes. " +
      (recorded
        ? "Recorded claims are pinned to the passages found; after the next `chamber ingest`, `chamber_verify` reports any whose pinned passage changed."
        : "Nothing was recorded (pass `record: true` to pin supported claims for drift checks)."),
  );
  return out.join("\n");
}
