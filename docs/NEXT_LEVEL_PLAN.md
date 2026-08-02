# Chamber — from governance kernel to governed agent

## Context

Chamber (built with Grok, currently a loose zip in `~/Downloads/chamber-export.zip`) is ~16k LOC of dependency-free TypeScript on `node:sqlite`. Its governance substrate is genuinely strong: citation debt, faculty parliament, skill holds with shadow/teeth modes, capability manifests, hash-chained audit + incremental MMR, approvals with idempotency and conflict handling, scopes with strict-wins policy inheritance. 99/99 tests pass.

Two problems block the next level.

**1. The constitution isn't true yet.** A code review with live probes found the enforcement layer doesn't match the docs:

- `CHAMBER_SANDBOX_REQUIRED=1` is a no-op. `detectSandboxBackend()` (`src/sandbox.ts:60`) can never return `"none"`, so the fail-closed branch at `src/sandbox.ts:204` is unreachable. Probed on this machine: model-generated code read `$HOME`, saw `~/.ssh` and `~/.secrets`, **wrote a file to `$HOME`**, and resolved DNS — while `detectSandboxBackend()` reported `"docker"` and never invoked docker.
- The two flagship gates aren't in the audit chain. `commit_belief.ts` and `try_activate_skill.ts` write only to the unchained `gate_event` table; 16 other modules call `appendAudit`. Live run: 4 `gate_event` rows, **0 `audit_event` rows**.
- The citation gate is `sources.length > 0`. A consequential medical falsehood committed clean with zero debt on a pin of `snapshotHash: "aaaa"` pointing at a nonexistent URL. Nothing verifies a pin resolves or matches content.
- `sealSecret` (`src/secret_box.ts:34`) stores plaintext unless *both* `NODE_ENV=production` and `CHAMBER_REQUIRE_TOKEN_KEY=1`; the shipped Dockerfile sets only the first.
- No `tsconfig.json`, no linter, no CI. `--experimental-strip-types` strips types without checking them: **91 errors** under `tsc --strict`, including a real discriminated-union misuse in the strict-contract path (`src/contract.ts:109,181`) and a duplicate import in `src/cli.ts`.

**2. There is no agent.** `cli.ts` `turn` is a regex demo — `wantsMemory` / `wantsSkill` / `wantsBelief` (`src/cli.ts:202-208`) decide everything, then one deterministic stub completion runs. `runTool` exists but no model ever calls it. `tryActivateSkill` is sophisticated and never invoked from a turn. Chamber has excellent gates with nothing driving them.

**Outcome:** a daily-driver agent on CLI + Telegram, local-first (LM Studio) with cloud escalation, where a capability-level system grants the local model progressively more autonomy earned through verified outcomes. Autonomy is only safe if the gates are real — hence the ordering below.

**Hard gate:** no capability level above L0 ships until the Phase 1 sandbox negative tests pass. Levels grant autonomy; autonomy on a fake sandbox is the failure mode this whole project exists to prevent.

### Refinement pass — what live probing changed

Four claims in the first draft were wrong or unfounded. Each was corrected against a measurement, not an assumption:

1. **Sandbox backends aren't interchangeable.** docker blocks reads of `$HOME`; macOS seatbelt does **not**, and a `(deny default)` profile aborts Node outright (SIGABRT, exit 134). Both verified live. Seatbelt is now a declared *degraded* tier, not a peer of docker.
2. **Pin verification must be a corpus lookup, not a refetch.** `vector_document` already stores `body` + `snapshot_hash` for this purpose. Refetching live URLs would make gate outcomes non-deterministic and put network I/O inside a transaction.
3. **Phase 0 was overestimated.** The 91 type errors are not "mostly casts" — 38 are a single `assert()` signature in the test harness. Only ~11 are genuine.
4. **The debt lifecycle already has a `proposed_paid` state** and a `pays_subclaim` column, both unused. Phase 3 now uses the schema as designed instead of inventing a parallel flow.

The pattern across all four: this codebase's *schema* is consistently better than its *code*. Several gaps are unimplemented intent, not bad design — which makes them cheaper to close than the review's severity suggested.

---

## Phase 0 — Repo baseline and validation gate

Nothing else is safe to start until the tree is under version control and type-checked.

1. Extract `~/Downloads/chamber-export.zip` (the canonical source) to `~/Projects/chamber`. `git init`, commit the tree verbatim as the baseline **before any edit**. Local only, no remote.
2. Add `.gitignore` (`*.sqlite`, `node_modules`, `.env`, `pilot.jsonl`, `models/` if the 23MB ONNX should stay out).
3. Add `tsconfig.json`: `strict`, `target es2022`, `module nodenext`, `allowImportingTsExtensions`, `noEmit`. Add `@types/node` and `typescript` as devDependencies — **runtime stays zero-dependency**, which is one of Chamber's genuine strengths and must not erode. Any future runtime dependency is a decision, not a convenience.
4. Add `npm run typecheck` and `npm run check` (= typecheck + test). **`npm run check` is the validation gate for every phase below** — run it before and after each change.
5. Clear all 91 type errors. **Measured breakdown — this is much smaller than it looks:**

   | Count | Code | What it is | Fix |
   |-------|------|-----------|-----|
   | 38 | TS2554 | **All in `tests/harness.ts`** — `assert(x)` called against a 2-arg signature | Make the `message` param optional. **One line clears 38.** |
   | 18+7 | TS7031/TS7006 | Implicit `any`, mostly discord.js callbacks | Type the callbacks |
   | 13 | TS2352 | `.all() as Row[]` array casts | `rows<T>()` helper in `src/db.ts` casting through `unknown` once |
   | 5 | TS2339 | Property missing — includes the real `CommitResult` union misuse at `src/contract.ts:109,181` | Narrow before access |
   | 4 | TS2307 | `discord.js` not declared | Add to `optionalDependencies` |
   | 4+2 | TS2345/TS2300 | Arg mismatch; duplicate `listPendingQueue` at `src/cli.ts:26,95` | By hand |

   Only ~11 are genuine logic-level type defects. The rest are signature and declaration hygiene.

**Exit:** `npm run check` green, 0 type errors, baseline commit exists.

> **Status:** Phase 0 steps 1–2 are **done** — `~/Projects/chamber` exists as its own git repo, baseline commit `a49f4c5`, 121 files, suite verified 99/99 from the new location. Secret-scanned before commit (only synthetic scanner fixtures). The 22MB `models/minilm/model_quantized.onnx` is tracked deliberately so the repo clones and passes self-contained; revisit only if a remote is ever added. Steps 3–5 remain.

---

## Phase 1 — Make the constitution true

### 1.1 Real sandbox with real fail-closed

`src/sandbox.ts` is the highest-severity item. Model-generated code runs here.

**Backends are NOT interchangeable — verified live on this machine, not assumed:**

| Backend | Network | Write outside workdir | **Read `$HOME` / `~/.secrets`** | Status |
|---------|---------|----------------------|-------------------------------|--------|
| `docker` | blocked | blocked | **blocked** (nothing mounted) | daemon 29.6.2 up; `--network none` verified |
| `seatbelt` (macOS `sandbox-exec`) | blocked | blocked | **STILL READABLE** | verified: `net: BLOCKED`, `homeWrite: BLOCKED`, `sshRead: true` |
| `subprocess` | open | open | open | not a sandbox |

This is the correction that matters most. A naive `(deny default)` seatbelt profile **aborts Node with SIGABRT** (exit 134, verified) — Node can't boot under it. The profile that works is `(allow default)` + `(deny network*)` + `(deny file-write*)` with a workdir allow, and that leaves **reads of `~/.ssh` and `~/.secrets` wide open**. Probing only write+network would have declared victory while the read escape survived — verify the class, not the site.

Therefore:

- **`docker` is the required backend for any tool above read-only class.** Seatbelt is a *degraded* backend: acceptable for `compute`-class tools where exfiltration (network) and tampering (write) are the threats, never for anything handling secrets — because on this machine `~/.secrets` exists and stays readable under it.
- `SandboxResult.backend` reports the backend that **actually ran**, and gains an `isolation: "full" | "no-network-no-write" | "none"` field. Evidence must never claim isolation it didn't have. Remove the relabel-to-`"subprocess"` lie at `src/sandbox.ts:232`.
- `detectSandboxBackend()` returns `"none"` when neither docker nor seatbelt is usable. `"subprocess"` becomes selectable only via explicit `CHAMBER_SANDBOX_INSECURE=1` and reports `backend: "insecure_subprocess"`, `isolation: "none"`.
- `CHAMBER_SANDBOX_REQUIRED=1` refuses when resolved isolation is not `"full"`.
- Docker invocation: `docker run --rm --network none --read-only --memory 512m --pids-limit 128 -v <workdir>:/work:rw -w /work --user <uid> node:22-slim`.
- **Known implementation detail:** the seatbelt workdir allow rule returned `EPERM` in probing (`workdirWrite: "BLOCKED:EPERM"`). The profile needs tuning — likely `/private/var/folders` vs the real `mkdtemp` path, or param-substitution in `(subpath (param "WORKDIR"))`. Solve before shipping seatbelt as a backend.

**Negative tests (new — these are the point):** per backend, assert network blocked, write-outside-workdir blocked, and — for docker — `$HOME` unreadable. Assert `CHAMBER_SANDBOX_REQUIRED=1` + `backend=none` refuses. Assert seatbelt reports `isolation: "no-network-no-write"` and is **rejected** for secret-handling tool classes. Reproduce the original escape probe as a regression test asserting it now fails. Existing tests only assert `echo` works — that is the defect class being fixed.

### 1.2 Gates into the audit chain

`commitBelief` and `tryActivateSkill` both already own a `BEGIN IMMEDIATE` transaction. Call `appendAuditInTx` (`src/audit.ts:168`) inside it — check and tamper-evident write commit together, which is what the README's invariant claims. Keep `emitGate` for the queryable gate view.

### 1.3 Pin verification

**Verification is a corpus lookup, not a refetch.** The schema already anticipated this: `vector_document` stores `body` *and* `snapshot_hash`, commented "Content pin for citation debt payment (same rules as belief_source)". `belief_source` already carries `span_hash` (exact quoted span) and `context_hash` (±N tokens) alongside `snapshot_hash`. The pinning model was designed correctly and simply never implemented.

New `src/pins.ts`: `verifyPin(db, source): {ok, actualHash?, reason?}` — look up the stored content by `refId` / `snapshot_hash` in the local corpus (`vector_document`, `session`, `code_index`, `belief`), re-hash the stored `body`, compare. **No network, no refetch, fully deterministic, safe inside the gate transaction.**

Semantics: *you may only cite what you actually retrieved and stored*. A URL never ingested has no snapshot → unverifiable → debt. This avoids the trap of refetching a live URL whose content drifts, which would make gate outcomes non-deterministic and put network I/O inside a transaction.

In `commitBelief`, replace the truthiness check (`src/commit_belief.ts:107`) with verification, and change the debt-mint condition (`src/commit_belief.ts:241`) from `sources.length === 0` to `verifiedSources.length === 0`. Unverifiable or mismatched pin → **mint blocking debt** rather than pass. Ingest (which does touch the network) stays where it belongs: the job queue, ahead of any commit.

### 1.4 Fail-closed cleanups

- `sealSecret`: throw when no key unless `CHAMBER_ALLOW_PLAINTEXT_SECRETS=1`. Add `CHAMBER_REQUIRE_TOKEN_KEY=1` to `deploy/Dockerfile`. Replace bare `sha256(passphrase)` with `scrypt` + a salt stored alongside.
- `src/db.ts:49`: delete the silent `/tmp/chamber.sqlite` → `:memory:` fallback. An audit database that silently becomes amnesiac is worse than one that fails to open.
- `src/audit.ts:71`: `chainEnabled()` is computed and discarded — either honour `audit.chain_enabled` or delete the key.
- `src/audit.ts:100`: replace exception-driven transaction detection (`try { BEGIN IMMEDIATE } catch { assume in TX }`) with an explicit `opts.inTx` flag. `SQLITE_BUSY` currently gets misread as "already in a transaction" and the append runs in autocommit — breaking the one-transaction invariant.
- Anchor checkpoints: `exportCheckpoint` already produces a receipt. Add a signature (`CHAMBER_CHECKPOINT_KEY`, ed25519) so the chain is tamper-evident against someone with DB write access, not just against corruption.

**Exit:** negative sandbox tests pass; escape probe fails; `commit_belief` + `try_activate_skill` emit `audit_event` rows; a fabricated pin mints blocking debt; `npm run check` green.

---

## Phase 2 — Gated agent loop

New `src/agent.ts` — `runAgentTurn(db, {message, scopeId, sessionId, turnId})`. This replaces the regex block at `src/cli.ts:202-310`.

**Loop:** build context → model completes → parse tool calls → authorize each → execute → feed results back → repeat to `CHAMBER_MAX_STEPS` (default 6) → final reply through `enforceReplyContract`.

- **Tool-call protocol:** strict JSON `{reasoning, tool_calls:[{name, args}], final?}`. Parse failure retries once with the parse error appended, then refuses. Local models need this rigidity — it's why the parse/retry layer is explicit rather than assumed.
- **Authorization:** new `authorizeToolCall(db, scopeId, tool, args)` — the single dispatcher chokepoint. Checks capability level (Phase 5), scope posture via `effectivePolicy` (`src/scope.ts:76`), tool risk class, and the active skill's `capability_manifest`. This delivers README "Next hardenings" item 2 (`capability_manifest` enforced at tool dispatcher). Denials are `security`-category audit events.
- **Existing gated functions become tools**, so the model reaches governance through the same doors a human does: `remember` → `proposeWrite(target:"memory")`, `commit_belief` → `commitBelief`, `propose_skill` → `proposeWrite(target:"skill")`, `search` → Phase 3, `run_tool` → `runTool` (`src/tools.ts:125`).
- **Spend guard:** check `spendLastHours` against the per-level budget before each step; exceeding it ends the loop with a partial answer, never silently.
- **Harness:** register LM Studio in the `harness_adapter.ts` registry (`src/harness_adapter.ts:22`). `model.ts`'s `openai` mode already speaks OpenAI-compatible — point `CHAMBER_API_BASE` at LM Studio. Register Claude API as a second harness for escalation. `completeSync` throws for non-stub modes (`src/model.ts:166`), so the loop must be async throughout.

**Exit:** a real turn where the local model calls `search`, then `commit_belief` with retrieved pins, and the reply passes the contract. A turn that tries a disallowed tool is refused and audited. Regex intent detection deleted.

---

## Phase 3 — Evidence and retrieval

The citation gate only has teeth if the model can *earn* pins instead of inventing them.

- **`search` tool** unifies three retrievers that already exist: `searchVector` (`src/vector.ts:213`, MiniLM via `src/embedder.ts:136`), session FTS (`src/sessions.ts`), and `code_index` (`src/code_index.ts` — already content-addresses chunks with a real sha256 at line 80). Every hit returns `{text, refId, kind, snapshotHash}` read straight from the corpus row — so a pin the model cites is one Phase 1.3 can verify **by construction**, because it came from the same store verification reads. Retrieval and verification share one source of truth; that is the whole design.
- **Debt payment loop, using the states the schema already defines** (`pending → proposed_paid → paid`): `proposeDebtPayment(db, debtId, sources)` sets `citation_debt.status = 'proposed_paid'` and queues a `pending_write` with `target: "debt"`; approval flips it to `paid` and stamps `paid_at`. Set `belief_source.pays_subclaim` to the debt id being retired — the column exists for exactly this and is currently always null. Add `debt` to `WriteTarget` in `src/approvals.ts:18`. Note `openBlockingDebts` (`src/commit_belief.ts:51`) already treats `proposed_paid` as still-blocking, so a proposal in flight correctly does not unblock the claim.
- **Corpus ingest:** `scripts/ingest_merkle_corpus.ts` exists — wire a `chamber ingest <path>` CLI command so the vault and project docs become searchable pinnable evidence.

**Exit:** ask a question whose answer is in the corpus → model searches → commits a belief with verified pins → zero debt minted. Ask one that isn't → debt minted, belief flagged not-load-bearing, and paying the debt through the approval queue clears it.

---

## Phase 4 — Skill execution

Approved skills actually run, under the gate that already exists and is never called.

- `matchSkills(db, message, scopeId)` on `skills_registry.ts` → candidate skills.
- For each candidate call `tryActivateSkill` with `currentContentHash`, `requestedCapabilities`, and turn stakes. Only skills that return `ok` get their body injected into the loop's system context.
- The activated skill's `capability_manifest` becomes the turn's tool allowlist inside `authorizeToolCall`.
- **Critic-clear flow (blocking gap):** nothing currently produces a cleared snapshot, so in `teeth` mode every activation refuses at `src/try_activate_skill.ts` step 3. Add `criticClearSkill(db, skillId, contentHash, capabilityManifest)` — a different model family per locked Fork D — writing `skill_snapshot` with `cleared_hash` + manifest, itself proposed and approved. Then flip `suspension_mode` from shadow to teeth (Fork C).
- Learning stays propose-only: `runDreamCycle` (`src/memory.ts:241`) already proposes rather than applies. Keep it.

**Exit:** a skill imported via `skill_import.ts`, critic-cleared, approved, and demonstrably steering a turn — with a second skill correctly refused for a stale load-bearing belief in teeth mode.

---

## Phase 5 — Capability levels and routing

XP is earned from **verified outcomes only**, awarded in the same transaction as the thing that earned it, so XP can never be minted by a rolled-back action.

**Schema** — `sql/schema_progression.sql`:
- `scope_progression(scope_id PK, level, xp, updated_at)`
- `xp_event(id, scope_id, kind, delta, subject_id, audit_id, created_at)`

**Earning:** citation debt paid `+10`; proposal the agent made approved by a human `+5`; turn completes with no gate block `+1`; task confirmed done by the user `+5`. **Losing:** any `security`-category audit event or gate block is negative and demotes.

**Unlocks per level** (all four, as chosen):

| Level | Tool classes | Stakes ceiling | Auto-approve | Budget/turn |
|-------|--------------|----------------|--------------|-------------|
| L0 | none (read-only context) | — | none | minimal |
| L1 | `read` | routine | none | small |
| L2 | `+ compute` (sandboxed) | routine | memory writes | medium |
| L3 | `+ network`, MCP | elevated | + skill activation | medium |
| L4 | `+ write_fs` (workdir only) | elevated | + tool synthesis | large |
| L5 | full allowlist | elevated | widest ruleset | large |

- Replaces the blunt global `CHAMBER_ALLOW_HIGH_RISK_TOOLS=1` env switch at `src/tools.ts:169` with per-scope, per-level authorization inside `authorizeToolCall`.
- **Consequential stakes and `constitution` target never auto-approve at any level** — already enforced at `src/approval_workflows.ts:266`; levels must not weaken it.
- **Fail closed:** a missing or unreadable `scope_progression` row resolves to **L0**, not to a default level.
- Demotion is immediate on violation and re-earning is slower than the first climb (violation sets a cooldown), so a single lucky streak can't restore autonomy after a breach.

**Routing / self-tuning (propose-only, no weight training in v1):**
- `task_class_stats(scope_id, task_class, harness_id, attempts, successes, avg_steps, avg_cost_usd)` updated per turn.
- Router picks local vs cloud per task class from measured success rate; below threshold → escalate to Claude. Default and fallback are local-first.
- **A single run measures the draw, not the model** — routing decisions require a minimum sample (≥5 attempts) before they change behaviour; below that, local-first stands.
- Harvested lessons become memory/skill **proposals** through the existing `resolveMemoryProposal` path — never auto-applied. The approved-session corpus accumulates toward a later MLX LoRA, which is explicitly out of scope for v1.
- `chamber level` CLI: current level, XP, next unlock, recent XP events, routing stats.

**Exit:** a fresh scope starts at L0 and cannot call `compute` tools; after earning XP it can; a deliberate violation demotes it and the demotion is in the audit chain.

---

## Critical files

**New:** `src/agent.ts` (loop + `authorizeToolCall`), `src/pins.ts`, `src/progression.ts`, `src/routing.ts`, `sql/schema_progression.sql`, `sql/schema_pins.sql`, `tsconfig.json`.

**Heavily modified:** `src/sandbox.ts` (backends + fail-closed), `src/commit_belief.ts` (audit + pin verification), `src/try_activate_skill.ts` (audit), `src/tools.ts` (level-based authorization), `src/cli.ts` (regex turn → agent loop), `src/db.ts` (no silent fallback, row helpers), `src/audit.ts` (TX flag, chainEnabled), `src/secret_box.ts` (fail closed + scrypt), `tests/harness.ts` (negative tests throughout).

**Reused as-is:** `approvals.ts`, `approval_workflows.ts`, `faculty.ts`, `merkle*.ts`, `scope.ts`, `job_queue.ts`, `spend.ts`, `vector.ts`, `embedder.ts`, `memory.ts`, `sessions.ts`, `code_index.ts`.

---

## Verification

Per phase — `npm run check` (typecheck + full harness) before and after every change; no phase exits red.

**Phase-specific, end-to-end:**

1. **Sandbox:** re-run the escape probe (`runInSandbox` reading `$HOME`, writing to `$HOME`, resolving DNS) **per backend**, asserting the guarantee table in Phase 1.1 — all three fail under docker; network and write fail under seatbelt while the read is *expected to succeed* and the result must declare `isolation: "no-network-no-write"`. Assert `CHAMBER_SANDBOX_REQUIRED=1` with `CHAMBER_SANDBOX_BACKEND=none` returns `ok:false`. A backend that silently over-claims its isolation is the specific regression these tests exist to catch.
2. **Audit:** run a turn, then `SELECT count(*) FROM audit_event WHERE category='gate'` > 0, and `verifyAuditChain` returns ok. Export a checkpoint and verify its signature offline.
3. **Pins:** commit a belief with a fabricated `snapshotHash` → asserts blocking debt minted (this is the exact probe that passes today and must fail after).
4. **Loop:** `chamber turn "what did I decide about X"` against LM Studio → transcript shows search → tool result → contract-passed reply. Then a turn requesting a `network` tool at L1 → refused + audited.
5. **Skills:** import, critic-clear, approve, observe it steering a turn; a stale-dependency skill refuses in teeth mode.
6. **Levels:** fresh scope at L0 blocked from `compute`; earn XP; unlocked; force a violation; demoted and recorded in the chain.
7. **Daily driver:** run the `deploy/PILOT.md` loop on yourself for a week — friction log, spend footer, queue age. Kill criteria from that doc apply.

**Benchmark honesty:** `benchmarks/BENCHMARK.md` currently scores Chamber 33/40 with T1 ("allowlist + sandbox before activate") at 2 and A1/A3 at 2. Those scores are not currently earned — the sandbox doesn't isolate and the flagship gates aren't chained. Re-run `benchmarks/scorecard.ts` after Phase 1 and correct the scoreboard; the doc's own "fair use of results" section demands it.
