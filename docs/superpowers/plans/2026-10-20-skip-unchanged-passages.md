# Skip unchanged MiniLM passages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-ingesting a note does not call the embedder or rewrite a passage whose text is unchanged and whose vector is already MiniLM.

**Architecture:** `vaultPageHash` moves to a leaf module so ingest can call the same function `upsertDocument` uses without a cycle through `pins.ts`. `ingestDirectory` loads each row's hash, model, and section, keeps a row only when all three match what it would write, and sends only the other passages to the batch embedder. `writtenIds` includes the kept ids so the shrink sweep does not delete them.

**Tech Stack:** TypeScript run directly by Node (`--experimental-strip-types`), `node:sqlite`, the harness in `tests/harness.ts`. No new dependency.

## Global Constraints

- `engines` stays `>=23.6`. Do not lower it.
- No new runtime dependency. Tests pass `embedBatch` and do not need onnxruntime.
- The MiniLM model string is exactly `minilm-l6-v2-q`. The hash-vector string is exactly `local-hash-v1`. No prefix match.
- A skip requires an owned row for this root and this ref, `snapshot_hash` equal to `vaultPageHash` of the title, body, and ref about to be written, `vector_embedding.model` exactly `minilm-l6-v2-q`, and metadata `section` exactly equal to the section about to be written.
- The kept id goes into `writtenIds` and does not go into `documentIds`. `passages` counts rows written this call. `unchanged` counts rows kept.
- Vector `i` belongs to the `i`-th passage of the list sent to the embedder, not to `passages[i]` of the file. A short batch is discarded and treated as a throw. The per-passage fallback embeds that list only. `embedFallback` stays one message, the first failure's.
- When `unchanged` is 0 the CLI line stays `ingested N file(s) as M passage(s) from <path>`.
- Do not change what `snapshot_hash` covers. Do not skip on mtime. Do not add a skip list outside the index. Do not cap the batch or keep a Python process alive. Do not point the 08:30 job at a release.
- Do not edit `scripts/eval_retrieval.ts` or `deploy/SCHEDULING.md`. The first ingest still prints the line those files already show.
- Do not modify or stage `src/embedder.ts` or `scripts/embed_minilm.py`. Those working-tree edits are a different change.
- `pins.ts` imports `excludeMatcher` from `ingest.ts`. `ingest.ts` must not import `pins.ts`.
- `tests/harness.ts` contains a fixture a secret scanner rejects when an edit tool reads the whole file. Patch the regions this plan names. Do not print the file. Do not open the skill-secret fixture.
- Cut the branch from `main` before Task 1: `git switch -c feat/skip-unchanged-passages main`. Leave the embedder edits unstaged.
- Node on `PATH` must be `>=23.6`. `npm test` is `node --experimental-strip-types tests/harness.ts`.

---

### Task 1: One hash function

**Files:**
- Create: `src/vault_page_hash.ts`
- Modify: `src/pins.ts` (the private `vaultPageHash` around line 177, and its three call sites)
- Modify: `src/vector.ts` (`upsertDocument`, the inline `snapshot` around lines 208–210)
- Modify: `tests/harness.ts` (the `pins.ts` import, and a test immediately after the import block's first `pins` test — place the test next to the other `pins` tests, above the `reportingStarted = true` line)
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `sha256` from `src/hash.ts`
- Produces:

```typescript
export function vaultPageHash(row: {
  title: string | null;
  body: string;
  source_ref: string | null;
}): string;
```

Re-exported from `src/pins.ts`. `upsertDocument` stores this function's return value and no longer has its own copy of the formula.

- [ ] **Step 1: Write the failing test**

Add `vaultPageHash` to the existing import from `../src/pins.ts`.

Add this test next to the other `pins` tests, above `reportingStarted = true`:

```typescript
test("pins", "upsertDocument stores the hash vaultPageHash returns", () => {
  const db = freshDb();
  const body = "the body";
  const nullHash = vaultPageHash({ title: null, body, source_ref: "n.md#p0" });
  const emptyHash = vaultPageHash({ title: "", body, source_ref: "n.md#p1" });
  assert(nullHash !== emptyHash, "a null title and an empty title must hash differently");

  const injected = {
    embedding: new Float32Array(8),
    model: "test-hash",
  };
  const missing = upsertDocument(db, {
    sourceKind: "vault_page",
    sourceRef: "n.md#p0",
    body,
    ...injected,
  });
  const empty = upsertDocument(db, {
    sourceKind: "vault_page",
    sourceRef: "n.md#p1",
    title: "",
    body,
    ...injected,
  });
  const stored = (id: string): string =>
    (db.prepare(`SELECT snapshot_hash FROM vector_document WHERE id = ?`).get(id) as { snapshot_hash: string })
      .snapshot_hash;
  assert(stored(missing.id) === nullHash, "omitted title must store the null-title hash");
  assert(stored(empty.id) === emptyHash, "empty title must store the empty-title hash");
});
```

`UpsertDocumentInput.title` is `string | undefined`. Omitting it is the null title. Pass the embedding so this test does not spawn Python.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: the process fails while loading the harness, because `vaultPageHash` is not exported from `src/pins.ts`. Exit non-zero. No PASS line for this test.

- [ ] **Step 3: Move the function and call it from the upsert**

Create `src/vault_page_hash.ts`. Move the comment that currently sits above `function vaultPageHash` in `src/pins.ts` with it, unchanged. The function body is:

```typescript
import { sha256 } from "./hash.ts";

export function vaultPageHash(row: {
  title: string | null;
  body: string;
  source_ref: string | null;
}): string {
  return sha256(
    JSON.stringify([row.title ?? null, row.body, row.source_ref ?? null]),
  );
}
```

In `src/pins.ts`, delete the private function and add:

```typescript
import { vaultPageHash } from "./vault_page_hash.ts";
export { vaultPageHash };
```

The three existing call sites stay as they are.

In `src/vector.ts`, import `vaultPageHash` from `./vault_page_hash.ts`. Replace the inline `const snapshot = sha256(JSON.stringify(...))` in `upsertDocument` with:

```typescript
  // The only vault-page formula. A second copy re-embeds the corpus or skips
  // a passage whose text changed. src/vault_page_hash.ts says why null and ""
  // stay distinct.
  const snapshot = vaultPageHash({
    title: input.title ?? null,
    body,
    source_ref: input.sourceRef ?? null,
  });
```

Leave `sha256` imported if `stableDocumentId` still uses it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: `pins/upsertDocument stores the hash vaultPageHash returns` PASS, and the suite's failed count is 0.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/vault_page_hash.ts src/pins.ts src/vector.ts tests/harness.ts \
  docs/superpowers/specs/2026-10-20-skip-unchanged-passages-design.md \
  docs/superpowers/plans/2026-10-20-skip-unchanged-passages.md
git commit -m "$(cat <<'EOF'
feat: one function computes the vault page hash

A second copy of the formula would re-embed the corpus or skip a passage whose text changed.
EOF
)"
```

Do not stage `src/embedder.ts` or `scripts/embed_minilm.py`.

---

### Task 2: Keep an unchanged MiniLM passage

**Files:**
- Modify: `src/ingest.ts` (`IngestReport` around lines 82–135, both report literals around lines 797 and 839, `ExistingRow` and its query around lines 871–893, the batch and write loop around lines 1008–1077, `readIngestRoot` around line 754)
- Modify: `tests/harness.ts` (the idempotence test "re-ingesting an unchanged file is a genuine no-op" around line 5046, and the new tests directly after it)
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `vaultPageHash` from Task 1; `MINILM_MODEL` from `src/embedder.ts`; `passageTitle`, `passageSourceRef`, `splitPassages`; `upsertDocument`; `resetMinilmProbe` and `MINILM_MODEL` already imported by the harness
- Produces: `IngestReport.unchanged: number`. A kept passage is not passed to `upsertDocument`. Its id is in `writtenIds` and not in `documentIds`.

- [ ] **Step 1: Write the failing tests**

In the test "re-ingesting an unchanged file is a genuine no-op — same ids, same hashes, same row count", delete the assertion that `first.documentIds` equals `second.documentIds`. Replace it with:

```typescript
    assert(
      second.unchanged + second.passages === first.passages,
      `re-ingest lost passages: wrote ${second.passages}, kept ${second.unchanged}, had ${first.passages}`,
    );
```

Leave the snapshot assertion and `second.removed === 0`. Under MiniLM the second report's `documentIds` is empty because nothing was written, and that is this task's success. The snapshot is what proves the ids did not rotate.

Add the following directly after that test. `MINILM_MODEL` and `resetMinilmProbe` are already imported in this file.

```typescript
const THREE_PASSAGES =
  "# Note\n\nalpha body one\n\n## Two\n\nbeta body two\n\n## Three\n\ngamma body three\n";

function minilmVectors(texts: readonly string[]) {
  return texts.map(() => ({
    vector: new Float32Array(8).fill(0.25),
    model: MINILM_MODEL,
    dims: 8,
    kind: "hash" as const,
  }));
}

function plantUpdatedAt(db: ReturnType<typeof freshDb>): void {
  db.prepare(
    `UPDATE vector_document SET updated_at = '2000-01-01T00:00:00.000Z'`,
  ).run();
}

test("pins", "a second ingest of an unchanged MiniLM file calls no embedder", () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "chamber-skip-same-"));
  writeFileSync(join(dir, "note.md"), THREE_PASSAGES);
  const calls: string[][] = [];
  const first = ingestDirectory(db, dir, {
    embedBatch: (texts) => {
      calls.push(texts);
      return minilmVectors(texts);
    },
  });
  assert(first.passages === 3, `setup: expected 3 passages, got ${first.passages}`);
  assert(first.unchanged === 0, `first ingest kept ${first.unchanged}`);
  const ids = first.documentIds.slice();
  plantUpdatedAt(db);
  calls.length = 0;
  const second = ingestDirectory(db, dir, {
    embedBatch: (texts) => {
      calls.push(texts);
      return minilmVectors(texts);
    },
  });
  assert(calls.length === 0, `unchanged file called the embedder: ${JSON.stringify(calls)}`);
  assert(second.unchanged === 3 && second.passages === 0, JSON.stringify(second));
  assert(second.documentIds.length === 0, "a kept passage is not a row written this call");
  assert(second.ingested === 1, "a fully kept file was still read");
  const rows = db
    .prepare(`SELECT id, updated_at FROM vector_document ORDER BY source_ref`)
    .all() as { id: string; updated_at: string }[];
  assert(rows.map((r) => r.id).join() === ids.join(), `ids rotated: ${JSON.stringify(rows)}`);
  assert(
    rows.every((r) => r.updated_at === "2000-01-01T00:00:00.000Z"),
    `a rewrite hid inside the same clock instant: ${JSON.stringify(rows)}`,
  );
});

test("pins", "editing the middle passage embeds that body and leaves the other two", () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "chamber-skip-mid-"));
  const file = join(dir, "note.md");
  writeFileSync(file, THREE_PASSAGES);
  const first = ingestDirectory(db, dir, { embedBatch: minilmVectors });
  const before = db
    .prepare(`SELECT id, source_ref, snapshot_hash FROM vector_document ORDER BY source_ref`)
    .all() as { id: string; source_ref: string; snapshot_hash: string }[];
  plantUpdatedAt(db);
  writeFileSync(file, THREE_PASSAGES.replace("beta body two", "beta body changed"));
  const calls: string[][] = [];
  const second = ingestDirectory(db, dir, {
    embedBatch: (texts) => {
      calls.push(texts);
      return minilmVectors(texts);
    },
  });
  assert(calls.length === 1 && calls[0]!.length === 1, JSON.stringify(calls));
  assert(calls[0]![0]!.includes("beta body changed"), calls[0]![0]);
  assert(second.unchanged === 2 && second.passages === 1, JSON.stringify(second));
  const after = db
    .prepare(`SELECT id, source_ref, snapshot_hash, updated_at FROM vector_document ORDER BY source_ref`)
    .all() as { id: string; source_ref: string; snapshot_hash: string; updated_at: string }[];
  assert(after.map((r) => r.id).join() === before.map((r) => r.id).join(), "ids rotated");
  const mid = after[1]!;
  assert(mid.snapshot_hash !== before[1]!.snapshot_hash, "the edited passage kept its old hash");
  assert(after[0]!.updated_at === "2000-01-01T00:00:00.000Z", "passage 0 was rewritten");
  assert(after[2]!.updated_at === "2000-01-01T00:00:00.000Z", "passage 2 was rewritten");
  assert(second.documentIds.length === 1 && second.documentIds[0] === mid.id, "documentIds must be the written row only");
});

test("pins", "a hash vector of unchanged text is embedded again", () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "chamber-skip-hash-"));
  writeFileSync(join(dir, "note.md"), THREE_PASSAGES);
  ingestDirectory(db, dir, {
    embedBatch: (texts) =>
      texts.map(() => ({
        vector: new Float32Array(8).fill(0.1),
        model: "local-hash-v1",
        dims: 8,
        kind: "hash" as const,
      })),
  });
  const calls: string[][] = [];
  const second = ingestDirectory(db, dir, {
    embedBatch: (texts) => {
      calls.push(texts);
      return minilmVectors(texts);
    },
  });
  assert(calls.length === 1 && calls[0]!.length === 3, JSON.stringify(calls));
  assert(second.unchanged === 0 && second.passages === 3, JSON.stringify(second));
  const models = db.prepare(`SELECT DISTINCT model FROM vector_embedding`).all() as { model: string }[];
  assert(models.length === 1 && models[0]!.model === MINILM_MODEL, JSON.stringify(models));
});

test("pins", "shrinking a file keeps the first id and deletes the other two", () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "chamber-skip-shrink-"));
  const file = join(dir, "note.md");
  writeFileSync(file, THREE_PASSAGES);
  const first = ingestDirectory(db, dir, { embedBatch: minilmVectors });
  const keep = first.documentIds[0]!;
  writeFileSync(file, "# Note\n\nonly one passage now\n");
  const second = ingestDirectory(db, dir, { embedBatch: minilmVectors });
  const rows = db.prepare(`SELECT id FROM vector_document`).all() as { id: string }[];
  assert(rows.length === 1 && rows[0]!.id === keep, JSON.stringify(rows));
  assert(second.removed === 2, `removed ${second.removed}`);
});

test("pins", "the same relative path under a second root is not the first root's row", () => {
  const db = freshDb();
  const a = mkdtempSync(join(tmpdir(), "chamber-skip-root-a-"));
  const b = mkdtempSync(join(tmpdir(), "chamber-skip-root-b-"));
  writeFileSync(join(a, "note.md"), THREE_PASSAGES);
  writeFileSync(join(b, "note.md"), THREE_PASSAGES);
  const first = ingestDirectory(db, a, { embedBatch: minilmVectors });
  const calls: string[][] = [];
  const second = ingestDirectory(db, b, {
    embedBatch: (texts) => {
      calls.push(texts);
      return minilmVectors(texts);
    },
  });
  assert(calls.length === 1 && calls[0]!.length === 3, JSON.stringify(calls));
  assert(second.unchanged === 0, `second root was skipped: ${second.unchanged}`);
  const ids = db.prepare(`SELECT id FROM vector_document`).all() as { id: string }[];
  assert(ids.length === 6, `expected two files of three, got ${ids.length}`);
  assert(!ids.some((r) => first.documentIds.includes(r.id) && second.documentIds.includes(r.id)), "roots shared an id");
});

test("pins", "a different section number is written even when the text matches", () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "chamber-skip-section-"));
  writeFileSync(join(dir, "note.md"), THREE_PASSAGES);
  ingestDirectory(db, dir, { embedBatch: minilmVectors });
  db.prepare(
    `UPDATE vector_document SET metadata_json = json_set(metadata_json, '$.section', 99)
     WHERE source_ref LIKE '%#p1'`,
  ).run();
  const calls: string[][] = [];
  ingestDirectory(db, dir, {
    embedBatch: (texts) => {
      calls.push(texts);
      return minilmVectors(texts);
    },
  });
  assert(calls.length === 1 && calls[0]!.length === 1, JSON.stringify(calls));
  const section = db
    .prepare(`SELECT metadata_json FROM vector_document WHERE source_ref LIKE '%#p1'`)
    .get() as { metadata_json: string };
  const stored = (JSON.parse(section.metadata_json) as { section: number }).section;
  assert(stored === 2, `section stayed ${stored}`);
});

test("pins", "a short batch is discarded and the kept passage stays MiniLM", () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "chamber-skip-short-"));
  const file = join(dir, "note.md");
  writeFileSync(file, THREE_PASSAGES);
  ingestDirectory(db, dir, { embedBatch: minilmVectors });
  plantUpdatedAt(db);
  writeFileSync(
    file,
    THREE_PASSAGES.replace("beta body two", "beta body changed").replace(
      "gamma body three",
      "gamma body changed",
    ),
  );
  const saved = process.env.CHAMBER_EMBEDDER;
  resetMinilmProbe();
  process.env.CHAMBER_EMBEDDER = "hash";
  try {
    const second = ingestDirectory(db, dir, {
      embedBatch: (texts) => {
        if (texts.length === 2) return minilmVectors(texts).slice(0, 1);
        return minilmVectors(texts);
      },
    });
    assert(typeof second.embedFallback === "string", "a short batch must be reported");
    const models = db
      .prepare(
        `SELECT d.source_ref, e.model, d.updated_at
         FROM vector_document d JOIN vector_embedding e ON e.document_id = d.id
         ORDER BY d.source_ref`,
      )
      .all() as { source_ref: string; model: string; updated_at: string }[];
    assert(models[0]!.model === MINILM_MODEL, JSON.stringify(models[0]));
    assert(models[0]!.updated_at === "2000-01-01T00:00:00.000Z", JSON.stringify(models[0]));
    assert(models[1]!.model === "local-hash-v1", JSON.stringify(models[1]));
    assert(models[2]!.model === "local-hash-v1", JSON.stringify(models[2]));
  } finally {
    resetMinilmProbe();
    if (saved === undefined) delete process.env.CHAMBER_EMBEDDER;
    else process.env.CHAMBER_EMBEDDER = saved;
  }
});
```

`resetMinilmProbe` is required. `defaultEmbedderKind` caches its answer on the process, so setting `CHAMBER_EMBEDDER` after another test has already resolved a kind does not change the fallback. Restore the variable and clear the cache in `finally`, or every later test in this process inherits `hash`.

The section numbers this fixture produces are 1, 2, and 3. `#p1` is section 2. That is the value the last assertion checks.

The existing test "the first chunked ingest adopts a pre-chunking row instead of rotating its id" must stay as it is. A bare-path ref does not match `path#p0`, so that row is adopted and rewritten. A skip that treated it as `path#p0` fails that test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: FAIL `pins/a second ingest of an unchanged MiniLM file calls no embedder` because `unchanged` is undefined and the embedder is called with all three bodies. The suite exits 1.

- [ ] **Step 3: Implement the skip**

Import `vaultPageHash` from `./vault_page_hash.ts` and add `MINILM_MODEL` to the existing import from `./embedder.ts`.

On `IngestReport`, replace the `passages` comment with: rows written this call, not the size of the corpus; a kept passage is counted in `unchanged`. Add:

```typescript
  /** Passages kept without a write. The text and the MiniLM vector were already current. */
  unchanged: number;
```

Replace the `embedFallback` comment with: set when the batch embedder threw or returned a short array, and this run used the per-passage path for the passages that needed a vector. Kept passages are not re-embedded. A file can hold `minilm-l6-v2-q` for a kept passage and `local-hash-v1` for a passage the fallback just wrote, until the next run replaces the hash vector. One message for the run, the first failure's.

Set `unchanged: 0` on both object literals that build an `IngestReport` (the invalid-exclude return, and the `report` const).

Add this next to `readIngestRoot`. A string and a number are not equal, which is the same comparison sibling expansion uses:

```typescript
function readSection(json: string | null): number | string | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === "object") {
      const v = (parsed as { section?: unknown }).section;
      if (typeof v === "number" || typeof v === "string") return v;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
```

Extend `ExistingRow` with `snapshotHash: string`, `model: string | null`, and `section: number | string | undefined`. Replace the load query. Do not select `vector_blob`. `vector_embedding.document_id` is the primary key, so the join does not duplicate a passage. A missing embedding is a null model:

```typescript
  for (const row of db
    .prepare(
      `SELECT d.id, d.source_ref, d.snapshot_hash, d.metadata_json, e.model
       FROM vector_document d
       LEFT JOIN vector_embedding e ON e.document_id = d.id
       WHERE d.source_kind = 'vault_page' AND d.source_ref IS NOT NULL`,
    )
    .all() as {
      id: string;
      source_ref: string;
      snapshot_hash: string;
      metadata_json: string | null;
      model: string | null;
    }[]) {
    const path = passagePathOf(row.source_ref);
    const list = existingByPath.get(path);
    const entry: ExistingRow = {
      id: row.id,
      ref: row.source_ref,
      rowRoot: readIngestRoot(row.metadata_json),
      snapshotHash: row.snapshot_hash,
      model: row.model,
      section: readSection(row.metadata_json),
    };
    if (list) list.push(entry);
    else existingByPath.set(path, [entry]);
  }
```

Leave the adoption block (`idByRef`, the pre-chunk `path` match, the collision push) where it is. After `const docTitle = ...`, replace the batch comment and the loop through the shrink sweep's start with the following. One `title` value is hashed and stored. Hashing a different title than `upsertDocument` receives skips a heading change.

```typescript
    const rowById = new Map(owned.map((o) => [o.id, o]));
    const pending: {
      body: string;
      sourceRef: string;
      title: string;
      id: string | undefined;
      section: number;
    }[] = [];
    const writtenIds = new Set<string>();
    for (const p of passages) {
      const sourceRef = passageSourceRef(path, p.index);
      const title = passageTitle(docTitle, p.headings);
      const hash = vaultPageHash({ title, body: p.body, source_ref: sourceRef });
      const existingId = idByRef.get(sourceRef);
      const row = existingId ? rowById.get(existingId) : undefined;
      if (
        row &&
        row.snapshotHash === hash &&
        row.model === MINILM_MODEL &&
        row.section === p.section
      ) {
        writtenIds.add(row.id);
        report.unchanged += 1;
        continue;
      }
      pending.push({ body: p.body, sourceRef, title, id: existingId, section: p.section });
    }

    // The batch is the passages that need a vector, in this list's order.
    // Vector i belongs to pending[i]. Zipping it onto `passages` would attach
    // a new vector to a passage that was kept. An empty list makes no call.
    // A short result is discarded: the fallback embeds this list only, and a
    // file may then hold MiniLM for what was kept and a hash vector for what
    // the fallback wrote.
    let embeds: EmbedResult[] | undefined;
    if (pending.length > 0) {
      try {
        const batch = (opts.embedBatch ?? embedLocalBatch)(pending.map((p) => p.body));
        embeds = batch.length === pending.length ? batch : undefined;
        if (!embeds) {
          throw new Error(
            `batch returned ${batch.length} vectors for ${pending.length} passages`,
          );
        }
      } catch (err) {
        embeds = undefined;
        report.embedFallback ??= errText(err);
      }
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i]!;
        const doc = upsertDocument(db, {
          id: item.id,
          sourceKind: "vault_page",
          sourceRef: item.sourceRef,
          title: item.title,
          body: item.body,
          metadata: { ingestRoot: root, section: item.section },
          ...(embeds
            ? { embedding: embeds[i]!.vector, model: embeds[i]!.model }
            : {}),
        });
        report.passages += 1;
        report.documentIds.push(doc.id);
        writtenIds.add(doc.id);
      }
    }
```

The shrink sweep below it stays, still iterating `owned` and deleting ids absent from `writtenIds`. `report.ingested += 1` stays after the sweep.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: the seven new tests PASS, the idempotence test PASS, the pre-chunking adoption test PASS, and the suite's failed count is 0.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/ingest.ts tests/harness.ts
git commit -m "$(cat <<'EOF'
feat: skip unchanged MiniLM passages on ingest

Re-ingest was rewriting every passage, including ones whose text and MiniLM vector were already current.
EOF
)"
```

---

### Task 3: Report writes and keeps separately

**Files:**
- Modify: `src/ingest.ts` (add `formatIngestLine` next to `IngestReport`)
- Modify: `src/cli.ts` (the ingest log around lines 1119–1125)
- Modify: `src/try_demo.ts` (lines 81 and 130)
- Modify: `scripts/backtest_drift.ts` (the re-ingest log around line 593, and the import block)
- Modify: `tests/harness.ts` (one test next to the Task 2 tests)
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `IngestReport.unchanged` from Task 2; `countDocuments` from `src/vector.ts`
- Produces:

```typescript
export function formatIngestLine(
  report: Pick<IngestReport, "ingested" | "passages" | "unchanged">,
  from?: string,
): string;
```

- [ ] **Step 1: Write the failing test**

Import `formatIngestLine` from `../src/ingest.ts` in the harness.

```typescript
test("pins", "the ingest line names kept passages only when there are some", () => {
  assert(
    formatIngestLine({ ingested: 2, passages: 4, unchanged: 0 }, "/vault") ===
      "ingested 2 file(s) as 4 passage(s) from /vault",
    "a run that kept nothing must keep the old line",
  );
  assert(
    formatIngestLine({ ingested: 2, passages: 1, unchanged: 3 }, "/vault") ===
      "ingested 2 file(s): wrote 1 passage(s), kept 3 unchanged from /vault",
    "a run that kept passages must say wrote and kept",
  );
  assert(
    formatIngestLine({ ingested: 2, passages: 4, unchanged: 0 }) ===
      "ingested 2 file(s) as 4 passage(s)",
    "the demo line has no path",
  );
  assert(
    formatIngestLine({ ingested: 2, passages: 1, unchanged: 3 }) ===
      "ingested 2 file(s): wrote 1 passage(s), kept 3 unchanged",
    "the demo split has no path",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: the process fails while loading the harness, because `formatIngestLine` is not exported from `src/ingest.ts`. Exit non-zero. No PASS line for this test.

- [ ] **Step 3: Print the split from one function**

Add to `src/ingest.ts`:

```typescript
export function formatIngestLine(
  report: Pick<IngestReport, "ingested" | "passages" | "unchanged">,
  from?: string,
): string {
  const tail = from === undefined ? "" : ` from ${from}`;
  if (report.unchanged === 0) {
    return `ingested ${report.ingested} file(s) as ${report.passages} passage(s)${tail}`;
  }
  return (
    `ingested ${report.ingested} file(s): wrote ${report.passages} passage(s), ` +
    `kept ${report.unchanged} unchanged${tail}`
  );
}
```

In `src/cli.ts`, import `formatIngestLine` and replace the `console.log` of the ingest line with:

```typescript
        console.log(formatIngestLine(r, path));
```

Replace the comment above the `embedFallback` stderr that says the corpus is still fully embedded. The warning text itself stays. The comment becomes: kept passages stay on their existing vector; passages the fallback wrote may be hash vectors until the next run.

In `src/try_demo.ts`, import `formatIngestLine`. Replace both `line(\`ingested ${...} file(s) as ${...} passage(s)\`)` calls with `line(formatIngestLine(ing))` and `line(formatIngestLine(re))`.

In `scripts/backtest_drift.ts`, import `countDocuments` from `../src/vector.ts`. Leave the first log, `ingested ${before.ingested} file(s) → ${before.passages} passage(s)`, as it is. Replace the re-ingest log with:

```typescript
  log(
    `re-ingest ${after.ingested} file(s) → ${countDocuments(db)} passage(s) at ${args.to} ` +
      `(wrote ${after.passages}, kept ${after.unchanged})`,
  );
```

`countDocuments` is the corpus. `after.passages` on that second ingest is only what was written.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=pins`

Expected: the new line test PASS and the suite's failed count is 0.

Run: `npm test`

Expected: the failed count is 0. Set `CHAMBER_PYTHON` to the interpreter that has onnxruntime if a paraphrase test skips for lack of it; a skip of that test is not a failure of this change. Do not treat a failure outside the pins suite as unrelated until it has been run once on its own.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/ingest.ts src/cli.ts src/try_demo.ts scripts/backtest_drift.ts tests/harness.ts
git commit -m "$(cat <<'EOF'
feat: say how many passages an ingest kept

A re-ingest log that prints passages as the corpus size reports a collapse when unchanged rows are left in place.
EOF
)"
```
