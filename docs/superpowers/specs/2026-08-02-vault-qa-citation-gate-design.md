# Vault Q&A with a real citation gate — design

**Date:** 2026-08-02
**Status:** approved, ready for planning
**Scope:** one implementation plan, roughly a week of evenings

## Goal

Make Chamber govern one real turn on one real job: answering questions about the owner's vault, where every load-bearing claim carries a content pin that can be verified — and, crucially, can later be found to have *expired*.

This is deliberately not the agent loop from `docs/NEXT_LEVEL_PLAN.md` Phase 2A. There is no tool-call protocol, no model-driven control flow, and no capability system. The CLI orchestrates a fixed pipeline; the model only writes prose and cites passage numbers.

## Why this shape

Community research (`~/Vault/10 - Infrastructure/research/2026-08-02__agent-community-needs.md`) found that narrow, single-purpose jobs survive daily use while general assistants are abandoned, and that building infrastructure instead of using it is a top-six cause of agent-project death. Chamber is ~16k LOC with zero turns ever run. This spec is the shortest path from that state to something used daily.

It also defers every problem that research flagged as hard. Prose citations need no strict JSON envelope, so grammar-constrained decoding stays out of scope. A miscited passage produces *citation debt* — the designed artifact — rather than a parse failure, so the fragile part degrades into the feature.

## Success criteria

Each is a runnable check, not a judgement.

1. `chamber ingest ~/Vault/10\ -\ Infrastructure` populates `vector_document` with `source_kind='vault_page'` rows, and re-running it updates in place rather than duplicating (row count stable).
2. `chamber ask "<question answerable from the corpus>"` prints an answer whose assertions carry vault paths, and `SELECT count(*) FROM citation_debt WHERE status='pending'` does not increase.
3. `chamber ask "<question the corpus cannot answer>"` either yields an aporia claim or mints blocking debt — never a confident unsourced assertion.
4. A fabricated pin cannot pass the gate: `probes/pin_bypass.ts` exits non-zero.
5. **The longitudinal check.** Ask a question, commit a belief, edit the underlying vault note, re-run `chamber ingest`, then `chamber verify` reports that belief's support as `hash_mismatch`.
6. Every `chamber ask` run emits a spend footer with non-zero cost.
7. `npm run check` stays green.

Criterion 5 is the one that matters. Criteria 1–4 prove the plumbing; 5 proves the capability no competitor was found to have.

## Architecture

Three commands, one new module, and two small changes to existing gates (`commit_belief.ts` for pin verification, `contract.ts` to stop dropping provenance).

```
chamber ingest <path>      markdown files ──> vector_document + vector_embedding
chamber ask "<question>"   question ──> retrieve ──> model ──> verify ──> contract ──> render
chamber verify [--since]   belief_source rows ──> re-check pins ──> drift report
```

### The invariant

The model is never trusted to be correct, only to be **checkable**.

It sees passages numbered `[1]`…`[8]` and cites those numbers. It never sees or emits a document id, and never sees or emits a hash. Index-to-id mapping and hash lookup happen locally. This closes both forgery routes by construction: the model cannot invent an identifier it never saw, and cannot supply a hash at all.

What remains — citing a real passage that does not actually support the claim — is a relevance problem no pin system solves. This design does not pretend to solve it and must not be described as if it does.

### Where verification actually earns its keep

Within a single `ask`, pin verification is nearly tautological: the hash is read off a row and then checked against that same row moments later. It can only catch a fabricated index or direct database tampering.

Verification does real work **longitudinally**. A belief committed today stores pin `H₀` in `belief_source`. When the note is edited and re-ingested, `vector_document` now hashes to `H₁`. `chamber verify` recomputes and finds `H₀ ≠ H₁` — the belief's evidentiary support has silently expired. This is the product.

## Components

### `src/pins.ts` (new)

```
verifyPin(db, source: { kind, refId, snapshotHash })
  -> { ok: true } | { ok: false, reason: "not_found" | "hash_mismatch", actualHash?: string }
```

Looks up `vector_document` by `refId`, recomputes `sha256([title ?? "", body, sourceRef ?? ""].join("\n"))` — byte-identical to the formula `upsertDocument` uses at `src/vector.ts:131-133` — and compares. Pure lookup: no network, no model, safe inside a gate transaction.

The two failure reasons are semantically different and must stay distinct. `not_found` means the model named something that never existed, or the source was deleted from the corpus. `hash_mismatch` means the corpus drifted underneath a belief. Only the first is the model's fault, and conflating them makes the tool feel accusatory during normal vault editing.

Only `kind: 'vault_page'` is supported in this iteration. Other kinds return `not_found` with a reason noting the kind is unregistered, so adding kinds later is additive.

Depends on: `node:sqlite`, `src/hash.ts`.

### `src/commit_belief.ts` (modified)

Two changes, both small, both closing the defect `probes/pin_bypass.ts` demonstrates.

- `src/commit_belief.ts:107` currently rejects only on a falsy `snapshotHash`. Replace the truthiness check with `verifyPin`, collecting results.
- `src/commit_belief.ts:241` currently mints debt when `sources.length === 0`. Change to `verifiedSources.length === 0`.

Unverified sources are dropped from `belief_source` rather than written, and the rejection reasons are returned on the result so callers can display them. Verification happens **inside the gate**, so every caller gets it — not only the `ask` pipeline. The pipeline's own pre-verification (below) exists for error messages, not for security.

`commit_belief.ts` does not import `faculty.ts`, and `committed_path` is only a stored label plus one invariant (`belief`-typed commits may not use `fast`, `src/commit_belief.ts:98`). So this change pulls in no deliberation and no async work.

### `chamber ingest <path>` (new command)

Walks a directory for `.md` files and calls the existing `upsertDocument` per file with `source_kind: 'vault_page'`, `sourceRef` set to the path relative to the ingest root, `title` from YAML frontmatter `title:` if present else the filename stem, and `body` set to the file contents with frontmatter stripped.

`sourceRef` is the identity key: re-ingesting the same relative path updates in place. Files that cannot be read are skipped and reported per-file; one unreadable file never aborts the run.

Takes `--exclude <glob>` (repeatable) with a default exclude list covering the vault folders denied in `~/.claude/settings.json`. The tool must not be the thing that quietly copies a deny-listed folder into a database.

Depends on: `src/vector.ts`, `node:fs`.

### `chamber ask "<question>"` (new command)

1. `searchVector(db, question, { k: 8, model: MINILM_MODEL })`.
2. If zero hits: print "nothing ingested yet, run `chamber ingest`" for an empty corpus, or "nothing in the corpus matches" otherwise. **Return without calling the model.** Calling a model with no context produces confident fabrication and costs money.
3. Build one user message with each passage rendered as `[n] <title> (<sourceRef>)\n<body>`, plus instructions: answer only from these passages, cite `[n]` inline after each claim, say you don't know if the passages don't answer it.
4. `await complete(...)` through `getHarness(...)`. Request timeout from `CHAMBER_TURN_DEADLINE_MS`, default 120000.
5. `classifyClaims(answer)` (`src/contract.ts`) splits the reply into claims.
6. Per claim: extract `[n]` markers, map each index to that retrieval hit's `id` and `snapshot_hash`, build sources with `kind: 'vault_page'` and `provenance: 'vector'`, and `verifyPin` each for display purposes.

   **Required small change:** `SourceRef` carries `provenance` (`src/types.ts:62`) and `commitBelief` writes it (`src/commit_belief.ts:233`), but `ContractSource` (`src/contract.ts:24-29`) omits the field, so routing sources through the contract layer silently drops it. Add `provenance?` to `ContractSource` and pass it through in the mapping at `src/contract.ts:86-91`. Without this, every `belief_source` row lands with `provenance = NULL` and there is no record of which retriever produced the evidence.
7. Per claim: `enforceClaimContract(db, claim, { sources, sessionId, turnId, strict })`. This is the commit path — it calls `commitBelief` internally (`src/contract.ts:97,123,169`), so the pipeline must not call `commitBelief` separately.
8. Render: the answer, per-claim status (`ALLOWED` / `DEBT` / `REFUSED` / `APORIA`), cited vault paths, rejected citations with reasons, minted debt ids, and the spend footer.

Per-claim dispatch via `enforceClaimContract` is deliberate. `enforceReplyContract` applies one source list to every claim in the reply, which would give a claim citing `[3]` credit for `[5]` as well.

`--strict` passes `strict: true`, upgrading unsourced assertions from debt to refusal. Default is debt: for daily use you want the answer plus a visible IOU. Strict is for demos and anything consequential.

Depends on: `src/vector.ts`, `src/model.ts`, `src/harness_adapter.ts`, `src/contract.ts`, `src/pins.ts`, `src/spend.ts`.

### `chamber verify [--since <ISO date>]` (new command)

Selects `belief_source` rows joined to their beliefs, optionally filtered by belief `created_at`, and runs `verifyPin` on each. Reports per belief: total sources, verified, `not_found`, `hash_mismatch`, and the vault paths involved. Exits non-zero if any belief has zero remaining verified sources, so it is usable as a scheduled health check.

This command does not mutate anything. Acting on drift — re-evaluation tickets, suspension, debt — is deliberately out of scope; see Non-goals.

Depends on: `src/pins.ts`, `node:sqlite`.

## Data flow

```
ingest:  file ──upsertDocument──> vector_document{id, source_ref, title, body, snapshot_hash}
                                             │
ask:     question ──searchVector──> hits[8] ─┤
                                             ├──> prompt "[1]..[8]" ──> model ──> prose with [n]
                                             │
              per claim: [n] ──index map──> {refId: hit.id, snapshotHash: hit.snapshot_hash}
                                             │
                          ──verifyPin──> verified[] ──enforceClaimContract──> commitBelief
                                                                                   │
                                                              belief + belief_source{snapshot_hash}
                                             │
verify:  belief_source ──verifyPin against current vector_document──> ok | not_found | hash_mismatch
```

The pin written to `belief_source` at commit time is the value that later goes stale. That single stored hash is what makes criterion 5 possible.

## Error handling

**Stale pins are not fabrications.** `hash_mismatch` on an existing row means the note changed since ingest; the message says so and suggests re-ingesting. `not_found` means a hallucinated or deleted reference. Both fail to count as verified support — a pin that does not match cannot back a load-bearing claim — but they read completely differently.

**Fail before spending.** Zero hits skips the model entirely (step 2 above).

**Fail loudly, never plausibly.** A missing API key, unreachable endpoint, or unknown harness id is a hard error. `getHarness` must throw on an unknown id rather than silently returning the stub — canned stub output that looks like a real answer is worse than a crash. This is the `NEXT_LEVEL_PLAN.md` Phase 1.5 item, pulled forward because this spec depends on it.

**Timeouts.** `src/model.ts` has no request timeout; `ask` sets one and treats expiry as a failed turn with no commit.

**Ingest.** Unreadable files are skipped with a per-file report. Re-ingest updates in place.

**Blocked commits.** If a claim is blocked by pre-existing debt on the same claim hash, that is the gate working: surface it as a refusal naming the blocking debt ids. Debt is keyed on claim hash, so re-asking a question is only blocked if the model reproduces the identical assertion text — rephrasing or answering better is not blocked.

## Testing

Added to `tests/harness.ts`, all runnable without a live model by injecting a scripted harness and pre-computed embeddings.

1. **verifyPin returns ok** for a document round-tripped through `upsertDocument`.
2. **verifyPin returns `not_found`** for an unknown `refId`.
3. **verifyPin returns `hash_mismatch`** after the stored body is mutated directly.
4. **Gate rejects a fabricated pin**: `commitBelief` with a made-up `snapshotHash` mints blocking debt rather than committing clean. This is `probes/pin_bypass.ts` as an assertion.
5. **Ingest is idempotent**: ingesting a fixture directory twice leaves the row count unchanged and the snapshot hash stable.
6. **Zero-hit path never calls the model**: scripted harness records invocation; assert zero calls on an empty corpus.
7. **Per-claim source mapping**: a two-claim answer citing `[1]` and `[2]` respectively produces two beliefs with one source each, not two sources each.
8. **Longitudinal drift**: commit a belief from an ingested doc, mutate and re-ingest the doc, assert `verify` reports `hash_mismatch` for that belief.

Test 8 covers success criterion 5 and is the one that must not be skipped.

## Non-goals

Explicitly out of scope, to keep this to one plan:

- The agent loop, tool-call protocol, and `authorizeToolCall` — that is Phase 2A.
- Capability levels and XP — deferred, and the research found no demand for the durable-XP form.
- Sandbox work — no tools run here, so nothing executes model-generated code.
- Local model serving — cloud first to isolate failures; `harness_adapter.ts` makes the swap a one-line change later.
- Acting on drift automatically (suspension, re-evaluation tickets, debt on stale sources). `verify` reports; a human decides. Automating this before seeing real drift patterns would be guessing.
- Session FTS as a pinnable source. Only `vector_document` is verifiable in this iteration.
- Telegram or any surface other than the CLI.

## Open risks

- **Retrieval quality is unmeasured.** If `searchVector` at `k=8` returns weak passages, answers will be poor for reasons unrelated to governance. First real use will show this; the fix would be chunking strategy, not gate design.
- **`classifyClaims` is a regex heuristic.** Its assertion pattern (`is/are/was/must/never` and length > 20) will mis-split some answers. Acceptable for one job; revisit only if it misfires in practice.
- **Cloud cost per question is unknown** until measured. The spend footer exists precisely to surface it from turn one.
