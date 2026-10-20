# Declared-notes check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `chamber_check` judges an absolute path from the file on disk when that file sits in a folder a person declared, without ingesting it and without creating a database.

**Architecture:** `src/ingest.ts` exports the per-entry decision `walk` already makes, and a path walk that reuses it. `src/declared_folders.ts` parses `--notes` / `--exclude` and merges those folders with config roots and with `ingestRoot` values already stored on rows. `src/check.ts` judges absolute paths from disk through that walker, and leaves passage refs on the index. `src/mcp_server.ts` parses argv before it speaks JSON-RPC and does not open a missing database for an absolute-path-only call.

**Tech Stack:** TypeScript run directly by Node (`--experimental-strip-types`), `node:sqlite`, the existing harness in `tests/harness.ts`, probes as standalone scripts.

## Global Constraints

- `engines` stays `>=23.6`. Do not lower it.
- No new runtime dependency.
- Dotted entries stay excluded on this command. There is no `--include-dotted`.
- Config roots that overlap each other still throw from `loadConfig`. This plan does not relax that.
- `record: true` writes only a `SUPPORTED` claim whose judged text equals an index row and whose file on disk still matches that row. The refusal line is exactly `not recorded: the index does not hold this text`.
- An absolute-path-only call does not create a database file that does not already exist.
- `STALE` stays in the status union and is not returned for an edited file, a missing file, or a file the folder rules refuse.
- `chamber_ask`, `chamber_verify`, and `chamber_corpus` still open the database on first use.
- Problem lines, verbatim: `not indexed yet`, `index is behind this file`, `file on disk has changed since this passage was indexed`, `no notes folder declared — chamber mcp --notes <folder>`, `--exclude matched nothing: "<pattern>" — nothing in this folder was checked`.
- `NOT_FOUND`'s summary line becomes `not judged — a cited source could not be read`.
- The working directory is not a declared folder.

---

### Task 1: Share the walk's per-entry decision

**Files:**
- Modify: `src/ingest.ts` (the `walk` loop, around lines 427–576)
- Modify: `tests/harness.ts` (import, and a new test next to the ingest walk tests)
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `WalkContext`, `IngestSkip`, `normalizeExclude`, `matchExclude`, `MARKDOWN_EXTENSIONS`, `contained`, `relPosix`
- Produces:

```typescript
export interface EntryDecision {
  action: "skip" | "descend" | "file";
  skip?: IngestSkip;
}

export function classifyEntry(ctx: WalkContext, dir: string, entry: string): EntryDecision;

export function pathRefusal(
  rootInput: string,
  exclude: readonly string[],
  absPath: string,
): IngestSkip | null;

export function countExcludeMatches(
  rootInput: string,
  exclude: readonly string[],
): { raw: string; matched: number }[];
```

`pathRefusal` returns `null` when every entry from the root down to the file is allowed and the leaf is a markdown file. `countExcludeMatches` walks names only. Both pass `includeDotted: false`.

- [ ] **Step 1: Write the failing test**

Add this test in `tests/harness.ts` after the imports gain `classifyEntry`, `pathRefusal`, and `countExcludeMatches` from `../src/ingest.ts`. The import will fail typecheck until Step 3; the test is what has to go red first, so add the import and the test together and run it.

```typescript
test("pins", "check: the path walk and the ingest walk classify the same entries", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chamber-classify-")));
  try {
    mkdirSync(join(root, "notes"));
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "notes", "ok.md"), "The audit store is SQLite.\n");
    writeFileSync(join(root, ".hidden", "s.md"), "The audit store is SQLite.\n");
    writeFileSync(join(root, "data.json"), "{}\n");
    symlinkSync(join(root, ".hidden", "s.md"), join(root, "notes", "dotted.md"));
    symlinkSync(join(root, "data.json"), join(root, "notes", "via.md"));
    const outside = join(root, "..", `${basename(root)}-out.md`);
    writeFileSync(outside, "The audit store is SQLite.\n");
    symlinkSync(outside, join(root, "notes", "leave.md"));
    const fifo = spawnSync("mkfifo", [join(root, "notes", "pipe.md")]);
    assert(fifo.status === 0, `mkfifo failed: ${fifo.stderr}`);
    mkdirSync(join(root, "Private"));
    writeFileSync(join(root, "Private", "secret.md"), "The audit store is SQLite.\n");

    const planted = [
      join(root, "notes", "ok.md"),
      join(root, "notes", "dotted.md"),
      join(root, "notes", "via.md"),
      join(root, "notes", "leave.md"),
      join(root, "notes", "pipe.md"),
      join(root, "Private", "secret.md"),
    ];
    for (const abs of planted) {
      const refused = pathRefusal(root, ["Private"], abs);
      const ingested = ingestDirectory(freshDb(), root, { exclude: ["Private"] });
      const rel = relative(root, abs).split(sep).join("/");
      const skipped = ingested.skipped.find((s) => s.path === rel);
      if (abs.endsWith("ok.md")) {
        assert(refused === null, `ok.md must be readable: ${JSON.stringify(refused)}`);
        assert(skipped === undefined, `ok.md must be ingested: ${JSON.stringify(ingested.skipped)}`);
      } else {
        assert(refused !== null && skipped !== undefined, `${rel} must be refused by both`);
        assert(refused!.kind === skipped!.kind && refused!.reason === skipped!.reason, `${rel}: walk ${JSON.stringify(skipped)} path ${JSON.stringify(refused)}`);
      }
    }
    const counts = countExcludeMatches(root, ["Private", "no-such"]);
    assert(counts.find((c) => c.raw === "Private")!.matched > 0, JSON.stringify(counts));
    assert(counts.find((c) => c.raw === "no-such")!.matched === 0, JSON.stringify(counts));
    rmSync(outside);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: FAIL. `classifyEntry` (or `pathRefusal`) is not exported, so the harness exits non-zero before the suite summary.

- [ ] **Step 3: Move the loop body, do not rewrite it**

In `src/ingest.ts`, cut the body of the `for (const entry of entries)` loop inside `walk` (from the dotted-name check through the markdown-extension check) into `classifyEntry`. Every `ctx.skipped.push(skip); continue;` becomes `return { action: "skip", skip };`. A directory that is visited and recursed becomes `return { action: "descend" }` after the cycle check updates `ctx.visited` the way it does now. An accepted markdown file becomes `return { action: "file" }`. The reason strings stay byte-for-byte, including:

- `dotted entry (pass --include-dotted to ingest it)`
- `excluded by --exclude ${hit.raw}`
- `symlink escapes the ingest root (points at ${realFull})`
- `symlink target is a dotted entry (pass --include-dotted to ingest it)`
- `symlink target excluded by --exclude ${targetHit.raw}`
- `directory already visited (symlink cycle or duplicate link)`
- `not a regular file`
- `unsupported extension ${ext || "(none)"} (ingesting ${MARKDOWN_EXTENSIONS.join(", ")})`

`walk` becomes:

```typescript
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
    const decision = classifyEntry(ctx, dir, entry);
    if (decision.action === "skip") {
      ctx.skipped.push(decision.skip!);
      continue;
    }
    if (decision.action === "descend") {
      walk(ctx, join(dir, entry));
      continue;
    }
    ctx.files.push(join(dir, entry));
  }
}
```

`pathRefusal` resolves the root with the same helper `ingestDirectory` uses, rejects a path whose `relative(root, absPath)` escapes, then calls `classifyEntry` on each segment. A `skip` is returned as-is. The leaf must be `file`. Do not `realpath` the leaf before classifying it: a symlink has to be seen as a symlink. `countExcludeMatches` builds a `WalkContext` with `includeDotted: false`, calls `walk`, and returns each pattern's `raw` and `matched`. It does not read file bodies and does not call `ingestDirectory`.

Export `WalkContext`'s fields only as far as `classifyEntry` needs them. Keep `walk` itself unexported.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: PASS. The new test is green and no existing ingest test changed result.

- [ ] **Step 5: Commit**

```bash
git add src/ingest.ts tests/harness.ts
git commit -m "$(cat <<'EOF'
feat: share the ingest walk's per-entry decision with the check

EOF
)"
```

---

### Task 2: Parse declared folders

**Files:**
- Create: `src/declared_folders.ts`
- Modify: `tests/harness.ts`
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces:

```typescript
export interface DeclaredFolder {
  /** Absolute path, ~ expanded, realpath when the directory resolves. */
  root: string;
  exclude: string[];
}

export function parseNotesArgs(
  argv: readonly string[],
): { ok: true; folders: DeclaredFolder[] } | { ok: false; error: string };

export function mergeDeclaredFolders(folders: readonly DeclaredFolder[]): DeclaredFolder[];
```

`parseNotesArgs` ignores a leading `mcp` argument so both `chamber mcp --notes …` and `node src/mcp_server.ts --notes …` parse the same. `--exclude` binds to the `--notes` immediately before it. The same resolved path twice unions its excludes. Nested paths are kept as separate folders.

- [ ] **Step 1: Write the failing test**

```typescript
test("pins", "check: --notes binds the excludes that follow it", () => {
  const bad = parseNotesArgs(["--exclude", "transcripts"]);
  assert(!bad.ok && bad.error.includes("--exclude"), JSON.stringify(bad));
  const unknown = parseNotesArgs(["--notes", "/tmp/v", "--include-dotted"]);
  assert(!unknown.ok && unknown.error.includes("--include-dotted"), JSON.stringify(unknown));
  const missing = parseNotesArgs(["--notes"]);
  assert(!missing.ok, JSON.stringify(missing));
  const ok = parseNotesArgs([
    "mcp",
    "--notes", "~/Vault",
    "--exclude", "transcripts",
    "--notes", "~/Vault/research",
    "--exclude", "raw",
  ]);
  assert(ok.ok, JSON.stringify(ok));
  if (!ok.ok) return;
  assert(ok.folders.length === 2, JSON.stringify(ok.folders));
  assert(ok.folders[0]!.exclude.join() === "transcripts", JSON.stringify(ok.folders[0]));
  assert(ok.folders[1]!.exclude.join() === "raw", JSON.stringify(ok.folders[1]));
  assert(!ok.folders[0]!.root.includes("~"), ok.folders[0]!.root);
  const twice = parseNotesArgs(["--notes", "/tmp/v", "--exclude", "a", "--notes", "/tmp/v", "--exclude", "b"]);
  assert(twice.ok, JSON.stringify(twice));
  if (!twice.ok) return;
  const merged = mergeDeclaredFolders(twice.folders);
  assert(merged.length === 1 && merged[0]!.exclude.slice().sort().join() === "a,b", JSON.stringify(merged));
});
```

Import `parseNotesArgs` and `mergeDeclaredFolders` from `../src/declared_folders.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement the parser**

```typescript
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface DeclaredFolder {
  root: string;
  exclude: string[];
}

function expand(p: string): string {
  const full = p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p;
  const abs = isAbsolute(full) ? full : resolve(full);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

export function parseNotesArgs(
  argv: readonly string[],
): { ok: true; folders: DeclaredFolder[] } | { ok: false; error: string } {
  const args = argv[0] === "mcp" ? argv.slice(1) : argv;
  const folders: DeclaredFolder[] = [];
  let current: DeclaredFolder | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--notes") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, error: "--notes requires a path" };
      }
      current = { root: expand(value), exclude: [] };
      folders.push(current);
      i += 1;
      continue;
    }
    if (arg === "--exclude" || arg.startsWith("--exclude=")) {
      if (!current) return { ok: false, error: "--exclude before any --notes" };
      const value = arg.startsWith("--exclude=") ? arg.slice("--exclude=".length) : args[i + 1];
      if (value === undefined || value === "" || (!arg.startsWith("--exclude=") && value.startsWith("-"))) {
        return { ok: false, error: "--exclude requires a value" };
      }
      current.exclude.push(value);
      if (!arg.startsWith("--exclude=")) i += 1;
      continue;
    }
    if (arg.startsWith("-")) return { ok: false, error: `unknown flag: ${arg}` };
    return { ok: false, error: `unexpected argument ${JSON.stringify(arg)}` };
  }
  return { ok: true, folders: mergeDeclaredFolders(folders) };
}

export function mergeDeclaredFolders(folders: readonly DeclaredFolder[]): DeclaredFolder[] {
  const byRoot = new Map<string, DeclaredFolder>();
  for (const folder of folders) {
    const key = folder.root;
    const existing = byRoot.get(key);
    if (!existing) {
      byRoot.set(key, { root: folder.root, exclude: [...folder.exclude] });
      continue;
    }
    for (const pattern of folder.exclude) {
      if (!existing.exclude.includes(pattern)) existing.exclude.push(pattern);
    }
  }
  return [...byRoot.values()];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/declared_folders.ts tests/harness.ts
git commit -m "$(cat <<'EOF'
feat: parse --notes folders and the excludes that follow them

EOF
)"
```

---

### Task 3: Judge an unindexed absolute path from disk

**Files:**
- Modify: `src/check.ts` (`checkClaims`, `formatCheck`, `EXPLAIN`)
- Modify: `tests/harness.ts`
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `pathRefusal` from Task 1, `DeclaredFolder` and `mergeDeclaredFolders` from Task 2, `citedPassage`, `specificTerms`, `termsMissingIn`, `splitPassages`, `splitFrontmatter`
- Produces: `checkClaims(db, claims, opts)` gains `opts.folders?: readonly DeclaredFolder[]`. Existing callers keep working. A database's distinct `ingestRoot` values are merged in as folders with no excludes. The displayed ref for a disk reading is `<path relative to the outermost containing folder>#pN`.

- [ ] **Step 1: Write the failing test**

```typescript
test("pins", "check: an unindexed note in a declared folder is judged from disk", () => {
  const db = freshDb();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chamber-check-disk-")));
  try {
    mkdirSync(join(dir, "notes"));
    const note = join(dir, "notes", "gpu.md");
    writeFileSync(note, "# GPU\n\nOne NVIDIA A100 80GB can serve about 1,000 users.\n");
    const [r] = checkClaims(
      db,
      [{ text: "One NVIDIA A100 80GB can serve about 2,000 users.", sources: [note] }],
      { folders: [{ root: dir, exclude: [] }] },
    );
    assert(r!.status === "TERMS_ABSENT" && r!.missing.includes("2000"), JSON.stringify(r));
    assert(r!.problems.some((p) => p === "not indexed yet"), JSON.stringify(r!.problems));
    assert(r!.checkedRefs.some((ref) => ref === "notes/gpu.md#p0"), JSON.stringify(r!.checkedRefs));
    const text = formatCheck([r!], false);
    assert(text.includes("not judged — a cited source could not be read") === false, text);
    const none = checkClaims(db, [{ text: "One NVIDIA A100 serves 1,000 users.", sources: [note] }]);
    assert(none[0]!.status === "NOT_FOUND" && none[0]!.problems.some((p) => p.includes("no notes folder declared — chamber mcp --notes <folder>")), JSON.stringify(none[0]));
    assert(formatCheck(none, false).includes("not judged — a cited source could not be read"), formatCheck(none, false));
    const mixed = checkClaims(
      db,
      [{ text: "One NVIDIA A100 80GB can serve about 1,000 users.", sources: [note, join(dir, "..", "outside.md")] }],
      { folders: [{ root: dir, exclude: [] }] },
    );
    assert(mixed[0]!.status === "NOT_FOUND" && mixed[0]!.status !== "SUPPORTED", JSON.stringify(mixed[0]));
    writeFileSync(join(dir, "notes", "empty.md"), "");
    const empty = checkClaims(
      db,
      [{ text: "One NVIDIA A100 serves 1,000 users.", sources: [join(dir, "notes", "empty.md")] }],
      { folders: [{ root: dir, exclude: [] }] },
    );
    assert(empty[0]!.status === "NOT_FOUND" && empty[0]!.problems.some((p) => p.includes("empty")), JSON.stringify(empty[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: FAIL. The unindexed absolute path is `NOT_FOUND` (`not under any ingest root`), and `opts.folders` is ignored.

- [ ] **Step 3: Implement the disk reading**

In `checkClaims`, build the folder list once:

```typescript
const rowRoots = db
  ? (db.prepare(
      `SELECT DISTINCT json_extract(metadata_json, '$.ingestRoot') AS root
       FROM vector_document WHERE source_kind = 'vault_page' AND root IS NOT NULL`,
    ).all() as { root: unknown }[])
      .map((r) => r.root)
      .filter((r): r is string => typeof r === "string")
      .map((root) => ({ root, exclude: [] as string[] }))
  : [];
const folders = mergeDeclaredFolders([...(opts.folders ?? []), ...rowRoots]);
```

`json_extract` alias `root` in the WHERE clause is wrong on SQLite. Filter in JS instead:

```typescript
const rowRoots = db
  ? (db.prepare(
      `SELECT DISTINCT json_extract(metadata_json, '$.ingestRoot') AS root
       FROM vector_document WHERE source_kind = 'vault_page'`,
    ).all() as { root: unknown }[])
      .flatMap((r) => (typeof r.root === "string" ? [{ root: r.root, exclude: [] as string[] }] : []))
  : [];
```

For each absolute source, find every folder whose `relative(folder.root, path)` does not escape. No folder means `NOT_FOUND` and problem `no notes folder declared — chamber mcp --notes <folder>` when `folders.length === 0`, otherwise the path-refusal reason from the nearest folder, or `not under any declared folder` when no folder contains it. Every containing folder must return `pathRefusal(...) === null`. The first refusal wins and the file is not opened.

When all containing folders allow it, open the resolved target the way `readAndCompare` does (`realpath` of a path the classifier already allowed, then `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, regular file, inode re-check, 32 MB). Split with `splitFrontmatter` and `splitPassages`. Zero passages is `NOT_FOUND` and the problem contains `empty body`, the reason ingest already uses. Judge a non-empty split with `specificTerms(text, { openings: true })` and `termsMissingIn` over `citedPassage` of those passages. Set `checkedRefs` to `<relative to the outermost containing folder>#pN`. Append problem `not indexed yet` when no index row's real path is this file (`Index.sameFile`). Do not call `embedLocal`, `ingestDirectory`, or `upsertDocument`.

Change `EXPLAIN.NOT_FOUND` to `not judged — a cited source could not be read`.

One refused source among several makes the whole claim `NOT_FOUND` with every problem listed. Do not judge the sources that resolved.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: PASS. The pre-existing `check: an agent's claims are judged against the note it cites` stays green, because its fixture was ingested and the row root now counts as a declared folder.

- [ ] **Step 5: Commit**

```bash
git add src/check.ts tests/harness.ts
git commit -m "$(cat <<'EOF'
feat: judge an unindexed note from disk when its folder was declared

EOF
)"
```

---

### Task 4: Index, record, passage refs, and the tests that change

**Files:**
- Modify: `src/check.ts`
- Modify: `tests/harness.ts` (the tests named below, plus one new test)
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: Task 3's disk reading and `Index.sameFile`
- Produces: the verdict table in the spec. `record: true` on a `SUPPORTED` disk reading whose index row is missing or behind sets `problems` to include `not recorded: the index does not hold this text` and does not call `enforceClaimContract`.

- [ ] **Step 1: Rewrite the assertions the spec names, and add the passage-ref case**

In `check: a note edited or deleted since ingest is not judged`:

- Rename it to `check: an edited note is judged from disk, a deleted path is not`.
- After the edit, assert `Postgres` is `SUPPORTED`, `SQLite` is `TERMS_ABSENT`, and both problems include `index is behind this file`. Assert neither status is `STALE`.
- Keep the re-ingest assertions (`SUPPORTED` then `TERMS_ABSENT`).
- The new file under the ingested root is judged from its own text, with problem `not indexed yet`, not `NOT_FOUND`. Assert it with:

```typescript
writeFileSync(join(dir, "notes", "new.md"), "The audit store is SQLite.\n");
const added = checkClaims(db, [{ text: "The audit store is SQLite.", sources: [join(dir, "notes", "new.md")] }])[0]!;
assert(added.status === "SUPPORTED" && added.problems.some((p) => p === "not indexed yet"), JSON.stringify(added));
const rel = checkClaims(db, [{ text: "The audit store is Postgres.", sources: ["notes/ops.md"] }])[0]!;
assert(rel.status === "SUPPORTED" && rel.problems.some((p) => p === "index is behind this file"), JSON.stringify(rel));
```

- The deleted absolute path stays unjudged, status `NOT_FOUND`, problem still containing `chamber prune`.

Add:

```typescript
test("pins", "check: a passage ref stays on the index when the file changes", () => {
  const { db, dir, note } = checkFixture();
  try {
    const ref = (db.prepare(
      "SELECT source_ref FROM vector_document WHERE source_ref LIKE '%ops.md#p%'",
    ).get() as { source_ref: string }).source_ref;
    writeFileSync(note, "# Ops\n\nThe audit store is Postgres, chosen in 2025.\n");
    const [fromRef] = checkClaims(db, [{ text: "The audit store is SQLite.", sources: [ref] }]);
    assert(fromRef!.status === "SUPPORTED", JSON.stringify(fromRef));
    assert(
      fromRef!.problems.some((p) => p === "file on disk has changed since this passage was indexed"),
      JSON.stringify(fromRef!.problems),
    );
    const [recorded] = checkClaims(
      db,
      [{ text: "The audit store is SQLite.", sources: [note] }],
      { record: true },
    );
    assert(recorded!.status === "TERMS_ABSENT", JSON.stringify(recorded));
    const [supportedOld] = checkClaims(
      db,
      [{ text: "The audit store is SQLite.", sources: [ref] }],
      { record: true },
    );
    assert(supportedOld!.recorded === undefined, JSON.stringify(supportedOld));
    assert(
      supportedOld!.problems.some((p) => p === "not recorded: the index does not hold this text"),
      JSON.stringify(supportedOld!.problems),
    );
    const beliefs = (db.prepare("SELECT count(*) AS n FROM belief").get() as { n: number }).n;
    assert(beliefs === 0, `record must not write when disk and index disagree: ${beliefs}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

In `check: files that are not plain notes are never read`, `check: a linked note inside the root…` (the excluded-target and `.env` loop), and the symlink-escape block of `check: review findings on chamber_check stay closed`: keep the reason substrings (`did not index`, `regular file`, `outside`) and the five-second FIFO bound. Change the expected status from `STALE` to `NOT_FOUND`.

In `check: letter case is free; a note under a linked folder fails closed`: both `alink/x.md` and `real/x.md` are judged `SUPPORTED` from disk. The case-insensitive assertion stays `SUPPORTED`. A link that leaves the root is still not read.

Do not change `check: a nested root that excluded a note does not hide the outer root's copy`. It stays `SUPPORTED`.

Add a relative-path assertion to the edited-note test: `notes/ops.md` after the edit has the same status as the absolute path, and `notes/ops.md` while two roots hold that relative path stays `NOT_FOUND` with `held by 2 ingest roots` (that assertion already exists in `check: a note is judged in its own vault`; leave it).

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: FAIL. The edited note is still `STALE`. The passage-ref test fails the same way.

- [ ] **Step 3: Implement the index comparison**

When the disk text was read and `sameFile` finds a row:

- Re-split the disk text and compare passage bodies to that root's indexed passages, the same comparison `staleness` already makes.
- Equal: judge the disk text and do not append `index is behind this file`. `record: true` uses today's `cover` and `enforceClaimContract` on those index rows.
- Different: judge the disk text, append `index is behind this file`. `record: true` on `SUPPORTED` appends `not recorded: the index does not hold this text` and does not call `enforceClaimContract`.

A `file.md#pN` or passage id keeps today's `resolveSource`, except a stale freshness result no longer forces status `STALE`. Judge the indexed row, append `file on disk has changed since this passage was indexed`, and refuse `record` the same way. A row with no ingest root stays `NOT_FOUND` with today's problem line.

A relative path that `resolveSource` maps to exactly one file is then judged as that file's absolute path. Zero matches stays `NOT_FOUND`. Two roots stays `NOT_FOUND` with `held by 2 ingest roots` and nothing is read.

An absolute path whose file is gone, larger than `MAX_COMPARE_BYTES`, or empty after `splitFrontmatter` is `NOT_FOUND`. When an index row exists for a missing file, the problem still contains `chamber prune`. Do not substitute the indexed body.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: PASS. No assertion in this suite still requires `STALE` for an edited note or a refused file. `rg -n 'status === "STALE"' tests/harness.ts` returns no check-test hits. If a hit remains, it is a test this task missed; update it to the spec's status before committing.

- [ ] **Step 5: Commit**

```bash
git add src/check.ts tests/harness.ts
git commit -m "$(cat <<'EOF'
feat: judge the file the agent read, and refuse to pin a row the disk no longer matches

EOF
)"
```

---

### Task 5: One poisoned folder does not silence another

**Files:**
- Modify: `src/check.ts`
- Modify: `tests/harness.ts`
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `countExcludeMatches` from Task 1, `DeclaredFolder` from Task 2
- Produces: a folder whose exclude matches nothing contributes only `NOT_FOUND` claims, with problem `--exclude matched nothing: "<pattern>" — nothing in this folder was checked`. A second folder is unaffected. The count runs once per `checkClaims` call, and only for folders that have a pattern.

- [ ] **Step 1: Write the failing test**

```typescript
test("pins", "check: an exclude that matches nothing poisons only that folder", () => {
  const db = freshDb();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "chamber-check-poison-")));
  try {
    const a = join(base, "a");
    const b = join(base, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "n.md"), "The audit store is SQLite.\n");
    writeFileSync(join(b, "n.md"), "The audit store is SQLite.\n");
    const folders = [
      { root: a, exclude: ["no-such"] },
      { root: b, exclude: [] },
    ];
    const [bad, good] = checkClaims(
      db,
      [
        { text: "The audit store is SQLite.", sources: [join(a, "n.md")] },
        { text: "The audit store is SQLite.", sources: [join(b, "n.md")] },
      ],
      { folders },
    );
    assert(bad!.status === "NOT_FOUND", JSON.stringify(bad));
    assert(
      bad!.problems.some((p) => p === '--exclude matched nothing: "no-such" — nothing in this folder was checked'),
      JSON.stringify(bad!.problems),
    );
    assert(good!.status === "SUPPORTED", JSON.stringify(good));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: FAIL. Both notes are `SUPPORTED`, because `no-such` is never counted.

- [ ] **Step 3: Count matches before judging**

At the start of `checkClaims`, after the folder list is built:

```typescript
const poisoned = new Map<string, string>();
for (const folder of folders) {
  if (folder.exclude.length === 0) continue;
  for (const count of countExcludeMatches(folder.root, folder.exclude)) {
    if (count.matched === 0) {
      poisoned.set(
        folder.root,
        `--exclude matched nothing: ${JSON.stringify(count.raw)} — nothing in this folder was checked`,
      );
      break;
    }
  }
}
```

If any containing folder is in `poisoned`, the absolute path is `NOT_FOUND` with that problem and the file is not opened. Cache the result on a module-level `Map` keyed by `${root}\0${exclude.join("\0")}`. The same folder list is not walked again in this process. A changed list, including a config edit the server re-reads on the next call, is a new key and is walked. An unchanged typo stays poisoned without a second walk.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/check.ts tests/harness.ts
git commit -m "$(cat <<'EOF'
feat: an exclude that matches nothing refuses that folder only

EOF
)"
```

---

### Task 6: The server, the missing database, and the probe

**Files:**
- Modify: `src/mcp_server.ts` (argv at startup, `INSTRUCTIONS`, the `chamber_check` tool description, the `chamber_check` case)
- Modify: `package.json` (the `probes` script)
- Create: `probes/check_declared_notes.ts`
- Modify: `tests/harness.ts` (the MCP instructions assertion, only if the new sentence is required there)
- Test: `probes/check_declared_notes.ts`

**Interfaces:**
- Consumes: `parseNotesArgs` from Task 2, `checkClaims` from Tasks 3–5, `loadConfig` from `src/config.ts`
- Produces: a server that exits 1 on a bad flag before writing JSON, and a probe in `npm run probes`.

- [ ] **Step 1: Write the failing probe**

```typescript
/**
 * PROBE: the README's install, plus a notes folder, judges a file that was
 * never ingested, and does not create a database to do it.
 *
 * Exits non-zero while an empty database still returns NOT_FOUND, or while
 * the call creates the database file.
 *
 *   node --experimental-strip-types probes/check_declared_notes.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "chamber-probe-notes-"));
const db = join(root, "missing.sqlite");
const note = join(root, "gpu.md");
let failed = false;
function fail(msg: string): void {
  failed = true;
  console.error(msg);
}
try {
  mkdirSync(root, { recursive: true });
  writeFileSync(note, "# GPU\n\nOne NVIDIA A100 80GB can serve about 1,000 users.\n");
  const server = fileURLToPath(new URL("../src/mcp_server.ts", import.meta.url));
  const claim = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "chamber_check",
      arguments: {
        claims: [{
          text: "One NVIDIA A100 80GB can serve about 2,000 users.",
          sources: [note],
        }],
      },
    },
  };
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify(claim),
  ].join("\n") + "\n";
  const run = spawnSync(process.execPath, ["--experimental-strip-types", server, "--notes", root], {
    input,
    encoding: "utf8",
    env: { ...process.env, CHAMBER_DB: db, CHAMBER_CONFIG: join(root, "no-config.json") },
    timeout: 30_000,
  });
  const line = (run.stdout || "").split("\n").find((l) => l.includes('"id":2')) ?? "";
  if (!line.includes("TERMS_ABSENT") || !line.includes("2000")) fail(`verdict missing:\n${run.stdout}\n${run.stderr}`);
  if (existsSync(db)) fail(`database was created at ${db}`);
  const bad = spawnSync(process.execPath, ["--experimental-strip-types", server, "--not-a-flag"], {
    input,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (bad.status !== 1) fail(`bad flag exited ${bad.status}`);
  if ((bad.stdout || "").trim().startsWith("{")) fail(`bad flag wrote JSON: ${bad.stdout}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("probe ok");
```

Add `node --experimental-strip-types probes/check_declared_notes.ts || rc=1;` to the `probes` script in `package.json`, next to `probes/claim_support.ts`.

- [ ] **Step 2: Run the probe to verify it fails**

Run: `node --experimental-strip-types probes/check_declared_notes.ts`

Expected: FAIL. The server ignores `--notes`, returns `NOT_FOUND`, and `existsSync(db)` is true because `getDb` created it. The bad-flag process exits 0 and writes JSON.

- [ ] **Step 3: Wire the server**

At the top of `src/mcp_server.ts`, after the imports and before any stdin listener:

```typescript
const notes = parseNotesArgs(process.argv.slice(2));
if (!notes.ok) {
  console.error(notes.error);
  process.exit(1);
}
```

In the `chamber_check` case, replace `checkClaims(getDb(false), claims, { record })` with a call that:

- loads config inside the existing try/catch
- merges `notes.folders` with `config.ingest` mapped to `{ root, exclude }`
- opens the database only when `existsSync(config.database)` is true, or when a source is not an absolute path (a passage ref or a relative path needs the index, and opening may create the file, which is today's `openChamberDb` behavior)
- passes `db` as `null` when the file does not exist and every source is absolute
- passes the merged folders

Replace the `chamber_check` tool description's sentence that the note must be indexed and unchanged with: the check reads notes from folders declared with `--notes` or the config's ingest roots; an absolute path is the file on disk; a passage ref is the indexed text; `SUPPORTED` means the recognised terms occur in the judged text and a negated or reversed sentence built from the note's own words still passes.

Add those three facts to `INSTRUCTIONS` in the same words, keeping the existing sentence that lowercase names and ordinary words are not checked.

- [ ] **Step 4: Run the probe and the pins suite**

Run: `node --experimental-strip-types probes/check_declared_notes.ts`

Expected: `probe ok` and exit 0.

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: PASS. The MCP test `chamber_check over MCP` still finds `chamber_check` in `instructions`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp_server.ts probes/check_declared_notes.ts package.json tests/harness.ts
git commit -m "$(cat <<'EOF'
feat: chamber_check reads a --notes folder without creating a database

EOF
)"
```

---

### Task 7: Docs say what the check does now

**Files:**
- Modify: `README.md` (lines 22, 214–215, and 259–261)
- Modify: `docs/KNOWN_LIMITATIONS.md` (the `chamber_check` bullet that starts near line 225)
- Test: the pins suite and the probe, already written

**Interfaces:**
- Consumes: the behavior from Tasks 3–6
- Produces: a README whose install line declares a folder, and an honesty bullet that no longer describes a `STALE` refusal the code does not make

- [ ] **Step 1: Confirm the sentences that would now be false**

Run:

```bash
rg -n "STALE|chamber mcp" README.md docs/KNOWN_LIMITATIONS.md
```

Expected: README line 22 is the install line without `--notes`. README line 215 says a symlinked folder comes back `STALE` under the real path. README lines 259–261 say an edited note is `STALE` and not judged. `KNOWN_LIMITATIONS.md` says the real path of a note inside a symlinked folder comes back `STALE` because following it would mean re-deriving the walk's rules.

- [ ] **Step 2: Rewrite those sentences**

Install line:

```bash
claude mcp add -s user chamber -- npx -y @bu7umaid/chamber mcp --notes ~/Notes
```

Under it, add a Cursor block:

```json
{
  "mcpServers": {
    "chamber": {
      "command": "npx",
      "args": ["-y", "@bu7umaid/chamber", "mcp", "--notes", "/absolute/path/to/Notes"]
    }
  }
}
```

Replace the symlink sentence (line 215) with: a symlinked folder is indexed under the link path. The check reads the real path too, because it uses the same per-entry rules as ingest. A link that leaves the declared folder is not read.

Replace lines 259–261 with: the check reads the file on disk when the path is absolute and the file sits in a declared folder. An indexed note that has since changed is still judged, from the disk text, and the result adds `index is behind this file`. A passage ref is judged from the indexed text. `SUPPORTED` means the recognised terms occur in that text. It does not mean the sentence follows.

In `KNOWN_LIMITATIONS.md`, on the bullet that begins `` `chamber_check` reads a note only when its real path is that indexed note ``, add a dated correction: as of this change the check and the walk share one classifier, so the real path of a note inside a declared folder is judged from disk, and an edited file is no longer returned as `STALE`. A link that leaves the folder, a dotted entry, and an excluded entry are still not read.

Add one README line: the published package runs on Node 22 (measured 22.23.1, which prints Node's experimental-SQLite warning). Node 20.20.2 exits with `ERR_UNKNOWN_BUILTIN_MODULE` because `node:sqlite` is absent. Node 23.6 remains the floor for a checkout. Do not edit `engines`.

- [ ] **Step 3: Run the gates**

Run: `npm test && npm run typecheck && node --experimental-strip-types probes/check_declared_notes.ts`

Expected: the harness prints a passing tally, `tsc` prints nothing, the probe prints `probe ok`.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/KNOWN_LIMITATIONS.md
git commit -m "$(cat <<'EOF'
docs: the check reads a declared folder, and an edit is no longer STALE

EOF
)"
```
