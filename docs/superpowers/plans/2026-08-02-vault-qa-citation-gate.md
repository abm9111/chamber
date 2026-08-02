# Vault Q&A Citation Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer questions about the owner's vault where every load-bearing claim carries a content pin that is verified at commit time and can later be detected as stale.

**Architecture:** Three CLI commands over a fixed pipeline — `ingest` loads markdown into `vector_document`, `ask` retrieves passages, has a model answer citing passage *numbers*, maps those numbers to document ids locally, verifies pins, and commits through the existing contract gate. `verify` re-checks stored pins against the current corpus to find beliefs whose evidence has drifted. No agent loop, no tool calls, no sandbox.

**Tech Stack:** TypeScript on `node:sqlite`, run via `node --experimental-strip-types`. Zero runtime dependencies. Existing modules: `src/vector.ts` (retrieval + embedding), `src/contract.ts` (claim classification + commit path), `src/commit_belief.ts` (the gate), `src/model.ts` (completions), `tests/harness.ts` (test runner).

## Global Constraints

- **Zero runtime dependencies.** devDependencies and optionalDependencies are fine; `package.json` `dependencies` must stay absent/empty.
- **Learning stays propose-only.** Nothing in this plan may auto-approve a memory write, a skill, or a capability level.
- **Gates fail closed.** An unverifiable pin never counts as support. Unregistered source kinds are unverifiable, not exempt.
- **The model never sees or emits a document id or a hash.** It sees `[1]`…`[8]` and emits those numbers. Index→id and id→hash mapping happen locally.
- **No new schema files.** This plan adds no `sql/*.sql`. If that changes, the new file must be appended to `SCHEMA_FILES` in `src/db.ts:8-23` or it will never load.
- Run `npm run test` (currently 99/99) after every task. It must stay green.
- Commit format: `type: description`, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/pins.ts` | create | `verifyPin` (single source) and `verifyBeliefSources` (corpus-wide drift scan). Pure lookup, no network, no model. |
| `src/ingest.ts` | create | `ingestDirectory` — walk markdown, strip frontmatter, upsert into `vector_document`. |
| `src/ask.ts` | create | `runAsk` — the retrieve→prompt→complete→map→verify→contract pipeline, returning a structured result. Takes an injectable completion function so it is testable without a live model. |
| `src/cli.ts` | modify | `main()` becomes async; three thin command cases that call the modules above and render their results. No pipeline logic here. |
| `src/commit_belief.ts` | modify | Replace the truthiness pin check with real verification; mint debt on zero *verified* sources. |
| `src/contract.ts` | modify | Stop dropping `provenance` when mapping `ContractSource` → `SourceRef`. |
| `src/harness_adapter.ts` | modify | `getHarness` throws on unknown id instead of silently returning the stub. |
| `tests/harness.ts` | modify | New `pins` suite; `seedPinnedDoc` helper; update five legacy synthetic-pin call sites. |

`runAsk` and `ingestDirectory` live outside `cli.ts` deliberately — `cli.ts` is already ~1360 lines, and putting pipeline logic there would make it untestable without spawning a process.

---

### Task 1: Async CLI and fail-closed harness lookup

Prerequisite plumbing. `main()` is synchronous (`src/cli.ts:578`) and `ask` must await a completion. `getHarness` silently substitutes the stub for an unknown id, which makes a typo in `CHAMBER_HARNESS` return canned text that looks like a real answer.

**Files:**
- Modify: `src/cli.ts:578` (signature), `src/cli.ts:1362` (call site)
- Modify: `src/harness_adapter.ts:28-31`
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `main(): Promise<void>`; `getHarness(id?: string): ModelHarness` that throws `Error` on an unregistered id.

- [ ] **Step 1: Add the `pins` suite name to the test runner**

In `tests/harness.ts`, add `"pins"` to the `Suite` union (currently at `tests/harness.ts:153-167`) and to the array in `suiteFromArg` (around `tests/harness.ts:170-180`) so `--suite=pins` works:

```typescript
type Suite =
  | "gates"
  | "spend"
  | "approvals"
  | "audit"
  | "vector"
  | "pins"
  | "phase1"
```

And in the validation array, add `"pins",` alongside `"discord",`.

- [ ] **Step 2: Write the failing test**

Add near the other harness tests in `tests/harness.ts`:

```typescript
test("pins", "getHarness throws on unknown id", () => {
  let threw = false;
  try {
    getHarness("no-such-harness");
  } catch {
    threw = true;
  }
  assert(threw, "getHarness must throw on an unregistered id, not return the stub");
});
```

Ensure `getHarness` is imported in `tests/harness.ts`; if it is not, add it to the existing import from `../src/harness_adapter.ts`.

- [ ] **Step 3: Run it and watch it fail**

Run: `npm run test -- --suite=pins`
Expected: FAIL — `getHarness must throw on an unregistered id, not return the stub`

- [ ] **Step 4: Make `getHarness` fail closed**

Replace `src/harness_adapter.ts:28-31`:

```typescript
export function getHarness(id?: string): ModelHarness {
  const want = id ?? process.env.CHAMBER_HARNESS ?? "stub-local";
  const found = registry.get(want);
  if (!found) {
    throw new Error(
      `unknown harness "${want}" (registered: ${[...registry.keys()].join(", ")})`,
    );
  }
  return found;
}
```

- [ ] **Step 5: Make `main` async**

In `src/cli.ts`, change the signature at line 578 and the call at line 1362:

```typescript
async function main(): Promise<void> {
```

```typescript
main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
```

- [ ] **Step 6: Verify both**

Run: `npm run test`
Expected: 100/100 passed, 0 failed

Run: `node --experimental-strip-types src/cli.ts status`
Expected: exit 0, status banner prints

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/harness_adapter.ts tests/harness.ts
git commit -m "fix: async CLI main and fail-closed harness lookup

getHarness returned the stub for any unregistered id, so a typo in
CHAMBER_HARNESS produced canned text that reads like a real answer.
It now throws and names the registered harnesses.

main() becomes async so commands can await completions.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `verifyPin` and the per-kind formula registry

**Files:**
- Create: `src/pins.ts`
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `upsertDocument` from `src/vector.ts`, `sha256` from `src/hash.ts`
- Produces:
  ```typescript
  export type PinFailure = "not_found" | "hash_mismatch" | "kind_unregistered";
  export interface PinVerdict {
    ok: boolean;
    reason?: PinFailure;
    actualHash?: string;
    sourceRef?: string | null;
  }
  export function verifyPin(
    db: DatabaseSync,
    source: { kind: string; refId: string; snapshotHash: string },
  ): PinVerdict;
  ```

The hash formula must be byte-identical to the one `upsertDocument` uses at `src/vector.ts:131-133`: `sha256([title ?? "", body, sourceRef ?? ""].join("\n"))`. If these ever diverge, every honest citation fails.

- [ ] **Step 1: Write the failing tests**

```typescript
test("pins", "verifyPin accepts a round-tripped document", () => {
  const db = freshDb();
  const doc = upsertDocument(db, {
    sourceKind: "vault_page",
    sourceRef: "notes/a.md",
    title: "A",
    body: "the sky is blue",
  });
  const row = db
    .prepare(`SELECT snapshot_hash FROM vector_document WHERE id = ?`)
    .get(doc.id) as { snapshot_hash: string };
  const v = verifyPin(db, {
    kind: "vault_page",
    refId: doc.id,
    snapshotHash: row.snapshot_hash,
  });
  assert(v.ok, `expected ok, got ${v.reason}`);
});

test("pins", "verifyPin reports not_found for an unknown refId", () => {
  const db = freshDb();
  const v = verifyPin(db, {
    kind: "vault_page",
    refId: "vdoc_does_not_exist",
    snapshotHash: sha256("anything"),
  });
  assert(!v.ok, "must not pass");
  assert(v.reason === "not_found", `expected not_found, got ${v.reason}`);
});

test("pins", "verifyPin reports hash_mismatch when the body drifts", () => {
  const db = freshDb();
  const doc = upsertDocument(db, {
    sourceKind: "vault_page",
    sourceRef: "notes/b.md",
    title: "B",
    body: "original body",
  });
  const row = db
    .prepare(`SELECT snapshot_hash FROM vector_document WHERE id = ?`)
    .get(doc.id) as { snapshot_hash: string };
  db.prepare(`UPDATE vector_document SET body = ? WHERE id = ?`).run(
    "edited body",
    doc.id,
  );
  const v = verifyPin(db, {
    kind: "vault_page",
    refId: doc.id,
    snapshotHash: row.snapshot_hash,
  });
  assert(!v.ok, "must not pass after drift");
  assert(v.reason === "hash_mismatch", `expected hash_mismatch, got ${v.reason}`);
});

test("pins", "verifyPin reports kind_unregistered for kinds with no formula", () => {
  const db = freshDb();
  const v = verifyPin(db, {
    kind: "x_tweet",
    refId: "t1",
    snapshotHash: sha256("x"),
  });
  assert(!v.ok, "unregistered kinds must not pass");
  assert(
    v.reason === "kind_unregistered",
    `expected kind_unregistered, got ${v.reason}`,
  );
});
```

Add `verifyPin` to the imports in `tests/harness.ts` from `../src/pins.ts`, and confirm `upsertDocument` and `sha256` are already imported (they are used elsewhere in the file).

- [ ] **Step 2: Run and watch them fail**

Run: `npm run test -- --suite=pins`
Expected: FAIL — cannot find module `../src/pins.ts`

- [ ] **Step 3: Write `src/pins.ts`**

```typescript
/**
 * Content-pin verification.
 *
 * A pin is only meaningful if the formula that produced it is the same one
 * that checks it. Each source kind therefore registers its own formula, and a
 * kind with no registered formula is unverifiable — never exempt.
 *
 * Verification is a local corpus lookup: no network, no model, safe to call
 * inside a gate transaction.
 */

import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "./hash.ts";

export type PinFailure = "not_found" | "hash_mismatch" | "kind_unregistered";

export interface PinVerdict {
  ok: boolean;
  reason?: PinFailure;
  actualHash?: string;
  sourceRef?: string | null;
}

export interface PinnedSource {
  kind: string;
  refId: string;
  snapshotHash: string;
}

/**
 * Recompute a vault_page pin from the stored row.
 * Must stay byte-identical to upsertDocument (src/vector.ts:131-133).
 */
function vaultPageHash(row: {
  title: string | null;
  body: string;
  source_ref: string | null;
}): string {
  return sha256([row.title ?? "", row.body, row.source_ref ?? ""].join("\n"));
}

export function verifyPin(db: DatabaseSync, source: PinnedSource): PinVerdict {
  if (source.kind !== "vault_page") {
    return { ok: false, reason: "kind_unregistered" };
  }
  const row = db
    .prepare(
      `SELECT title, body, source_ref FROM vector_document WHERE id = ?`,
    )
    .get(source.refId) as
    | { title: string | null; body: string; source_ref: string | null }
    | undefined;

  if (!row) return { ok: false, reason: "not_found" };

  const actualHash = vaultPageHash(row);
  if (actualHash !== source.snapshotHash) {
    return {
      ok: false,
      reason: "hash_mismatch",
      actualHash,
      sourceRef: row.source_ref,
    };
  }
  return { ok: true, actualHash, sourceRef: row.source_ref };
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `npm run test -- --suite=pins`
Expected: 5 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add src/pins.ts tests/harness.ts
git commit -m "feat: add verifyPin with a per-kind formula registry

Verification recomputes the pin from the stored row using the same
formula upsertDocument used to create it, so an honest citation
verifies by construction and a fabricated one fails by construction.

Kinds with no registered formula return kind_unregistered rather than
passing. An unverifiable pin is not an exempt pin.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Enforce pin verification inside the gate

This is the change that makes `probes/pin_bypass.ts` fail. It also breaks five existing tests that commit with synthetic pins, and fixing those is part of this task — not a surprise for later.

**Files:**
- Modify: `src/commit_belief.ts:105-110` (truthiness check), `src/commit_belief.ts:241` (debt condition)
- Modify: `tests/harness.ts:331,387,478,497,513` (synthetic pins)
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `verifyPin` from Task 2
- Produces: `commitBelief` behaviour where only verified sources are written to `belief_source` and counted against the debt condition. `CommitResult` gains an optional `rejectedSources?: { refId: string; reason: PinFailure }[]`.

- [ ] **Step 1: Add a test helper that produces real pins**

The five existing call sites use `{ kind: "transcript", refId: "t1", snapshotHash: sha256("x") }` — a hash of a string that was never stored anywhere. Add this helper to `tests/harness.ts` next to `freshDb`:

```typescript
/** Ingest a real document and return a SourceRef whose pin actually verifies. */
function seedPinnedDoc(
  db: DatabaseSync,
  body: string,
  sourceRef = "notes/seed.md",
): { kind: "vault_page"; refId: string; snapshotHash: string } {
  const doc = upsertDocument(db, {
    sourceKind: "vault_page",
    sourceRef,
    title: "seed",
    body,
  });
  const row = db
    .prepare(`SELECT snapshot_hash FROM vector_document WHERE id = ?`)
    .get(doc.id) as { snapshot_hash: string };
  return {
    kind: "vault_page",
    refId: doc.id,
    snapshotHash: row.snapshot_hash,
  };
}
```

- [ ] **Step 2: Write the failing gate test**

```typescript
test("pins", "fabricated pin mints blocking debt instead of committing clean", () => {
  const db = freshDb();
  const r = commitBelief(db, {
    content: "Compound X is safe at 400mg daily.",
    type: "belief",
    path: "deep_lite",
    stakes: "consequential",
    sources: [
      { kind: "vault_page", refId: "vdoc_fabricated", snapshotHash: "aaaa" },
    ],
  });
  const debts = count(
    db,
    `SELECT count(*) AS c FROM citation_debt WHERE blocking = 1 AND status = 'pending'`,
  );
  assert(debts > 0, "a fabricated pin must mint blocking debt");
  assert(
    !r.ok || (r.rejectedSources?.length ?? 0) > 0,
    "the fabricated source must be reported as rejected",
  );
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm run test -- --suite=pins`
Expected: FAIL — `a fabricated pin must mint blocking debt` (today the gate accepts any non-empty `snapshotHash`)

- [ ] **Step 4: Wire verification into the gate**

In `src/commit_belief.ts`, add the import:

```typescript
import { verifyPin, type PinFailure } from "./pins.ts";
```

Replace the truthiness loop that starts at `src/commit_belief.ts:105`:

```typescript
  const verifiedSources: typeof sources = [];
  const rejectedSources: { refId: string; reason: PinFailure }[] = [];

  for (const s of sources) {
    if (!s.snapshotHash) {
      return { ok: false, status: "REJECTED", reason: "source missing snapshot_hash pin" };
    }
    if (s.kind === "belief") {
      verifiedSources.push(s);
      continue;
    }
    const verdict = verifyPin(db, {
      kind: s.kind,
      refId: s.refId,
      snapshotHash: s.snapshotHash,
    });
    if (verdict.ok) verifiedSources.push(s);
    else rejectedSources.push({ refId: s.refId, reason: verdict.reason! });
  }
```

Keep the rest of the original `belief`-kind handling that followed the old check.

Then, everywhere the function writes `belief_source` rows or evaluates the debt condition, use `verifiedSources` instead of `sources`. Specifically, change `src/commit_belief.ts:241` from:

```typescript
    if (ASSERTION.has(type) && sources.length === 0) {
```

to:

```typescript
    if (ASSERTION.has(type) && verifiedSources.length === 0) {
```

Add `rejectedSources` to every returned `CommitResult` where it is non-empty, and add the optional field to the `CommitResult` type in `src/types.ts`:

```typescript
  rejectedSources?: { refId: string; reason: string }[];
```

- [ ] **Step 5: Update the five legacy synthetic-pin call sites**

At `tests/harness.ts` lines 331, 387, 478, 497 and 513, replace the inline synthetic source with the helper. For example, line 331 becomes:

```typescript
    sources: [seedPinnedDoc(db, "x")],
```

and line 387's entry becomes `seedPinnedDoc(db, "foundation fact")`. Each call site needs a `db` already in scope — all five have one. Where two sources in the same test must be distinct documents, pass a distinct `sourceRef`, e.g. `seedPinnedDoc(db, "seen", "notes/seen.md")`.

- [ ] **Step 6: Run the full suite**

Run: `npm run test`
Expected: 105/105 passed, 0 failed — no regressions from the five updated call sites

- [ ] **Step 7: Confirm the bypass probe now fails**

Run: `node --experimental-strip-types probes/pin_bypass.ts; echo "exit=$?"`
Expected: `exit=1` (or any non-zero). Before this task it exits 0, demonstrating the bypass. If it still exits 0, the probe asserts the old behaviour and its assertion — not the gate — must be inverted.

- [ ] **Step 8: Commit**

```bash
git add src/commit_belief.ts src/types.ts tests/harness.ts
git commit -m "feat: verify content pins inside the commit gate

The gate accepted any non-empty snapshotHash, so a fabricated pin
committed clean with zero debt. It now verifies each pin against the
local corpus and mints debt when no source survives verification.

Five tests committed with synthetic transcript pins that were never
stored anywhere; they now use seedPinnedDoc, which ingests a real
document and returns a pin that actually verifies.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Stop dropping provenance in the contract layer

`SourceRef` carries `provenance` (`src/types.ts:62`) and `commitBelief` writes it (`src/commit_belief.ts:233`), but `ContractSource` (`src/contract.ts:24-29`) omits the field and the mapping at `src/contract.ts:86-91` drops it. Every `belief_source` row routed through the contract lands with `provenance = NULL`.

**Files:**
- Modify: `src/contract.ts:24-29`, `src/contract.ts:86-91`
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `seedPinnedDoc` from Task 3
- Produces: `ContractSource` with `provenance?: SourceRef["provenance"]`, preserved through to `belief_source.provenance`.

- [ ] **Step 1: Write the failing test**

```typescript
test("pins", "contract preserves source provenance", () => {
  const db = freshDb();
  const src = seedPinnedDoc(db, "retrieved via vector search");
  enforceClaimContract(
    db,
    { kind: "assertion", text: "The retrieved passage is authoritative here." },
    { sources: [{ ...src, provenance: "vector" }] },
  );
  const n = count(
    db,
    `SELECT count(*) AS c FROM belief_source WHERE provenance = 'vector'`,
  );
  assert(n > 0, "provenance must survive the contract layer");
});
```

Ensure `enforceClaimContract` is imported in `tests/harness.ts` from `../src/contract.ts`.

- [ ] **Step 2: Run and watch it fail**

Run: `npm run test -- --suite=pins`
Expected: FAIL — `provenance must survive the contract layer`

- [ ] **Step 3: Add the field and pass it through**

In `src/contract.ts`, extend the interface at line 24:

```typescript
export interface ContractSource {
  kind: SourceRef["kind"];
  refId: string;
  snapshotHash: string;
  spanHash?: string;
  provenance?: SourceRef["provenance"];
}
```

And the mapping at line 86:

```typescript
  const sources: SourceRef[] = (opts.sources ?? []).map((s) => ({
    kind: s.kind,
    refId: s.refId,
    snapshotHash: s.snapshotHash,
    spanHash: s.spanHash,
    provenance: s.provenance,
  }));
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run test`
Expected: 106/106 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add src/contract.ts tests/harness.ts
git commit -m "fix: preserve source provenance through the contract layer

ContractSource omitted provenance, so every belief_source row committed
via the contract recorded NULL and there was no record of which
retriever produced the evidence.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `chamber ingest`

**Files:**
- Create: `src/ingest.ts`
- Modify: `src/cli.ts` (new `case "ingest"`, and the help text)
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `upsertDocument` from `src/vector.ts`
- Produces:
  ```typescript
  export interface IngestReport {
    ingested: number;
    skipped: { path: string; reason: string }[];
    documentIds: string[];
  }
  export function ingestDirectory(
    db: DatabaseSync,
    root: string,
    opts?: { exclude?: string[] },
  ): IngestReport;
  ```

`sourceRef` is the identity key: it is the file path relative to `root`, so re-ingesting updates in place rather than duplicating.

- [ ] **Step 1: Write the failing tests**

```typescript
test("pins", "ingestDirectory loads markdown and is idempotent", () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "chamber-ingest-"));
  writeFileSync(join(dir, "a.md"), "---\ntitle: Alpha\n---\nalpha body\n");
  writeFileSync(join(dir, "b.md"), "beta body\n");
  writeFileSync(join(dir, "ignore.txt"), "not markdown\n");

  const first = ingestDirectory(db, dir);
  assert(first.ingested === 2, `expected 2 ingested, got ${first.ingested}`);

  const second = ingestDirectory(db, dir);
  const rows = count(db, `SELECT count(*) AS c FROM vector_document`);
  assert(rows === 2, `re-ingest must update in place, got ${rows} rows`);
  assert(second.ingested === 2, "re-ingest still reports the files it processed");
});

test("pins", "ingestDirectory honours exclude patterns", () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "chamber-ingest-ex-"));
  mkdirSync(join(dir, "private"));
  writeFileSync(join(dir, "keep.md"), "keep me\n");
  writeFileSync(join(dir, "private", "secret.md"), "secret\n");

  const r = ingestDirectory(db, dir, { exclude: ["private"] });
  assert(r.ingested === 1, `expected 1 ingested, got ${r.ingested}`);
});
```

Add to the imports at the top of `tests/harness.ts`:

```typescript
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDirectory } from "../src/ingest.ts";
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm run test -- --suite=pins`
Expected: FAIL — cannot find module `../src/ingest.ts`

- [ ] **Step 3: Write `src/ingest.ts`**

```typescript
/**
 * Markdown corpus ingest.
 *
 * sourceRef (the path relative to the ingest root) is the identity key, so
 * re-ingesting a file updates its row in place rather than creating a second
 * document with a second pin.
 */

import type { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { upsertDocument } from "./vector.ts";

export interface IngestReport {
  ingested: number;
  skipped: { path: string; reason: string }[];
  documentIds: string[];
}

/** Strip YAML frontmatter, returning the title (if any) and the body. */
export function splitFrontmatter(raw: string): {
  title?: string;
  body: string;
} {
  if (!raw.startsWith("---")) return { body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { body: raw };
  const front = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const m = front.match(/^title:\s*(.+)$/m);
  return { title: m?.[1]?.trim().replace(/^["']|["']$/g, ""), body };
}

function walk(dir: string, exclude: string[], out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (exclude.some((x) => entry === x || full.includes(`${sep}${x}${sep}`))) {
      continue;
    }
    if (statSync(full).isDirectory()) walk(full, exclude, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
}

export function ingestDirectory(
  db: DatabaseSync,
  root: string,
  opts: { exclude?: string[] } = {},
): IngestReport {
  const exclude = opts.exclude ?? [];
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
```

- [ ] **Step 4: Run and watch them pass**

Run: `npm run test -- --suite=pins`
Expected: all `pins` tests pass

- [ ] **Step 5: Add the CLI command**

In `src/cli.ts`, add to the `switch (cmd)` block alongside the other cases, and import `ingestDirectory` from `./ingest.ts`:

```typescript
    case "ingest": {
      const target = rest.filter((a) => !a.startsWith("--"))[0];
      if (!target) {
        console.error('usage: chamber ingest <path> [--exclude <name>]');
        process.exitCode = 1;
        break;
      }
      const exclude: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--exclude" && rest[i + 1]) exclude.push(rest[i + 1]!);
      }
      const r = ingestDirectory(db, target, { exclude });
      console.log(`ingested ${r.ingested} file(s) from ${target}`);
      for (const s of r.skipped) console.log(`  skipped ${s.path}: ${s.reason}`);
      break;
    }
```

Add a line to the `help()` text: `  ingest <path> [--exclude <name>]   load markdown into the corpus`

- [ ] **Step 6: Verify end to end**

Run: `npm run test`
Expected: 108/108 passed, 0 failed

Run: `node --experimental-strip-types src/cli.ts ingest docs`
Expected: `ingested N file(s) from docs` with N ≥ 3

- [ ] **Step 7: Commit**

```bash
git add src/ingest.ts src/cli.ts tests/harness.ts
git commit -m "feat: add chamber ingest for markdown corpora

Walks a directory, strips YAML frontmatter, and upserts each file into
vector_document keyed on its path relative to the ingest root, so
re-ingesting updates in place instead of creating a second pin.

Unreadable files are skipped and reported rather than aborting the run.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `chamber ask`

The pipeline. Testable without a live model because the completion function is injected.

**Files:**
- Create: `src/ask.ts`
- Modify: `src/cli.ts` (new `case "ask"`, help text)
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `searchVector` (`src/vector.ts`), `MINILM_MODEL` (`src/embedder.ts`), `classifyClaims` + `enforceClaimContract` (`src/contract.ts`), `verifyPin` (Task 2), `complete` (`src/model.ts`)
- Produces:
  ```typescript
  export type CompleteFn = (prompt: string) => Promise<string>;
  export interface AskClaimResult {
    text: string;
    kind: string;
    status: string;
    citedRefs: string[];
    rejected: { refId: string; reason: string }[];
    debtIds: string[];
  }
  export interface AskResult {
    answer: string;
    claims: AskClaimResult[];
    passages: { index: number; documentId: string; sourceRef: string | null }[];
    modelCalled: boolean;
    note?: string;
  }
  export function runAsk(
    db: DatabaseSync,
    question: string,
    opts?: { complete?: CompleteFn; strict?: boolean; k?: number; turnId?: string; sessionId?: string },
  ): Promise<AskResult>;
  ```

- [ ] **Step 1: Write the failing tests**

```typescript
test("pins", "runAsk maps cited passage numbers to verified sources", async () => {
  const db = freshDb();
  upsertDocument(db, {
    sourceKind: "vault_page",
    sourceRef: "notes/decision.md",
    title: "Decision",
    body: "We decided to use SQLite for the audit store.",
  });
  const fake = async () =>
    "We decided to use SQLite for the audit store. [1]";
  const r = await runAsk(db, "what did we decide about the audit store", {
    complete: fake,
  });
  assert(r.modelCalled, "model should have been called");
  const assertions = r.claims.filter((c) => c.kind === "assertion");
  assert(assertions.length > 0, "expected at least one assertion claim");
  assert(
    assertions[0]!.citedRefs.length === 1,
    `expected 1 cited ref, got ${assertions[0]!.citedRefs.length}`,
  );
  assert(
    assertions[0]!.rejected.length === 0,
    `expected no rejected citations, got ${JSON.stringify(assertions[0]!.rejected)}`,
  );
});

test("pins", "runAsk does not call the model on an empty corpus", async () => {
  const db = freshDb();
  let called = false;
  const fake = async () => {
    called = true;
    return "should never run";
  };
  const r = await runAsk(db, "anything at all", { complete: fake });
  assert(!called, "the model must not be called with zero retrieved passages");
  assert(!r.modelCalled, "modelCalled must be false");
  assert(!!r.note, "a note explaining why must be returned");
});

test("pins", "runAsk rejects a citation to a passage it never retrieved", async () => {
  const db = freshDb();
  upsertDocument(db, {
    sourceKind: "vault_page",
    sourceRef: "notes/one.md",
    title: "One",
    body: "Only one passage exists in this corpus.",
  });
  const fake = async () => "This claim is supported by nothing real. [7]";
  const r = await runAsk(db, "one passage", { complete: fake });
  const assertions = r.claims.filter((c) => c.kind === "assertion");
  assert(assertions.length > 0, "expected an assertion");
  assert(
    assertions[0]!.citedRefs.length === 0,
    "an out-of-range index must not become a source",
  );
});
```

Add `runAsk` to the `tests/harness.ts` imports from `../src/ask.ts`.

**Note:** these tests are `async`. The runner was made async-aware and serialized in **Tasks 1b/1c**, moved forward after Task 1's review proved the original runner recorded failing async tests as passing.

Before writing these tests, confirm the runner is in its current state: `test()` accepts `() => void | Promise<void>`, async tests are queued as thunks and drained **sequentially** in source order, a test that returns a Promise without being declared `async` is rejected outright, and the report block asserts every registered test produced a result. Do not reimplement it — read `tests/harness.ts` and verify. If any of those properties is missing, stop and report rather than patching it inline, because every later task depends on this runner being correct.
- [ ] **Step 2: Add a meta-test proving async failures are caught**

```typescript
test("pins", "async test failures are reported", async () => {
  await Promise.resolve();
  assert(true, "sanity: async tests run to completion");
});
```

Temporarily change `assert(true, ...)` to `assert(false, ...)`, run `npm run test -- --suite=pins`, and confirm the runner exits non-zero and reports the failure. Then change it back. Without this check, every async test in this task could silently pass.

- [ ] **Step 3: Run and watch them fail**

Run: `npm run test -- --suite=pins`
Expected: FAIL — cannot find module `../src/ask.ts`

- [ ] **Step 4: Write `src/ask.ts`**

```typescript
/**
 * Vault question answering with a real citation gate.
 *
 * The model sees passages numbered [1]..[k] and cites those numbers. It never
 * sees a document id and never sees or emits a hash, so it can neither invent
 * an identifier nor forge a pin — index->id and id->hash mapping happen here.
 */

import type { DatabaseSync } from "node:sqlite";
import { searchVector } from "./vector.ts";
import { MINILM_MODEL } from "./embedder.ts";
import { classifyClaims, enforceClaimContract } from "./contract.ts";
import { verifyPin } from "./pins.ts";
import { complete } from "./model.ts";

export type CompleteFn = (prompt: string) => Promise<string>;

export interface AskClaimResult {
  text: string;
  kind: string;
  status: string;
  citedRefs: string[];
  rejected: { refId: string; reason: string }[];
  debtIds: string[];
}

export interface AskResult {
  answer: string;
  claims: AskClaimResult[];
  passages: { index: number; documentId: string; sourceRef: string | null }[];
  modelCalled: boolean;
  note?: string;
}

const SYSTEM = [
  "Answer the question using ONLY the numbered passages below.",
  "After each claim you make, cite the passage number in square brackets, e.g. [2].",
  "If the passages do not answer the question, say \"I don't know\" and cite nothing.",
  "Never cite a number that is not listed below.",
].join("\n");

export function buildPrompt(
  question: string,
  passages: { index: number; title: string | null; sourceRef: string | null; body: string }[],
): string {
  const rendered = passages
    .map((p) => `[${p.index}] ${p.title ?? "untitled"} (${p.sourceRef ?? "?"})\n${p.body}`)
    .join("\n\n");
  return `${SYSTEM}\n\nPASSAGES:\n${rendered}\n\nQUESTION: ${question}`;
}

/** Extract the distinct passage numbers cited in one claim, in order. */
export function citedIndices(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export async function runAsk(
  db: DatabaseSync,
  question: string,
  opts: {
    complete?: CompleteFn;
    strict?: boolean;
    k?: number;
    turnId?: string;
    sessionId?: string;
  } = {},
): Promise<AskResult> {
  const k = opts.k ?? 8;
  const hits = searchVector(db, question, { k, model: MINILM_MODEL });

  const passages = hits.map((h, i) => ({
    index: i + 1,
    documentId: h.documentId,
    sourceRef: h.sourceRef,
    title: h.title,
    body: h.body,
    snapshotHash: h.snapshotHash,
  }));

  if (passages.length === 0) {
    const total = (
      db.prepare(`SELECT count(*) AS c FROM vector_document`).get() as {
        c: number;
      }
    ).c;
    return {
      answer: "",
      claims: [],
      passages: [],
      modelCalled: false,
      note:
        total === 0
          ? "nothing ingested yet — run `chamber ingest <path>`"
          : "nothing in the corpus matches this question",
    };
  }

  const prompt = buildPrompt(question, passages);
  const answer = opts.complete
    ? await opts.complete(prompt)
    : (
        await complete(db, {
          messages: [{ role: "user", content: prompt }],
          channel: "chat",
          turnId: opts.turnId,
          sessionId: opts.sessionId,
        })
      ).text;

  const byIndex = new Map(passages.map((p) => [p.index, p]));
  const claims = classifyClaims(answer);
  const out: AskClaimResult[] = [];

  for (const claim of claims) {
    const indices = citedIndices(claim.text);
    const citedRefs: string[] = [];
    const rejected: { refId: string; reason: string }[] = [];
    const sources: {
      kind: "vault_page";
      refId: string;
      snapshotHash: string;
      provenance: "vector";
    }[] = [];

    for (const n of indices) {
      const p = byIndex.get(n);
      if (!p) {
        rejected.push({ refId: `[${n}]`, reason: "index_out_of_range" });
        continue;
      }
      const verdict = verifyPin(db, {
        kind: "vault_page",
        refId: p.documentId,
        snapshotHash: p.snapshotHash,
      });
      if (!verdict.ok) {
        rejected.push({ refId: p.documentId, reason: verdict.reason! });
        continue;
      }
      citedRefs.push(p.documentId);
      sources.push({
        kind: "vault_page",
        refId: p.documentId,
        snapshotHash: p.snapshotHash,
        provenance: "vector",
      });
    }

    const r = enforceClaimContract(db, claim, {
      sources,
      strict: opts.strict,
      turnId: opts.turnId,
      sessionId: opts.sessionId,
    });

    out.push({
      text: claim.text,
      kind: claim.kind,
      status: r.status,
      citedRefs,
      rejected,
      debtIds: r.debtIds ?? [],
    });
  }

  return {
    answer,
    claims: out,
    passages: passages.map((p) => ({
      index: p.index,
      documentId: p.documentId,
      sourceRef: p.sourceRef,
    })),
    modelCalled: true,
  };
}
```

- [ ] **Step 5: Run and watch them pass**

Run: `npm run test -- --suite=pins`
Expected: all `pins` tests pass, including the three new async ones

- [ ] **Step 6: Add the CLI command**

Import `runAsk` from `./ask.ts` and `spendLastHours`/`formatSpendFooter` are already imported in `src/cli.ts`. Add:

```typescript
    case "ask": {
      const strict = rest.includes("--strict");
      const q = rest.filter((a) => !a.startsWith("--")).join(" ").trim();
      if (!q) {
        console.error('usage: chamber ask "<question>" [--strict]');
        process.exitCode = 1;
        break;
      }
      const r = await runAsk(db, q, { strict });
      if (!r.modelCalled) {
        console.log(r.note ?? "no passages retrieved");
        break;
      }
      console.log(`\n${r.answer}\n`);
      const refToPath = new Map(
        r.passages.map((p) => [p.documentId, p.sourceRef ?? p.documentId]),
      );
      for (const c of r.claims) {
        if (c.kind === "chatter") continue;
        const cites = c.citedRefs.map((id) => refToPath.get(id) ?? id).join(", ");
        console.log(`  [${c.status}] ${c.text.slice(0, 70)}`);
        if (cites) console.log(`     sources: ${cites}`);
        for (const rj of c.rejected) {
          console.log(`     rejected ${rj.refId}: ${rj.reason}`);
        }
        if (c.debtIds.length) {
          console.log(`     debt: ${c.debtIds.join(", ")}`);
        }
      }
      console.log(`\n${formatSpendFooter(spendLastHours(db, 24))}`);
      break;
    }
```

Add to `help()`: `  ask "<question>" [--strict]        answer from the corpus with verified pins`

- [ ] **Step 7: Verify the full suite and the command shape**

Run: `npm run test`
Expected: 112/112 passed, 0 failed

Run: `node --experimental-strip-types src/cli.ts ask "what is chamber"`
Expected: with an empty corpus, prints `nothing ingested yet — run \`chamber ingest <path>\``, exit 0

- [ ] **Step 8: Commit**

```bash
git add src/ask.ts src/cli.ts tests/harness.ts
git commit -m "feat: add chamber ask with a citation gate

Retrieves passages, numbers them, and has the model cite numbers rather
than identifiers. Index-to-id and id-to-hash mapping happen locally, so
the model can neither invent a document id nor supply a hash.

Each claim is dispatched through enforceClaimContract individually with
only its own cited sources; enforceReplyContract would have applied one
source list to every claim in the reply.

Zero retrieved passages skips the model entirely rather than inviting
confident fabrication at cost.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `chamber verify` — longitudinal drift

The capability the whole spec exists for. Everything before this proves plumbing; this proves the product.

**Files:**
- Modify: `src/pins.ts` (add `verifyBeliefSources`)
- Modify: `src/cli.ts` (new `case "verify"`, help text)
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `verifyPin` from Task 2, `ingestDirectory` from Task 5
- Produces:
  ```typescript
  export interface BeliefDrift {
    beliefId: string;
    content: string;
    total: number;
    verified: number;
    failures: { refId: string; reason: PinFailure; sourceRef?: string | null }[];
  }
  export function verifyBeliefSources(
    db: DatabaseSync,
    opts?: { since?: string },
  ): BeliefDrift[];
  ```

- [ ] **Step 1: Write the failing test — this is success criterion 5**

```typescript
test("pins", "verify detects a belief whose source drifted after re-ingest", async () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "chamber-drift-"));
  const file = join(dir, "policy.md");
  writeFileSync(file, "Retention policy is 90 days.\n");
  ingestDirectory(db, dir);

  const fake = async () => "Retention policy is 90 days. [1]";
  const asked = await runAsk(db, "what is the retention policy", {
    complete: fake,
  });
  assert(
    asked.claims.some((c) => c.citedRefs.length > 0),
    "setup failed: expected at least one cited claim",
  );

  const clean = verifyBeliefSources(db);
  assert(
    clean.every((b) => b.failures.length === 0),
    "before editing, every pin should verify",
  );

  writeFileSync(file, "Retention policy is 30 days.\n");
  ingestDirectory(db, dir);

  const drifted = verifyBeliefSources(db);
  const bad = drifted.filter((b) =>
    b.failures.some((f) => f.reason === "hash_mismatch"),
  );
  assert(
    bad.length > 0,
    "after editing and re-ingesting, the belief's pin must report hash_mismatch",
  );
});
```

Add `verifyBeliefSources` to the `tests/harness.ts` imports from `../src/pins.ts`.

- [ ] **Step 2: Run and watch it fail**

Run: `npm run test -- --suite=pins`
Expected: FAIL — `verifyBeliefSources is not a function`

- [ ] **Step 3: Add `verifyBeliefSources` to `src/pins.ts`**

```typescript
export interface BeliefDrift {
  beliefId: string;
  content: string;
  total: number;
  verified: number;
  failures: { refId: string; reason: PinFailure; sourceRef?: string | null }[];
}

/**
 * Re-check every stored pin against the current corpus.
 *
 * This is where verification stops being tautological: the pin was written
 * when the belief was committed, and the corpus has moved since.
 */
export function verifyBeliefSources(
  db: DatabaseSync,
  opts: { since?: string } = {},
): BeliefDrift[] {
  const rows = db
    .prepare(
      `SELECT b.id AS belief_id, b.content AS content,
              s.kind AS kind, s.ref_id AS ref_id, s.snapshot_hash AS snapshot_hash
         FROM belief b
         JOIN belief_source s ON s.belief_id = b.id
        WHERE (? IS NULL OR b.created_at >= ?)
        ORDER BY b.created_at DESC`,
    )
    .all(opts.since ?? null, opts.since ?? null) as {
    belief_id: string;
    content: string;
    kind: string;
    ref_id: string;
    snapshot_hash: string;
  }[];

  const byBelief = new Map<string, BeliefDrift>();
  for (const r of rows) {
    let entry = byBelief.get(r.belief_id);
    if (!entry) {
      entry = {
        beliefId: r.belief_id,
        content: r.content,
        total: 0,
        verified: 0,
        failures: [],
      };
      byBelief.set(r.belief_id, entry);
    }
    entry.total += 1;
    const verdict = verifyPin(db, {
      kind: r.kind,
      refId: r.ref_id,
      snapshotHash: r.snapshot_hash,
    });
    if (verdict.ok) entry.verified += 1;
    else {
      entry.failures.push({
        refId: r.ref_id,
        reason: verdict.reason!,
        sourceRef: verdict.sourceRef,
      });
    }
  }
  return [...byBelief.values()];
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run test -- --suite=pins`
Expected: all pass, including the drift test

- [ ] **Step 5: Add the CLI command**

Import `verifyBeliefSources` from `./pins.ts` in `src/cli.ts` and add:

```typescript
    case "verify": {
      const i = rest.indexOf("--since");
      const since = i >= 0 ? rest[i + 1] : undefined;
      const report = verifyBeliefSources(db, { since });
      let broken = 0;
      for (const b of report) {
        if (b.failures.length === 0) continue;
        broken += b.verified === 0 ? 1 : 0;
        console.log(`${b.beliefId}  ${b.verified}/${b.total} pins verified`);
        console.log(`  "${b.content.slice(0, 70)}"`);
        for (const f of b.failures) {
          const where = f.sourceRef ? ` (${f.sourceRef})` : "";
          const hint =
            f.reason === "hash_mismatch"
              ? " — note changed since commit; re-run `chamber ingest`"
              : "";
          console.log(`  ${f.reason}: ${f.refId}${where}${hint}`);
        }
      }
      console.log(
        `\n${report.length} belief(s) checked, ${broken} with no verified support left`,
      );
      if (broken > 0) process.exitCode = 1;
      break;
    }
```

Add to `help()`: `  verify [--since <ISO date>]        re-check stored pins against the corpus`

- [ ] **Step 6: Verify the full suite**

Run: `npm run test`
Expected: 113/113 passed, 0 failed

Run: `node --experimental-strip-types src/cli.ts verify`
Expected: `0 belief(s) checked, 0 with no verified support left`, exit 0

- [ ] **Step 7: Commit**

```bash
git add src/pins.ts src/cli.ts tests/harness.ts
git commit -m "feat: add chamber verify for longitudinal pin drift

Within a single ask, pin verification is close to tautological — the
hash is read off a row and checked against that same row moments later.
Its real value is over time: a belief committed today stores a pin that
stops matching when the underlying note is edited and re-ingested.

verify re-checks every stored pin against the current corpus and exits
non-zero when a belief has no verified support left, so it works as a
scheduled health check. It reports only; acting on drift is a human
decision.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Manual acceptance (not CI)

After Task 7, run the real thing once. This is the demo, and the only step that uses a live model.

```bash
export CHAMBER_MODEL=openai
export CHAMBER_API_BASE=https://api.anthropic.com/v1   # or an LM Studio URL
export CHAMBER_API_KEY=...                             # from ~/.secrets, never committed
export CHAMBER_DB=~/chamber.sqlite

node --experimental-strip-types src/cli.ts ingest "$HOME/Vault/10 - Infrastructure"
node --experimental-strip-types src/cli.ts ask "what did I decide about the audit store"
# edit one of the ingested notes, then:
node --experimental-strip-types src/cli.ts ingest "$HOME/Vault/10 - Infrastructure"
node --experimental-strip-types src/cli.ts verify
```

Expected: the answer cites vault paths; the spend footer is non-zero; after the edit, `verify` reports `hash_mismatch` for the belief that rested on the edited note.

## Spec coverage

| Spec requirement | Task |
|---|---|
| `chamber ingest`, idempotent, exclude list | 5 |
| `chamber ask` pipeline, per-claim contract dispatch | 6 |
| `chamber verify` longitudinal drift | 7 |
| `src/pins.ts` `verifyPin`, per-kind formula registry | 2 |
| Pin verification inside `commitBelief`; debt on zero verified | 3 |
| `ContractSource` provenance passthrough | 4 |
| `getHarness` fails closed | 1 |
| Zero-hit path never calls the model | 6 (test 2) |
| `--strict` upgrades debt to refusal | 6 |
| Success criteria 1–4, 6–7 | 5, 6, 3, 1 |
| Success criterion 5 (the longitudinal check) | 7 (test 1) |

**Deliberately deferred from the spec's error-handling section:** the request timeout on `src/model.ts`. `runAsk` passes through `complete()`, which has no timeout; adding one touches the shared model path and belongs with the Phase 2A async work rather than here. Until then a hung endpoint hangs `chamber ask`, which is survivable for a manually-invoked CLI command and is not survivable for the agent loop — which is exactly why it belongs there.
