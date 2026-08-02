/**
 * Markdown corpus ingest.
 *
 * This command is pointed at personal vaults that contain folders the owner
 * has deny-listed. `--exclude` is the only control standing between it and
 * those folders, so every ambiguity here is treated as a privacy defect: the
 * walk fails closed, never silently, and anything it did not ingest is named
 * in the report rather than vanishing.
 *
 * Identity: a document is keyed by (ingest root, path relative to that root),
 * so re-ingesting a file updates its row in place rather than minting a second
 * pin, while the same relative path under a *different* root gets its own row
 * instead of overwriting the first one's body under the first one's id.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { upsertDocument } from "./vector.ts";

/**
 * Extensions treated as markdown, compared case-insensitively.
 *
 * `.md` alone silently dropped `UPPER.MD` (case), `long.markdown` (the
 * spelled-out extension Obsidian and Jekyll both accept) and `mdx.mdx`, with
 * no entry in the report — the operator saw "ingested N" and believed the
 * corpus was complete. Anything outside this set is now skipped *and named*.
 */
export const MARKDOWN_EXTENSIONS: readonly string[] = [".md", ".markdown", ".mdx"];

/**
 * Why an entry was not ingested. Typed rather than string-matched so callers
 * can rank what to surface first: an excluded or root-escaping entry is a
 * privacy signal, a `.png` is noise.
 */
export type IngestSkipKind =
  | "excluded"
  | "dotted"
  | "symlink_escape"
  | "unreadable"
  | "cycle"
  | "unsupported_extension"
  | "not_regular_file"
  | "empty_body";

export interface IngestSkip {
  /** Path relative to the ingest root, posix-separated. */
  path: string;
  kind: IngestSkipKind;
  reason: string;
}

export interface ExcludeStat {
  /** Exactly what the caller passed. */
  raw: string;
  /** Normalized form actually matched against (posix, lowercased). */
  pattern: string;
  /** How many entries this pattern pruned. */
  matched: number;
}

export interface IngestCollision {
  sourceRef: string;
  /** Roots that already hold a document at this same relative path. */
  existingRoots: string[];
  incomingRoot: string;
}

export interface IngestReport {
  ingested: number;
  skipped: IngestSkip[];
  documentIds: string[];
  /** The resolved (symlink-free, absolute) root that was actually walked. */
  root: string;
  /** Per-pattern prune counts — proof that each exclude did something. */
  excludes: ExcludeStat[];
  /** Raw patterns that pruned nothing: a typo or a quoting mistake. */
  unmatchedExcludes: string[];
  /** Same relative path already ingested from a different root. */
  collisions: IngestCollision[];
  /** True when the run refused to store anything at all. */
  aborted: boolean;
  /**
   * Why it refused. `invalid_exclude` is a malformed pattern and is never
   * overridable; `unmatched_exclude` is the pruned-nothing guard, which
   * `requireExcludeMatch: false` opts out of.
   */
  abortKind?: "invalid_exclude" | "unmatched_exclude";
  abortReason?: string;
}

export interface IngestOptions {
  exclude?: string[];
  /** Ingest dotted entries (`.trash`, `.obsidian`, …). Default false. */
  includeDotted?: boolean;
  /**
   * Refuse the whole run when an exclude pattern matched nothing.
   * Default true — see the abort in `ingestDirectory`.
   */
  requireExcludeMatch?: boolean;
}

/**
 * Strip YAML frontmatter, returning the title (if any) and the body.
 *
 * This is not a YAML parser (zero runtime dependencies — a real parser is
 * out of scope). It handles:
 *  - a `title:` value that itself contains a colon, quoted or not — the
 *    capture group runs to end-of-line, so only the `title:` prefix is
 *    special, not colons inside the value;
 *  - a file that is *only* frontmatter — `body` comes back `""` and the
 *    caller's existing empty-body guard skips it, rather than this function
 *    inventing placeholder content;
 *  - CRLF line endings, via the `\r?` in both the body-strip regex and
 *    regex `.`/`$` line-terminator semantics for the title line;
 *  - a document that never had frontmatter at all (does not start with
 *    `---`) — returned untouched, including any `---` horizontal rules
 *    appearing later in its body.
 *
 * One case beyond the above is guarded deliberately: a document that
 * *opens* with a `---` horizontal rule that is NOT frontmatter (just a
 * stylistic top-of-document divider) followed eventually by another `---`
 * used as an ordinary section break. Naively taking "the next `---`" as the
 * close would treat everything between the two as frontmatter and silently
 * drop it from the body — real content loss with no error. Real
 * frontmatter's first line is always `key: value`; a document opening with
 * a horizontal rule instead of frontmatter essentially never is. So the
 * fenced region is only accepted as frontmatter if it *opens* with a line
 * that looks like `key:`; otherwise the whole raw text is returned as body,
 * exactly as if there had been no leading `---` at all.
 *
 * "Opens with" means the FIRST line inside the fence, not the first
 * non-blank one. That distinction is the whole guard: real YAML
 * frontmatter never begins with a blank line, whereas a stylistic divider
 * is almost always followed by one. Skipping blanks let
 * `---\n\nNote: as discussed…` — an ordinary paragraph whose first line
 * happens to end in a colon (`Note:`, `TODO:`, `Source:`) — read as
 * key-shaped, so the opening paragraph was consumed as frontmatter and
 * silently dropped. Taking the first line verbatim makes that input fall
 * through to the untouched-body path while every real frontmatter block
 * (`title:` first, `tags:` first, CRLF, frontmatter-only) still parses.
 *
 * Deliberately NOT handled (would need real YAML, not a heuristic): prose
 * placed immediately after the opening `---` with no blank line and whose
 * first line looks like `key:` still misparses as frontmatter — on that
 * exact shape a heuristic cannot tell prose from a YAML key. Frontmatter
 * fields other than `title` (lists, nested maps, multi-line block scalars)
 * are not parsed at all; only `title` is ever extracted.
 */
export function splitFrontmatter(raw: string): {
  title?: string;
  body: string;
} {
  if (!raw.startsWith("---")) return { body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { body: raw };
  const front = raw.slice(3, end);

  const firstLine = front.replace(/^\r?\n/, "").split(/\r?\n/)[0] ?? "";
  if (!/^[A-Za-z_][\w-]*\s*:/.test(firstLine.trim())) {
    // Fenced region doesn't open with anything key-shaped — this was a
    // horizontal rule, not frontmatter. Don't consume it or anything up to
    // the next unrelated `---`.
    return { body: raw };
  }

  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const m = front.match(/^title:\s*(.+)$/m);
  return { title: m?.[1]?.trim().replace(/^["']|["']$/g, ""), body };
}

// ─── exclude patterns ────────────────────────────────────────────────────────

interface ExcludePattern {
  raw: string;
  /** Normalized: posix separators, lowercased, no leading `./`, no trailing `/`. */
  pattern: string;
  /** A pattern with no `/` matches any path segment; one with `/` is a root-relative path. */
  segmented: boolean;
  matched: number;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function realpathOrResolve(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

/**
 * Normalize one `--exclude` value against the resolved ingest root.
 *
 * Every form below used to be silently inert — the pattern was compared
 * verbatim against bare entry names, so it matched nothing and the folder it
 * named was ingested at exit 0:
 *   `Private/`   shell tab-completion appends the slash
 *   `./Private`  shell tab-completion prefixes the dot
 *   `a/Private`  a path rather than a name
 *   `/abs/path`  an absolute path, relativized here when it is under the root
 *   `private`    case mismatch against `Private` on case-insensitive APFS
 */
function normalizeExclude(
  raw: string,
  root: string,
): { ok: true; pattern: string; segmented: boolean } | { ok: false; error: string } {
  let p = toPosix(raw.trim());
  if (p === "") return { ok: false, error: `empty --exclude pattern` };

  if (isAbsolute(raw.trim())) {
    // Resolve symlinks in the pattern the same way the root was resolved.
    // On macOS `/tmp` and `/var` are themselves symlinks, so an absolute
    // pattern typed or tab-completed against the unresolved path would
    // otherwise read as "outside the ingest root" and reject a correct
    // pattern. A pattern naming a path that does not exist falls back to a
    // plain resolve and simply matches nothing — which the unmatched-pattern
    // guard then reports.
    const rel = toPosix(relative(root, realpathOrResolve(raw.trim())));
    if (rel === "") {
      return {
        ok: false,
        error: `--exclude ${JSON.stringify(raw)} is the ingest root itself`,
      };
    }
    if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
      return {
        ok: false,
        error: `--exclude ${JSON.stringify(raw)} is outside the ingest root ${root}`,
      };
    }
    p = rel;
  }

  const segments = p.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    return {
      ok: false,
      error: `--exclude ${JSON.stringify(raw)} contains ".." — give a name or a root-relative path`,
    };
  }
  if (segments.length === 0) {
    return { ok: false, error: `--exclude ${JSON.stringify(raw)} normalizes to nothing` };
  }

  // Case-insensitive on purpose. On case-insensitive filesystems (APFS by
  // default) `--exclude private` and a folder named `Private` are the same
  // folder, and a case-sensitive compare let it through. On a case-sensitive
  // filesystem this only ever over-excludes, which loses no privacy.
  const pattern = segments.join("/").toLowerCase();
  return { ok: true, pattern, segmented: segments.length > 1 };
}

/**
 * Does `relPath` (root-relative, posix) hit any pattern?
 *
 * A bare name matches any single path segment, so exclusion applies at every
 * depth, and `private` still does not match `private-notes` — the comparison
 * is segment equality, never a substring test. Only the path *below the root*
 * is examined, so a name occurring somewhere in the root's own ancestry can
 * never silently exclude the entire tree.
 */
function matchExclude(
  patterns: ExcludePattern[],
  relPath: string,
): ExcludePattern | undefined {
  const low = relPath.toLowerCase();
  const segs = low.split("/");
  for (const p of patterns) {
    if (p.segmented) {
      if (low === p.pattern || low.startsWith(`${p.pattern}/`)) return p;
    } else if (segs.includes(p.pattern)) {
      return p;
    }
  }
  return undefined;
}

// ─── walk ────────────────────────────────────────────────────────────────────

interface WalkContext {
  root: string;
  patterns: ExcludePattern[];
  includeDotted: boolean;
  files: string[];
  skipped: IngestSkip[];
  visited: Set<string>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function relPosix(root: string, full: string): string {
  return toPosix(relative(root, full)) || ".";
}

function contained(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Walk `dir`, collecting markdown files and *recording* everything it declines.
 *
 * Every filesystem call here is wrapped. Previously an unreadable directory,
 * a dangling symlink or a symlink loop threw out of the whole ingest before a
 * single file was stored and before `skipped` was populated: one broken link
 * anywhere in a large vault meant zero progress and no partial report. Each of
 * those now lands in `skipped` and the walk carries on.
 *
 * Symlinks are resolved and required to be contained under the resolved root,
 * rather than skipped outright. Obsidian vaults legitimately contain internal
 * links, and skipping them all would drop real content; the danger is only a
 * link whose target sits *outside* the tree the operator pointed at, because
 * that target's real folder name never appears as a walked entry and
 * `--exclude` is therefore structurally unable to stop it. Containment closes
 * exactly that hole while keeping in-vault links working. A contained link is
 * additionally checked against `--exclude` by its *target* path, so
 * `link -> Private/` cannot launder a deny-listed folder past a pattern that
 * only sees the link's own name.
 */
function walk(ctx: WalkContext, dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (err) {
    ctx.skipped.push({
      path: relPosix(ctx.root, dir),
      kind: "unreadable",
      reason: `unreadable directory: ${errText(err)}`,
    });
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relPosix(ctx.root, full);

    // Dotted entries are opt-in. `.trash` holds notes the operator *deleted*;
    // ingesting it resurrects deleted content into a queryable corpus.
    if (!ctx.includeDotted && entry.startsWith(".")) {
      ctx.skipped.push({
        path: rel,
        kind: "dotted",
        reason: "dotted entry (pass --include-dotted to ingest it)",
      });
      continue;
    }

    const hit = matchExclude(ctx.patterns, rel);
    if (hit) {
      hit.matched += 1;
      ctx.skipped.push({
        path: rel,
        kind: "excluded",
        reason: `excluded by --exclude ${hit.raw}`,
      });
      continue;
    }

    let isLink: boolean;
    try {
      isLink = lstatSync(full).isSymbolicLink();
    } catch (err) {
      ctx.skipped.push({
        path: rel,
        kind: "unreadable",
        reason: `unreadable entry: ${errText(err)}`,
      });
      continue;
    }

    let realFull = full;
    if (isLink) {
      try {
        realFull = realpathSync(full);
      } catch (err) {
        // Dangling link, or a loop (ELOOP). Report and keep walking.
        ctx.skipped.push({
          path: rel,
          kind: "unreadable",
          reason: `unresolvable symlink: ${errText(err)}`,
        });
        continue;
      }
      if (!contained(ctx.root, realFull)) {
        ctx.skipped.push({
          path: rel,
          kind: "symlink_escape",
          reason: `symlink escapes the ingest root (points at ${realFull})`,
        });
        continue;
      }
      const targetHit = matchExclude(ctx.patterns, relPosix(ctx.root, realFull));
      if (targetHit) {
        targetHit.matched += 1;
        ctx.skipped.push({
          path: rel,
          kind: "excluded",
          reason: `symlink target excluded by --exclude ${targetHit.raw}`,
        });
        continue;
      }
    }

    let isDir: boolean;
    let isFile: boolean;
    try {
      const st = statSync(realFull);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch (err) {
      ctx.skipped.push({
        path: rel,
        kind: "unreadable",
        reason: `unstattable entry: ${errText(err)}`,
      });
      continue;
    }

    if (isDir) {
      let key: string;
      try {
        key = realpathSync(realFull);
      } catch {
        key = realFull;
      }
      if (ctx.visited.has(key)) {
        ctx.skipped.push({
          path: rel,
          kind: "cycle",
          reason: "directory already visited (symlink cycle or duplicate link)",
        });
        continue;
      }
      ctx.visited.add(key);
      walk(ctx, full);
      continue;
    }

    if (!isFile) {
      ctx.skipped.push({ path: rel, kind: "not_regular_file", reason: "not a regular file" });
      continue;
    }

    const ext = extname(entry).toLowerCase();
    if (!MARKDOWN_EXTENSIONS.includes(ext)) {
      ctx.skipped.push({
        path: rel,
        kind: "unsupported_extension",
        reason: `unsupported extension ${ext || "(none)"} (ingesting ${MARKDOWN_EXTENSIONS.join(", ")})`,
      });
      continue;
    }
    ctx.files.push(full);
  }
}

// ─── identity ────────────────────────────────────────────────────────────────

function readIngestRoot(json: string | null): string | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === "object") {
      const v = (parsed as { ingestRoot?: unknown }).ingestRoot;
      if (typeof v === "string") return v;
    }
  } catch {
    return null;
  }
  return null;
}

function stripMarkdownExt(ref: string): string {
  const ext = extname(ref).toLowerCase();
  return MARKDOWN_EXTENSIONS.includes(ext) ? ref.slice(0, -ext.length) : ref;
}

// ─── ingest ──────────────────────────────────────────────────────────────────

export function ingestDirectory(
  db: DatabaseSync,
  rootInput: string,
  opts: IngestOptions = {},
): IngestReport {
  let root: string;
  try {
    root = realpathSync(resolve(rootInput));
  } catch (err) {
    throw new Error(`ingest root is unreadable: ${rootInput} — ${errText(err)}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new Error(`ingest root is not a directory: ${rootInput}`);
  }

  const patterns: ExcludePattern[] = [];
  const seen = new Set<string>();
  for (const raw of opts.exclude ?? []) {
    const norm = normalizeExclude(raw, root);
    if (!norm.ok) {
      return {
        ingested: 0,
        skipped: [],
        documentIds: [],
        root,
        excludes: [],
        unmatchedExcludes: [raw],
        collisions: [],
        aborted: true,
        abortKind: "invalid_exclude",
        abortReason: norm.error,
      };
    }
    if (seen.has(norm.pattern)) continue;
    seen.add(norm.pattern);
    patterns.push({
      raw,
      pattern: norm.pattern,
      segmented: norm.segmented,
      matched: 0,
    });
  }

  const ctx: WalkContext = {
    root,
    patterns,
    includeDotted: opts.includeDotted === true,
    files: [],
    skipped: [],
    visited: new Set([root]),
  };
  walk(ctx, root);

  const excludes: ExcludeStat[] = patterns.map((p) => ({
    raw: p.raw,
    pattern: p.pattern,
    matched: p.matched,
  }));
  const unmatchedExcludes = patterns.filter((p) => p.matched === 0).map((p) => p.raw);

  const report: IngestReport = {
    ingested: 0,
    skipped: ctx.skipped,
    documentIds: [],
    root,
    excludes,
    unmatchedExcludes,
    collisions: [],
    aborted: false,
  };

  // Fail closed, BEFORE anything is written. A pattern that matched nothing is
  // far more likely a typo or a quoting mistake than a deliberate no-op, and
  // the operator's belief that a folder was excluded is exactly what makes the
  // silent version dangerous. One check catches every inert-pattern shape at
  // once, plus ordinary human error.
  if (opts.requireExcludeMatch !== false && unmatchedExcludes.length > 0) {
    report.aborted = true;
    report.abortKind = "unmatched_exclude";
    report.abortReason =
      `--exclude matched nothing: ${unmatchedExcludes.map((p) => JSON.stringify(p)).join(", ")}` +
      ` — nothing was ingested from ${root}`;
    return report;
  }

  for (const file of ctx.files) {
    const sourceRef = relPosix(root, file);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      report.skipped.push({ path: sourceRef, kind: "unreadable", reason: errText(err) });
      continue;
    }
    const { title, body } = splitFrontmatter(raw);
    if (!body.trim()) {
      report.skipped.push({ path: sourceRef, kind: "empty_body", reason: "empty body" });
      continue;
    }

    // Identity is (root, sourceRef), not sourceRef alone. Keyed on sourceRef
    // alone, two vaults that both hold `notes/index.md` collapsed into one
    // row: the first root's document id silently ended up holding the second
    // root's body and hash, so every citation pinned to that id then verified
    // against different content, both runs reporting success.
    const rows = db
      .prepare(
        `SELECT id, metadata_json FROM vector_document
         WHERE source_kind = 'vault_page' AND source_ref = ?`,
      )
      .all(sourceRef) as { id: string; metadata_json: string | null }[];

    let existingId: string | undefined;
    let legacyId: string | undefined;
    const otherRoots: string[] = [];
    for (const row of rows) {
      const rowRoot = readIngestRoot(row.metadata_json);
      if (rowRoot === root) {
        existingId = row.id;
        break;
      }
      if (rowRoot === null) legacyId ??= row.id;
      else otherRoots.push(rowRoot);
    }
    // Rows written before roots were recorded carry no root; adopt them rather
    // than duplicating the whole corpus on the first run after this change.
    if (existingId === undefined && legacyId !== undefined) existingId = legacyId;
    if (existingId === undefined && otherRoots.length > 0) {
      report.collisions.push({
        sourceRef,
        existingRoots: [...new Set(otherRoots)],
        incomingRoot: root,
      });
    }

    const doc = upsertDocument(db, {
      id: existingId,
      sourceKind: "vault_page",
      sourceRef,
      title: title ?? stripMarkdownExt(sourceRef),
      body,
      metadata: { ingestRoot: root },
    });
    report.ingested += 1;
    report.documentIds.push(doc.id);
  }

  return report;
}

// ─── CLI argument parsing ────────────────────────────────────────────────────

export interface ParsedIngestArgs {
  path: string;
  exclude: string[];
  includeDotted: boolean;
  allowUnmatchedExclude: boolean;
}

export type ParseIngestResult =
  | ({ ok: true } & ParsedIngestArgs)
  | { ok: false; error: string };

/**
 * Parse `chamber ingest` arguments.
 *
 * The previous parser took the first argument not starting with `--` as the
 * path and separately scanned for `--exclude`, so `--exclude`'s *value* was
 * never consumed by the positional scan:
 * `chamber ingest --exclude Private fakevault` picked `Private` as the target
 * and ingested the very folder it was told to exclude, at exit 0. Flags and
 * their values are consumed together here, so a flag value can never be
 * mistaken for the positional path.
 *
 * Unknown flags and extra positionals are rejected rather than ignored. A
 * silently-ignored flag on a privacy control (`--dry-run` did nothing) is how
 * an operator comes to believe they are protected when they are not; an extra
 * positional is usually an unquoted multi-word folder name whose tail was
 * dropped.
 */
export function parseIngestArgs(argv: string[]): ParseIngestResult {
  const exclude: string[] = [];
  let path: string | undefined;
  let includeDotted = false;
  let allowUnmatchedExclude = false;
  let flagsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (!flagsEnded) {
      if (arg === "--") {
        flagsEnded = true;
        continue;
      }
      if (arg.startsWith("--exclude=")) {
        const value = arg.slice("--exclude=".length);
        if (value.trim() === "") {
          return { ok: false, error: `--exclude= requires a value` };
        }
        exclude.push(value);
        continue;
      }
      if (arg === "--exclude") {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("-")) {
          return {
            ok: false,
            error: `--exclude requires a value (use --exclude=<pattern> for a value starting with "-")`,
          };
        }
        exclude.push(value);
        i += 1;
        continue;
      }
      if (arg === "--include-dotted") {
        includeDotted = true;
        continue;
      }
      if (arg === "--allow-unmatched-exclude") {
        allowUnmatchedExclude = true;
        continue;
      }
      if (arg.startsWith("-")) {
        // Covers `-`, `-x` and `--anything` alike. An unquoted multi-word
        // pattern (`--exclude 06 - Private`) lands here on the bare `-`,
        // which is exactly the loud failure that case needs.
        return { ok: false, error: `unknown flag: ${arg}` };
      }
    }

    if (path !== undefined) {
      return {
        ok: false,
        error: `unexpected extra argument ${JSON.stringify(arg)} (quote multi-word paths and patterns)`,
      };
    }
    path = arg;
  }

  if (path === undefined || path.trim() === "") {
    return { ok: false, error: `missing <path>` };
  }
  return { ok: true, path, exclude, includeDotted, allowUnmatchedExclude };
}
