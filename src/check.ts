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
 * Chamber could judge the indexed copy. A note edited since the last ingest
 * would be judged on text the agent never read — a pass over old text, or a
 * flag for a sentence the note now contains. So an absolute path is judged
 * from the file itself and compared with the index: when the index is behind,
 * the verdict says so and nothing is recorded, because a pin would point at
 * text the file no longer holds. A passage ref is judged from the index (the
 * text `chamber_ask` showed) and says when the file has moved on since.
 */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { passagePathOf, splitPassages } from "./chunk.ts";
import { citedPassage, joinPrepared, specificTerms, termsMissingIn, type PreparedText } from "./claim_support.ts";
import { enforceClaimContract, type ContractSource } from "./contract.ts";
import { countExcludeMatches, passageTitle, pathRefusal, splitFrontmatter } from "./ingest.ts";
import { vaultPageHash } from "./vault_page_hash.ts";
import { mergeDeclaredFolders, type DeclaredFolder } from "./declared_folders.ts";

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
  title: string | null;
  hash: string;
  root: string | null;
  /** Read from disk for this call, not from the index: it has no row to pin. */
  disk?: true;
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

/** Cached per `${root}\0${exclude.join("\0")}` — null means the folder is not poisoned. */
const excludePoisonCache = new Map<string, string | null>();

function buildPoisonedRoots(folders: readonly DeclaredFolder[]): Map<string, string> {
  const poisoned = new Map<string, string>();
  for (const folder of folders) {
    if (folder.exclude.length === 0) continue;
    const key = `${folder.root}\0${folder.exclude.join("\0")}`;
    let message = excludePoisonCache.get(key);
    if (message === undefined) {
      const counts = countExcludeMatches(folder.root, folder.exclude);
      // An unreadable root is not "the exclude matched nothing". Caching that
      // lie refuses the folder for the rest of the process after the disk returns.
      if (counts.some((c) => c.unreadable)) {
        poisoned.set(folder.root, "notes folder is unreadable — nothing in this folder was checked");
        continue;
      }
      message = null;
      for (const count of counts) {
        if (count.matched === 0) {
          message = `--exclude matched nothing: ${JSON.stringify(count.raw)} — nothing in this folder was checked`;
          break;
        }
      }
      excludePoisonCache.set(key, message);
    }
    if (message) poisoned.set(folder.root, message);
  }
  return poisoned;
}

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
          `SELECT id, source_ref, body, title, snapshot_hash, metadata_json FROM vector_document
           WHERE source_kind = 'vault_page' AND (source_ref LIKE ? ESCAPE '\\' OR source_ref = ?)`,
        )
        .all(like, file) as {
        id: string;
        source_ref: string;
        body: string;
        title: string | null;
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
        title: r.title,
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
      p = citedPassage(row.body, row.title, row.ref);
      this.prepared.set(row.id, p);
    }
    return p;
  }

  byId(id: string): Row | undefined {
    const r = this.db
      .prepare(
        `SELECT id, source_ref, body, title, snapshot_hash, metadata_json FROM vector_document
         WHERE id = ? AND source_kind = 'vault_page'`,
      )
      .get(id) as
      | { id: string; source_ref: string | null; body: string; title: string | null; snapshot_hash: string; metadata_json: string | null }
      | undefined;
    if (!r || !r.source_ref) return undefined;
    return { id: r.id, ref: r.source_ref, body: r.body, title: r.title, hash: r.snapshot_hash, root: readRoot(r.metadata_json) };
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
  /** Further problem lines that do not stop the rows being judged. */
  notes?: string[];
  /** A path that was refused or could not be read from disk: the claim is not judged. */
  refused?: boolean;
  /** The rows judged are not text the index holds against the file: `record` must not pin. */
  unpinnable?: boolean;
}

const BEHIND = "index is behind this file";
const PASSAGE_MOVED = "file on disk has changed since this passage was indexed";
const NOT_RECORDED = "not recorded: the index does not hold this text";

/**
 * One cited source → the indexed passages it names. An absolute path is
 * mapped through the ingest roots recorded on the rows; only a file that is
 * indexed is ever read from disk, so a path outside the corpus reads nothing.
 */
function resolveSource(
  index: Index,
  raw: string,
  freshness: Map<string, string | null>,
  folders: readonly DeclaredFolder[],
  poisoned: ReadonlyMap<string, string>,
  declaredRoots: ReadonlySet<string>,
): Resolved {
  const src = raw.trim();
  if (src === "") return { rows: [], problem: "empty source" };
  if (/^vdoc_[0-9a-f]+$/.test(src)) {
    const row = index.byId(src);
    if (!row) return { rows: [], problem: `${src}: no such passage in the index` };
    if (row.root === null) return { rows: [], problem: NO_ROOT(src) };
    const blocked = citationRefusal(src, resolve(row.root, passagePathOf(row.ref)), folders, poisoned);
    if (blocked) return { rows: [], problem: blocked, refused: true };
    const stale = staleness(index, passagePathOf(row.ref), row.root, freshness);
    return stale ? { rows: [row], notes: [PASSAGE_MOVED], unpinnable: true } : { rows: [row] };
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
    // An absolute path with no passage is the file the agent read: judged from
    // disk, and compared with whatever the index holds for it.
    const blocked = citationRefusal(src, pathPart, folders, poisoned);
    if (blocked) return { rows: [], problem: blocked, refused: true };
    if (!passage) {
      if (indexedHolder(index, pathPart)) return judgeIndexed(index, src, pathPart, null);
      return resolveFromDisk(index, src, pathPart, null, folders, poisoned, declaredRoots);
    }
    const hits = rootHits(index, pathPart);
    if (hits.length === 0) return resolveFromDisk(index, src, pathPart, Number(passage[1]), folders, poisoned, declaredRoots);
    const holder = indexedHolder(index, pathPart, hits) ?? hits[0]!;
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
    if (isAbsolute(pathPart)) {
      return resolveFromDisk(index, src, pathPart, passage ? Number(passage[1]) : null, folders, poisoned, declaredRoots);
    }
    return { rows: [], problem: `${src}: not in the index — pass the absolute path` };
  }
  const roots = new Set(rows.map((r) => r.root));
  if (roots.size > 1) {
    return { rows: [], problem: `${src}: held by ${roots.size} ingest roots — pass the absolute path` };
  }
  const located = resolve(rows[0]!.root!, file);
  if (!passage) {
    // A relative path the index maps to exactly one file is that file's
    // absolute path, so it and the absolute path cannot disagree about an edit.
    const blocked = citationRefusal(src, located, folders, poisoned);
    if (blocked) return { rows: [], problem: blocked, refused: true };
    return judgeIndexed(index, src, located, null);
  }
  // A relative `file.md#pN` is the same file. Exclude and poison run before
  // staleness opens it, for this spelling and for a vdoc_ id alike.
  const blocked = citationRefusal(src, located, folders, poisoned);
  if (blocked) return { rows: [], problem: blocked, refused: true };
  const want = `${file}#p${passage[1]}`;
  const row = rows.find((r) => r.ref === want);
  if (!row) return { rows: [], problem: `${src}: the note has no passage p${passage[1]} in the index` };
  const stale = staleness(index, file, rows[0]!.root, freshness);
  return stale ? { rows: [row], notes: [PASSAGE_MOVED], unpinnable: true } : { rows: [row] };
}

type Holder = { folder: DeclaredFolder; realRoot: string; path: string; rel: string };

/**
 * Every declared folder that contains `pathPart`, outermost first. The path is
 * judged as written; only when its directory is an alias of the folder's real
 * path is the parent resolved. The leaf is never resolved here.
 */
function declaredHolders(pathPart: string, folders: readonly DeclaredFolder[]): Holder[] {
  const abs = resolve(pathPart);
  let parentReal: string | undefined;
  try {
    parentReal = join(realpathSync.native(dirname(abs)), basename(abs));
  } catch {
    parentReal = undefined;
  }
  const holders: Holder[] = [];
  for (const folder of folders) {
    const realRoot = realOrSelf(folder.root);
    for (const cand of parentReal === undefined || parentReal === abs ? [abs] : [abs, parentReal]) {
      const rel = relative(realRoot, cand);
      if (inside(rel)) {
        holders.push({ folder, realRoot, path: cand, rel: rel.split(sep).join("/") });
        break;
      }
    }
  }
  // Outermost first: it names the file in the output, and its refusal is read first.
  return holders.sort((a, b) => a.realRoot.length - b.realRoot.length);
}

/** The first poison message among the folders holding a path; checked before any open. */
function poisonOf(holders: readonly Holder[], poisoned: ReadonlyMap<string, string>): string | undefined {
  for (const h of holders) {
    const poison = poisoned.get(h.folder.root);
    if (poison) return poison;
  }
  return undefined;
}

/**
 * Refuse a citation a declared folder does not allow, before the file is opened.
 * A path under no declared folder is not refused here: an indexed note stays
 * reachable. A missing file is left to the freshness read, which names prune.
 */
function citationRefusal(
  src: string,
  pathPart: string,
  folders: readonly DeclaredFolder[],
  poisoned: ReadonlyMap<string, string>,
): string | undefined {
  const holders = declaredHolders(pathPart, folders);
  const poison = poisonOf(holders, poisoned);
  if (poison) return poison;
  const keep = (reason: string, kind: string): string | undefined =>
    kind === "unreadable" && reason.includes("ENOENT") ? undefined : `${src}: ${reason}`;
  for (const h of holders) {
    const refusal = pathRefusal(h.folder.root, h.folder.exclude, h.path);
    if (!refusal) continue;
    const line = keep(refusal.reason, refusal.kind);
    if (line) return line;
  }
  const target = strictReal(resolve(pathPart));
  if (!("path" in target)) return undefined;
  for (const folder of folders) {
    if (!inside(relative(realOrSelf(folder.root), target.path))) continue;
    const refusal = pathRefusal(folder.root, folder.exclude, target.path);
    if (!refusal) continue;
    const line = keep(refusal.reason, refusal.kind);
    if (line) return line;
  }
  return undefined;
}

/** The disk text is the indexed text, title included. Body-only equality misses a frontmatter rename. */
function diskMatches(rows: readonly Row[], text: string, fileRel: string): boolean {
  const { title, body } = splitFrontmatter(text);
  const passages = text.trim() === "" || body.trim() === "" ? [] : splitPassages(body);
  if (passages.length !== rows.length) return false;
  const docTitle = title ?? fileRel.replace(/\.(?:md|markdown)$/i, "");
  const byRef = new Map(rows.map((r) => [r.ref, r]));
  return passages.every((p) => {
    const ref = `${fileRel}#p${p.index}`;
    const row = byRef.get(ref);
    if (!row) return false;
    return (
      row.hash ===
      vaultPageHash({ title: passageTitle(docTitle, p.headings), body: p.body, source_ref: ref })
    );
  });
}

/** An indexed file, read from disk and compared. A declared folder's exclude already ran. */
function judgeIndexed(
  index: Index,
  src: string,
  pathPart: string,
  passageNo: number | null,
): Resolved {
  const refuse = (problem: string): Resolved => ({ rows: [], problem, refused: true });
  const held = indexedHolder(index, pathPart);
  if (!held) return refuse(`${src}: not in the index — pass the absolute path`);
  const full = resolve(held.r, held.rel);
  const target = strictReal(full);
  if (!("path" in target)) {
    return target.code === "ENOENT"
      ? refuse(`${src}: indexed, but no longer on disk — run \`chamber prune\``)
      : refuse(`${src}: its path does not resolve (${target.code}) — not read, not judged`);
  }
  const read = readBounded(full, target.path);
  if ("problem" in read) return refuse(`${src}: ${read.problem} — not read, not judged`);
  const indexed = index.passagesOf(held.rel).filter((r) => r.root === held.r);
  if (diskMatches(indexed, read.text, held.rel)) {
    if (passageNo === null) return { rows: indexed };
    const row = indexed.find((r) => r.ref === `${held.rel}#p${passageNo}`);
    return row ? { rows: [row] } : refuse(`${src}: the note has no passage p${passageNo}`);
  }
  const { title, body } = splitFrontmatter(read.text);
  const passages = body.trim() === "" ? [] : splitPassages(body);
  if (passages.length === 0) return refuse(`${src}: empty body — nothing to judge`);
  const docTitle = title ?? held.rel.replace(/\.(?:md|markdown)$/i, "");
  const all: Row[] = passages.map((p) => ({
    id: `disk:${target.path}#p${p.index}`,
    ref: `${held.rel}#p${p.index}`,
    body: p.body,
    title: passageTitle(docTitle, p.headings),
    hash: "",
    root: held.r,
    disk: true,
  }));
  const notes = [BEHIND];
  if (passageNo === null) return { rows: all, notes, unpinnable: true };
  const one = all.find((r) => r.ref === `${held.rel}#p${passageNo}`);
  return one ? { rows: [one], notes, unpinnable: true } : refuse(`${src}: the note has no passage p${passageNo}`);
}

/** Every ingest root that holds `pathPart`, by the path as written and with links resolved. */
function rootHits(index: Index, pathPart: string): { r: string; rel: string }[] {
  const hits = index.ingestRoots().flatMap((r) =>
    [relative(r, resolve(pathPart)), relative(realOrSelf(r), realOrSelf(pathPart))]
      .filter(inside)
      .map((rel) => ({ r, rel: rel.split(sep).join("/") })),
  );
  // The deepest root that holds the file: a note under a nested root belongs
  // to it, unless that root excluded it and an outer root indexed it.
  hits.sort((a, b) => a.rel.length - b.rel.length);
  return hits;
}

/** The root and path of the index row that is this file, if there is one. */
function indexedHolder(
  index: Index,
  pathPart: string,
  hits: { r: string; rel: string }[] = rootHits(index, pathPart),
): { r: string; rel: string } | undefined {
  return hits.find((h) => index.passagesOf(h.rel).some((r) => r.root === h.r)) ?? index.sameFile(nativeReal(pathPart));
}

/**
 * An absolute path no index row answers for, judged from the file itself when
 * a declared notes folder holds it. Nothing is written: no embedding, no row.
 *
 * Every folder that contains the path must allow it (`pathRefusal`, the walk's
 * own decision), and the first refusal wins before the file is opened. The path
 * is judged as written; only when its directory is an alias of the folder's
 * real path (/tmp for /private/tmp) is the parent resolved, and the leaf never
 * is before the classifier has seen it.
 */
function resolveFromDisk(
  index: Index,
  src: string,
  pathPart: string,
  passageNo: number | null,
  folders: readonly DeclaredFolder[],
  poisoned: ReadonlyMap<string, string>,
  declaredRoots: ReadonlySet<string>,
): Resolved {
  const refuse = (problem: string): Resolved => ({ rows: [], problem, refused: true });
  if (folders.length === 0) {
    return refuse("no notes folder declared — chamber mcp --notes <folder>");
  }
  const holders = declaredHolders(pathPart, folders);
  if (holders.length === 0) return refuse(`${src}: not under any declared folder`);
  const poison = poisonOf(holders, poisoned);
  if (poison) return refuse(poison);
  for (const h of holders) {
    const refusal = pathRefusal(h.folder.root, h.folder.exclude, h.path);
    if (refusal) {
      // A path the index holds and the disk no longer does: the indexed text is
      // not a fallback, and the row is cleared by `chamber prune`.
      if (refusal.kind === "unreadable" && refusal.reason.includes("ENOENT") && indexedHolder(index, pathPart)) {
        return refuse(`${src}: indexed, but no longer on disk — run \`chamber prune\``);
      }
      return refuse(`${src}: ${refusal.reason}`);
    }
  }
  const outer = holders[0]!;
  const target = strictReal(outer.path);
  if (!("path" in target)) {
    // The indexed text is not a fallback for a path that is gone: say so, and
    // say how to clear the row.
    if (target.code === "ENOENT" && indexedHolder(index, pathPart)) {
      return refuse(`${src}: indexed, but no longer on disk — run \`chamber prune\``);
    }
    return refuse(`${src}: its path does not resolve (${target.code}) — not read, not judged`);
  }
  const real = target.path;
  for (const h of holders) {
    if (!inside(relative(realOrSelf(h.folder.root), real))) {
      return refuse(`${src}: resolves outside its notes folder — not read, not judged`);
    }
  }
  // Classify the file that will be opened, not only the spelling that was cited:
  // a link to a folder in the same root (`zlink` -> `work`) walks past a
  // multi-segment exclude (`work/clients`) when only the cited spelling is
  // judged, while ingest skips that link as a cycle and never reads the file.
  // Every declared folder whose real root holds the real path must allow it.
  for (const folder of folders) {
    if (!inside(relative(realOrSelf(folder.root), real))) continue;
    const refusal = pathRefusal(folder.root, folder.exclude, real);
    if (refusal) return refuse(`${src}: ${refusal.reason}`);
  }
  // A root that exists only on indexed rows has already applied the walk.
  // It does not authorize reading a file those rows do not hold.
  if (!holders.some((h) => declaredRoots.has(realOrSelf(h.folder.root)))) {
    return refuse(
      declaredRoots.size === 0
        ? "no notes folder declared — chamber mcp --notes <folder>"
        : `${src}: not under any declared folder`,
    );
  }

  const read = readBounded(outer.path, real);
  if ("problem" in read) return refuse(`${src}: ${read.problem} — not read, not judged`);
  const { title, body } = splitFrontmatter(read.text);
  const passages = read.text.trim() === "" || body.trim() === "" ? [] : splitPassages(body);
  if (passages.length === 0) return refuse(`${src}: empty body — nothing to judge`);

  const docTitle = title ?? outer.rel.replace(/\.(?:md|markdown)$/i, "");
  const held = index.sameFile(real);
  if (held) {
    // The index holds this file: is it the text just read? Re-split exactly as
    // ingest does and compare passage by passage, as `staleness` does. Equal,
    // the indexed rows are the disk text and carry the pins `record` needs.
    const indexed = index.passagesOf(held.rel).filter((r) => r.root === held.r);
    const byRef = new Map(indexed.map((r) => [r.ref, r]));
    const equal = diskMatches(indexed, read.text, held.rel);
    if (equal) {
      if (passageNo === null) return { rows: indexed };
      const row = byRef.get(`${held.rel}#p${passageNo}`);
      return row ? { rows: [row] } : refuse(`${src}: the note has no passage p${passageNo}`);
    }
  }
  const all: Row[] = passages.map((p) => ({
    id: `disk:${real}#p${p.index}`,
    ref: `${outer.rel}#p${p.index}`,
    body: p.body,
    title: passageTitle(docTitle, p.headings),
    hash: "",
    root: outer.realRoot,
    disk: true,
  }));
  const notes = [held ? BEHIND : "not indexed yet"];
  if (passageNo === null) return { rows: all, notes, unpinnable: true };
  const one = all.find((r) => r.ref === `${outer.rel}#p${passageNo}`);
  return one
    ? { rows: [one], notes, unpinnable: true }
    : refuse(`${src}: the note has no passage p${passageNo}`);
}

/** Open an allowed path as ingest would be read: no links, no blocking, a regular file, bounded. */
function readBounded(full: string, real: string): { text: string } | { problem: string } {
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return { problem: `unreadable on disk (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { problem: "is not a regular file" };
    const again = strictReal(full);
    let same: ReturnType<typeof statSync> | undefined;
    try {
      same = statSync(real);
    } catch {
      same = undefined;
    }
    if (!("path" in again) || again.path !== real || !same || same.ino !== st.ino || same.dev !== st.dev) {
      return { problem: "changed while being opened" };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(1024 * 1024);
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_COMPARE_BYTES) return { problem: `over ${MAX_COMPARE_BYTES / 1024 / 1024} MB — too large to read` };
      chunks.push(buf.subarray(0, n));
    }
    return { text: Buffer.concat(chunks).toString("utf8") };
  } finally {
    closeSync(fd);
  }
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
    problem = readAndCompare(index, resolve(root, file), root, file, rows);
  }
  cache.set(key, problem);
  return problem ?? undefined;
}

/**
 * Compare the file on disk with its indexed passages, reading it only if the
 * read is one ingest itself made. The rule: the note's real path must resolve
 * (no fallback), and it must be the indexed note itself or another note the
 * same root indexed. A link is followed only to an indexed note (review D:
 * ingest indexes a linked note under the link's name, so refusing links made
 * those notes permanently STALE), never to a file ingest skipped — an excluded
 * folder, a dot-folder, a `.env` (review E, 2026-09-27). Asking the index
 * rather than re-implementing ingest's rules is what keeps the two from
 * disagreeing: a dot-rule here marked `--include-dotted` notes STALE forever.
 *
 * Then the resolved path is opened without following links and without
 * blocking, re-resolved and compared by inode to narrow a swap between
 * resolving and opening (review E measured 2,299 hits in 36,612 calls without
 * this; a swapped directory mid-path keeps a small window — Node has no
 * openat), checked to be a regular file, and read in a bounded loop: a file
 * growing after fstat was read to EOF past the cap. A FIFO in a note's place
 * once hung the MCP server in readFileSync (review A).
 * Returns a problem line, or null when the disk matches the index.
 */
const MAX_COMPARE_BYTES = 32 * 1024 * 1024;
const notJudged = (file: string, why: string): string => `${file}: ${why} — not read, not judged`;

function strictReal(p: string): { path: string } | { code: string } {
  try {
    return { path: realpathSync.native(p) };
  } catch (err) {
    return { code: (err as NodeJS.ErrnoException).code ?? "error" };
  }
}

function readAndCompare(index: Index, full: string, root: string, file: string, rows: Row[]): string | null {
  const realRoot = strictReal(root);
  if (!("path" in realRoot)) return notJudged(file, `its ingest root does not resolve (${realRoot.code})`);
  const resolved = strictReal(full);
  if (!("path" in resolved)) {
    return resolved.code === "ENOENT"
      ? `${file}: indexed, but no longer on disk — run \`chamber prune\``
      : notJudged(file, `its path does not resolve (${resolved.code})`);
  }
  const real = resolved.path;
  const rel = relative(realRoot.path, real);
  if (!inside(rel)) return notJudged(file, "now resolves outside its ingest root");
  const target = rel.split(sep).join("/");
  // Case-insensitive, as the filesystems this runs on are: `rel` is in on-disk
  // case, the indexed path in whatever case ingest walked.
  const isSelf = target.toLowerCase() === file.toLowerCase();
  if (!isSelf && !index.passagesOf(target).some((r) => r.root === root)) {
    return notJudged(file, "now links to a file this root did not index");
  }

  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `${file}: indexed, but no longer on disk — run \`chamber prune\``;
    return notJudged(file, `unreadable on disk (${code ?? "error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return notJudged(file, "is no longer a regular file");
    const again = strictReal(full);
    let same: ReturnType<typeof statSync> | undefined;
    try {
      same = statSync(real);
    } catch {
      same = undefined;
    }
    if (!("path" in again) || again.path !== real || !same || same.ino !== st.ino || same.dev !== st.dev) {
      return notJudged(file, "changed while being opened");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(1024 * 1024);
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_COMPARE_BYTES) {
        return notJudged(file, `over ${MAX_COMPARE_BYTES / 1024 / 1024} MB on disk — too large to compare`);
      }
      chunks.push(buf.subarray(0, n));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return diskMatches(rows, text, file)
      ? null
      : `${file}: changed on disk since the last ingest — run \`chamber ingest\``;
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
  opts: { record?: boolean; folders?: readonly DeclaredFolder[] } = {},
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
  // Caller folders authorize a disk read of a file the index does not hold.
  // Roots remembered on rows still take part in the walk (dotted entries,
  // links) but do not grant that read: their ingest excludes were not stored.
  const declared = opts.folders ?? [];
  const declaredRoots = new Set(declared.map((f) => realOrSelf(f.root)));
  const folders = mergeDeclaredFolders([
    ...declared,
    ...index.ingestRoots().map((root) => ({ root, exclude: [] as string[] })),
  ]);
  const poisoned = buildPoisonedRoots(folders);
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
    let refused = false;
    let unpinnable = false;
    for (const s of c.sources) {
      const r = resolveSource(index, s, freshness, folders, poisoned, declaredRoots);
      if (r.problem) base.problems.push(r.problem);
      if (r.notes) base.problems.push(...r.notes);
      if (r.refused) refused = true;
      if (r.unpinnable) unpinnable = true;
      for (const row of r.rows) rows.set(row.id, row);
    }
    // A source that was refused or unreadable leaves the claim unjudged: the
    // sources that did resolve would answer for a citation that was not read.
    if (refused) return { ...base, status: "NOT_FOUND" };
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
    // Pin only text the index holds and the file still matches. A disk reading
    // with no row, or whose row is behind, and a passage whose file has moved on
    // would each mint a belief source for text the file does not contain — and
    // one such source refuses the whole claim, even when another source is a
    // row that `cover` would have pinned on its own.
    if (opts.record && unpinnable) {
      result.problems.push(NOT_RECORDED);
    } else if (opts.record) {
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
  NOT_FOUND: "not judged — a cited source could not be read",
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
