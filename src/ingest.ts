/**
 * Markdown corpus ingest.
 *
 * sourceRef (the path relative to the ingest root) is the identity key, so
 * re-ingesting a file updates its row in place rather than creating a second
 * document with a second pin.
 */

import type { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { upsertDocument } from "./vector.ts";

export interface IngestReport {
  ingested: number;
  skipped: { path: string; reason: string }[];
  documentIds: string[];
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
 * fenced region is only accepted as frontmatter if its first non-blank line
 * looks like `key:`; otherwise the whole raw text is returned as body,
 * exactly as if there had been no leading `---` at all.
 *
 * Deliberately NOT handled (would need real YAML, not a heuristic): prose
 * whose first line coincidentally looks like `key:` right after a leading
 * `---` (e.g. "Note: as discussed...") still misparses as frontmatter — a
 * heuristic on shape alone cannot tell that apart from a real YAML key.
 * Frontmatter fields other than `title` (lists, nested maps, multi-line
 * block scalars) are not parsed at all; only `title` is ever extracted.
 */
export function splitFrontmatter(raw: string): {
  title?: string;
  body: string;
} {
  if (!raw.startsWith("---")) return { body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { body: raw };
  const front = raw.slice(3, end);

  const firstLine = front.split(/\r?\n/).find((l) => l.trim() !== "");
  if (!firstLine || !/^[A-Za-z_][\w-]*\s*:/.test(firstLine.trim())) {
    // Fenced region doesn't open with anything key-shaped — this was a
    // horizontal rule, not frontmatter. Don't consume it or anything up to
    // the next unrelated `---`.
    return { body: raw };
  }

  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const m = front.match(/^title:\s*(.+)$/m);
  return { title: m?.[1]?.trim().replace(/^["']|["']$/g, ""), body };
}

/**
 * Walk `dir`, collecting `.md` files, pruning any entry whose *basename*
 * exactly matches one of `exclude`.
 *
 * Matching is by whole path segment, not substring, and is checked only
 * against entries actually found while walking:
 *  - a nested match (e.g. `root/a/b/private/x.md` with `exclude: ["private"]`)
 *    is caught the moment `private` is read as an entry of `root/a/b`, and
 *    the whole subtree under it is pruned without ever being read — so
 *    exclusion applies at any depth, not just directly under `root`;
 *  - `"private"` does NOT match a sibling directory named `"private-notes"`
 *    or `"not-private"` — the comparison is `Set.has`, i.e. exact string
 *    equality on the entry name, never a substring test. A substring check
 *    on the accumulated path (e.g. `fullPath.includes(sep + name + sep)`)
 *    would be safe against those particular two examples too, because the
 *    separators anchor both sides — but it has a sharper failure mode: it
 *    tests the *entire accumulated path*, including everything above `dir`,
 *    so a name that matches somewhere in `root`'s own ancestry (outside the
 *    tree actually being walked) would exclude every single file with no
 *    diagnostic. Comparing only the current entry's basename can't do that,
 *    because it never looks above `dir`;
 *  - the ingest root itself is never checked against `exclude` — only
 *    entries discovered *while walking* are. `exclude` prunes subdirectories
 *    found under the root; it is not a second veto on the path the caller
 *    explicitly pointed ingestion at. Passing a root whose own basename
 *    happens to equal an exclude pattern (e.g. ingesting `.../private`
 *    directly with `exclude: ["private"]`) still ingests its contents.
 */
function walk(dir: string, exclude: Set<string>, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (exclude.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, exclude, out);
    } else if (entry.endsWith(".md")) {
      out.push(full);
    }
  }
}

export function ingestDirectory(
  db: DatabaseSync,
  root: string,
  opts: { exclude?: string[] } = {},
): IngestReport {
  const exclude = new Set(opts.exclude ?? []);
  const files: string[] = [];
  walk(root, exclude, files);

  const report: IngestReport = { ingested: 0, skipped: [], documentIds: [] };

  for (const file of files) {
    const sourceRef = relative(root, file);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      report.skipped.push({
        path: sourceRef,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const { title, body } = splitFrontmatter(raw);
    if (!body.trim()) {
      report.skipped.push({ path: sourceRef, reason: "empty body" });
      continue;
    }
    const existing = db
      .prepare(
        `SELECT id FROM vector_document WHERE source_kind = 'vault_page' AND source_ref = ?`,
      )
      .get(sourceRef) as { id: string } | undefined;

    const doc = upsertDocument(db, {
      id: existing?.id,
      sourceKind: "vault_page",
      sourceRef,
      title: title ?? sourceRef.replace(/\.md$/, ""),
      body,
    });
    report.ingested += 1;
    report.documentIds.push(doc.id);
  }

  return report;
}
