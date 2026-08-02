# Chamber — from governance kernel to governed agent

## Context

Chamber is ~16k LOC of dependency-free TypeScript on `node:sqlite`. Its governance substrate is genuinely strong: citation debt, faculty parliament, skill holds with shadow/teeth modes, capability manifests, hash-chained audit + incremental MMR, approvals with idempotency and conflict handling, and scopes with a strict-wins **global posture floor** (`effectivePolicy`, `src/scope.ts:76` — note: parent-chain inheritance is declared in the schema but `parent_id` is never walked; see Deferrals). 99/99 tests pass.

Two problems block the next level.

**1. The constitution isn't true yet.** A code review with live probes found the enforcement layer doesn't match the docs:

- `CHAMBER_SANDBOX_REQUIRED=1` is a no-op. The `REQUIRED === "1"` disjunct at `src/sandbox.ts:204` is dead code — when a backend is detected the inner `backend === "none"` branch never fires and execution falls through to an **unsandboxed** run. There is no `runDocker` at all: a "docker" detection dispatches to `runSubprocess` and is then relabeled `"subprocess"` at `src/sandbox.ts:232`. Probed on the deployment Mac: model-generated code read `$HOME`, saw `~/.ssh` and `~/.secrets`, **wrote a file to `$HOME`**, and resolved DNS — while `detectSandboxBackend()` reported `"docker"` and never invoked docker.
- The two flagship gates aren't in the audit chain. `commit_belief.ts` and `try_activate_skill.ts` write only to the unchained `gate_event` table; 16 other modules call `appendAudit`. Live run: 4 `gate_event` rows, **0 `audit_event` rows**.
- The citation gate is `sources.length > 0`. A consequential medical falsehood committed clean with zero debt on a pin of `snapshotHash: "aaaa"` pointing at a nonexistent URL. Nothing verifies a pin resolves or matches content.
- `sealSecret` (`src/secret_box.ts:34`) stores plaintext unless *both* `NODE_ENV=production` and `CHAMBER_REQUIRE_TOKEN_KEY=1`; the shipped Dockerfile sets only the first.
- No `tsconfig.json`, no linter, no CI. `--experimental-strip-types` strips types without checking them: **91 errors** under `tsc --strict`, including a real discriminated-union misuse in the strict-contract path (`src/contract.ts:109,181`).
- **The CLI is dead at runtime.** The duplicate `listPendingQueue` import (`src/cli.ts:26` and `src/cli.ts:95`) is not type hygiene — it is a module-level `SyntaxError`, so *every* `chamber` command fails before `main()` runs. This was previously misfiled under the type-error table.

**2. There is no agent.** `cli.ts` `turn` is a regex demo — `wantsMemory` / `wantsSkill` / `wantsBelief` (`src/cli.ts:202-208`) decide everything, then one deterministic stub completion runs. `runTool` exists but no model ever calls it. `tryActivateSkill` is sophisticated and never invoked from a turn. And the turn logic is not in one place: **five surfaces each reimplement it** (`cli.ts`, `server.ts`, `slack_ops.ts`, `discord_ops.ts`, and the Telegram path in `gateway.ts`, which drives sync `spawnSync("curl", …)` long-polls at `src/gateway.ts:73`). Chamber has excellent gates with nothing driving them — and five doors around them.

**Outcome:** a daily-driver agent on CLI + Telegram, local-first (LM Studio) with cloud escalation, where a capability-level system grants the local model progressively more autonomy earned through verified outcomes. Autonomy is only safe if the gates are real — hence the ordering below.

**Hard gate:** no capability level above L0 ships until the Phase 1 sandbox negative tests pass **on the deployment machine** (`npm run check:sandbox` green is the entry criterion for Phase 4). Levels grant autonomy; autonomy on a fake sandbox is the failure mode this whole project exists to prevent.

**Hard constraints (restated, enforced by every phase):** zero runtime dependencies (dev/optional deps fine); learning stays propose-only — the agent never self-approves a skill, a durable memory write, or its own capability level; gates fail closed; consequential stakes and `constitution`-target writes never auto-approve at any level.

### Refinement pass 1 — what live probing changed

Four claims in the first draft were wrong or unfounded. Each was corrected against a measurement, not an assumption:

1. **Sandbox backends aren't interchangeable.** docker blocks reads of `$HOME`; macOS seatbelt does **not**, and a `(deny default)` profile aborts Node outright (SIGABRT, exit 134). Both verified live. Seatbelt is now a declared *degraded* tier, not a peer of docker.
2. **Pin verification must be a corpus lookup, not a refetch.** `vector_document` already stores `body` + `snapshot_hash` for this purpose. Refetching live URLs would make gate outcomes non-deterministic and put network I/O inside a transaction.
3. **Phase 0 was overestimated.** The 91 type errors are not "mostly casts" — 38 are a single `assert()` signature in the test harness (`tests/harness.ts:225`). Only ~11 are genuine.
4. **The debt lifecycle already has a `proposed_paid` state** and a `pays_subclaim` column. Phase 3 uses the schema as designed instead of inventing a parallel flow.

### Refinement pass 2 — what code-grounding changed

Three exploration passes over the tree plus a design pass produced ~45 corrections and two deep specs. The structural changes:

1. **Phases 4 and 5 swap.** Capability levels move *before* skill execution: (a) `authorizeToolCall` needs level resolution from day one — Phase 2 ships a constant-L0 resolver with the final interface so Phase 4 makes it real with no re-plumbing; (b) L3 auto-approves skill activation, which must postdate both level-system soak *and* teeth-mode tests; (c) the daily-driver outcome (CLI + Telegram, evidence loop, L0–L2) doesn't depend on skills, so the riskiest phase moves last.
2. **Phase 2 splits into 2A (engine) and 2B (surfaces).** 2A is CI-testable via a deterministic scripted harness; 2B — migrating five surfaces onto one engine and hardening Telegram — is a security event with its own rule: no surface migrates until it has auth, rate limiting, quarantine, scope mapping, and an approvals UI.
3. **Level promotions become proposals.** Threshold met → the system files a `pending_write(target:'capability')`; a verified human approves; demotions stay automatic. "The agent never self-approves its own capability level" taken literally — every XP-gaming vector degrades from "self-promotion" to "a farmed-looking queue item" (full gaming analysis in Phase 4).
4. **Refinement pass 1's own claims got re-audited.** Two survived intact (backends, corpus-lookup pins). Two needed tightening: `pays_subclaim` is not "unused" — `src/debt.ts:124` writes it today — and `proposeDebtPayment` already exists (`src/debt.ts:51`) with a different signature than the plan assumed. Phase 3 is now a *refactor* of `src/debt.ts`, not new code. Its `CHAMBER_AUTO_PAY_DEBT=1` similarity-score auto-pay path (`src/debt.ts:142`) is a standing gate bypass of exactly the kind Phase 1 exists to close — removed in 1.5.
5. **Benchmark honesty runs both directions** — scores Chamber hasn't earned come down, but the doc is also stale *in Chamber's favor* (see Verification).
6. **One extension of the owner's sandbox measurements, from code reading, not re-measurement:** the `bwrap` backend runs `--ro-bind / /` (`src/sandbox.ts:162`), which mounts the whole filesystem read-only into the sandbox — so bwrap, like seatbelt, leaves `$HOME` *readable* while blocking writes and network. The guarantee table gains a row; the docker/seatbelt rows stand as measured.

The pattern across both passes holds: this codebase's *schema* is consistently better than its *code*. Several gaps are unimplemented intent, not bad design — which makes them cheaper to close than the review's severity suggested.

---

## Phase 0 — Repo baseline, validation gate, and revival

Nothing else is safe to start until the tree is under version control, type-checked, **and actually runs**.

1. ~~Extract and baseline~~ **Done** — `~/Projects/chamber` is its own git repo, baseline commit `a49f4c5`, 121 files, suite verified 99/99. Secret-scanned before commit (only synthetic scanner fixtures). The 22MB `models/minilm/model_quantized.onnx` is tracked deliberately so the repo clones self-contained; revisit only if a remote is added.
2. **Revive the CLI.** Fix the duplicate `listPendingQueue` import (`src/cli.ts:26,95`). This is the first commit of the phase: every CLI command is a `SyntaxError` today, and every later phase's exit criteria run through `chamber`. Add a smoke test: `node --experimental-strip-types src/cli.ts status` exits 0.
3. **Async-capable test runner.** `tests/harness.ts:207` types tests as `fn: () => void` — an async test's rejection is unawaited, so async tests *silently pass*. Phase 2 makes the whole loop async; without this fix its tests would be theater. Rewrite `test()`/runner to accept `() => void | Promise<void>` and await sequentially. Meta-test: a deliberately failing `async` canary must make the runner exit non-zero.
4. **Schema-registration meta-test.** `SCHEMA_FILES` (`src/db.ts:8-23`) is a hand-maintained list; a new `sql/*.sql` that never gets appended silently never loads (this exact failure would eat Phase 4's `schema_progression.sql`). Test: every file in `sql/` appears in `SCHEMA_FILES`.
5. `tsconfig.json`: `strict`, `target es2022`, `module nodenext`, `allowImportingTsExtensions`, `noEmit`. `typescript` + `@types/node` as devDependencies; `discord.js` + `@slack/bolt` as **optionalDependencies** — **runtime stays zero-dependency.** Any future runtime dependency is a decision, not a convenience.
6. `npm run typecheck` and `npm run check` (= typecheck + test). **`npm run check` is the validation gate for every phase below** (`package.json` currently has neither script).
7. Clear all 91 type errors. **Measured breakdown — much smaller than it looks:**

   | Count | Code | What it is | Fix |
   |-------|------|-----------|-----|
   | 38 | TS2554 | **All in `tests/harness.ts`** — `assert(x)` against the 2-arg signature at `tests/harness.ts:225` | Make `msg` optional. One line clears 38. |
   | 18+7 | TS7031/TS7006 | Implicit `any`, mostly discord.js callbacks | Type the callbacks |
   | 13 | TS2352 | `.all() as Row[]` array casts | `rows<T>()` helper in `src/db.ts` casting through `unknown` once |
   | 5 | TS2339 | Property missing — includes the real `CommitResult` union misuse at `src/contract.ts:109,181` | Narrow before access |
   | 4 | TS2307 | `discord.js` not declared | optionalDependencies |
   | 4+2 | TS2345/TS2300 | Arg mismatch; the cli.ts duplicate import (also the runtime `SyntaxError` in item 2) | By hand |

8. **One-time CHECK-rebuild migration helper.** SQLite cannot `ALTER` a `CHECK` constraint; extending one means rebuild-table-and-copy. Three later phases need it — `spend_event.channel` gains a `tool` channel (2A), `pending_write.target` gains `debt` (P3) and `capability` (P4). Write `migrateRebuildTable(db, table, newDdl)` once, in-tree, tested here.

**Exit (all runnable):** `npm run check` green with 0 type errors · `node --experimental-strip-types src/cli.ts status` exits 0 · failing-async canary makes the runner exit non-zero · SCHEMA_FILES meta-test green · `migrateRebuildTable` round-trip test green.

---

## Phase 1 — Make the constitution true

### 1.1 Real sandbox with real fail-closed

`src/sandbox.ts` is the highest-severity item. Model-generated code runs here.

**Backends are NOT interchangeable — docker and seatbelt rows verified live on the deployment Mac; bwrap row from code reading (`--ro-bind / /`, `src/sandbox.ts:162`):**

| Backend | Network | Write outside workdir | **Read `$HOME` / `~/.secrets`** | Status |
|---------|---------|----------------------|-------------------------------|--------|
| `docker` | blocked | blocked | **blocked** (nothing mounted) | daemon 29.6.2 up; `--network none` verified |
| `seatbelt` (macOS `sandbox-exec`) | blocked | blocked | **STILL READABLE** | verified: `net: BLOCKED`, `homeWrite: BLOCKED`, `sshRead: true` |
| `bwrap` | blocked | blocked | **STILL READABLE** (`--ro-bind / /`) | Linux only; same degraded tier as seatbelt |
| `subprocess` | open | open | open | not a sandbox |

A naive `(deny default)` seatbelt profile **aborts Node with SIGABRT** (exit 134, verified) — Node can't boot under it. The workable profile is `(allow default)` + `(deny network*)` + `(deny file-write*)` with a workdir allow, and that leaves reads of `~/.ssh` and `~/.secrets` wide open. Probing only write+network would have declared victory while the read escape survived — verify the class, not the site.

Therefore:

- **`docker` is the required backend for any tool above `compute` class** — and `write_fs`/`network`/`shell` require *full* isolation, never degraded. Seatbelt/bwrap are declared *degraded*: acceptable for `compute` where exfiltration and tampering are the threats, never for anything handling secrets.
- Write `runDocker` (it does not exist): `docker run --rm --network none --read-only --memory 512m --pids-limit 128 -v <workdir>:/work:rw -w /work --user <uid> node:22-slim`. Remove the relabel-to-`"subprocess"` lie at `src/sandbox.ts:232`.
- `SandboxResult` gains `isolation: "full" | "no-network-no-write" | "none"`, reporting what **actually ran**. Evidence must never claim isolation it didn't have.
- `runInSandbox` gains a `require: Isolation` parameter and refuses anything weaker than requested (this is what closes the authorize/execute TOCTOU in Phase 2A step 7).
- Fix the dead disjunct at `src/sandbox.ts:204`: `CHAMBER_SANDBOX_REQUIRED=1` refuses whenever resolved isolation is not `"full"`. `detectSandboxBackend()` returns `"none"` when nothing usable exists; validate the `CHAMBER_SANDBOX_BACKEND` env value instead of casting it. `"subprocess"` becomes selectable only via explicit `CHAMBER_SANDBOX_INSECURE=1`, reported as `backend: "insecure_subprocess"`, `isolation: "none"`.
- `scrubEnv` (`src/sandbox.ts:69`) allowlists `HOME` through to the child — drop it; the sandbox workdir is the child's home.
- **Known implementation detail:** the seatbelt workdir allow rule returned `EPERM` in probing (`workdirWrite: "BLOCKED:EPERM"`) — likely `/private/var/folders` vs the raw `mkdtemp` path. Solve before shipping seatbelt as a backend; **docker-only is an acceptable Phase 1 ship state** (see Deferrals).

**Negative tests are the point**, and they must never green by skipping: split into two suites (see Exit).

### 1.2 Gates into the audit chain

`commitBelief` and `tryActivateSkill` both own a `BEGIN IMMEDIATE` transaction. Call `appendAuditInTx` (`src/audit.ts:168` — a genuine drop-in with **zero call sites today**) inside it — check and tamper-evident write commit together, which is what the README's invariant claims. Keep `emitGate` for the queryable gate view.

**Ordering trap (verified in the tree):** on the blocked-commit path, an audit row written before `ROLLBACK` is *discarded with the rollback*. `src/commit_belief.ts:167-188` already demonstrates both halves: the `debt/blocked` gate event is emitted pre-rollback (dies), then a second `commit/blocked` event is deliberately re-emitted after rollback with the comment "audit row in separate implicit autocommit after rollback". The `appendAudit` call for a blocked commit must follow that second pattern — success-path audit in-TX, refusal-path audit post-rollback.

### 1.3 Pin verification

**Verification is a corpus lookup, not a refetch.** The schema anticipated this: `vector_document` stores `body` *and* `snapshot_hash` (`sql/schema_vector.sql`), commented "Content pin for citation debt payment". `belief_source` carries `span_hash` and `context_hash` alongside `snapshot_hash`. Designed correctly, never implemented.

**Correction: the corpus is one store, not four.** The old plan named `vector_document`, `session`, `code_index`, `belief` as lookup targets — but `code_index` is not a table (code chunks are ingested *into* `vector_document`; `src/code_index.ts:80` computes their hash), and the `session` table (`sql/schema_hermes_parity.sql:19`) has **no body column** to re-hash. Verifiable pins live in `vector_document` (docs + code chunks) and `belief` (belief-kind sources). Session-FTS pinnability is optional-if-time in Phase 3.

New `src/pins.ts`: `verifyPin(db, source): {ok, actualHash?, reason?}` — look up stored content by `refId`/`snapshot_hash`, re-hash the stored body, compare. **No network, no refetch, deterministic, safe inside the gate transaction.** Because hash *formulas* differ by kind, `verifyPin` dispatches through a **per-kind formula registry**: document pins are `sha256(title + "\n" + body + "\n" + sourceRef)`; code-chunk pins are `sha256("path:start:end\n" + body)` (matching `src/code_index.ts:80` exactly). A pin whose kind has no registered formula is unverifiable → debt. Refusal events reuse the existing `gate_event` gate/action enums (`sql/schema.sql:176-183` are `CHECK`-constrained — use `debt`/`commit`, don't invent a `pin` gate, which would violate the CHECK).

In `commitBelief`: replace the truthiness check (`src/commit_belief.ts:107`) with verification, and change the debt-mint condition (`src/commit_belief.ts:241`) from `sources.length === 0` to `verifiedSources.length === 0`. Unverifiable or mismatched pin → **mint blocking debt**. Ingest (which does touch the network) stays in the job queue, ahead of any commit.

### 1.4 Fail-closed cleanups

- `sealSecret`: throw when no key unless `CHAMBER_ALLOW_PLAINTEXT_SECRETS=1`. Add `CHAMBER_REQUIRE_TOKEN_KEY=1` to `deploy/Dockerfile`. Replace bare `sha256(passphrase)` with `scrypt` + stored salt.
- `src/db.ts:49`: delete the silent `/tmp/chamber.sqlite` → `:memory:` fallback. An audit database that silently becomes amnesiac is worse than one that fails to open.
- `src/audit.ts:71`: `chainEnabled()` is computed and discarded — honour `audit.chain_enabled` or delete the key.
- `src/audit.ts:100`: replace exception-driven transaction detection (`try { BEGIN IMMEDIATE } catch { assume in TX }`) with an explicit `opts.inTx` flag. `SQLITE_BUSY` currently reads as "already in a transaction" and the append runs in autocommit — breaking the one-transaction invariant.
- Checkpoint signing (`CHAMBER_CHECKPOINT_KEY`, ed25519) over `exportCheckpoint`'s receipt, so the chain is tamper-evident against DB write access, not just corruption. **This is net-new code** — the old exit criterion "verify its signature offline" named machinery that doesn't exist. Droppable if the phase overruns; nothing downstream depends on it.

### 1.5 Registry and bypass integrity

Constitution lies that Phase 2 would otherwise inherit. Each is a standing bypass or a dead path, verified live:

- **`listTools` reads a table that doesn't exist.** `src/tools.ts:82` selects `FROM skill` — no schema file creates a `skill` table, so the query throws, the catch swallows it, and **only the 3 builtin tools can ever run** (verified live). Point it at the real registry tables and add the missing-table case to tests.
- **Risk laundering:** `src/tools.ts:91` hardcodes `risk: ["compute"]` for skill-derived tools regardless of what they do. Risk must come from the registry row; a tool with no declared risk is `shell` (highest), not `compute`.
- **`activateSkillRegistry` (`src/skills_registry.ts:114`) is an ungated side door** — it flips a skill active without `tryActivateSkill`'s holds, faculty, or teeth checks. Route it through the gate or restrict it to CLI-admin use with an audit row.
- **Remove `CHAMBER_AUTO_PAY_DEBT`** (`src/debt.ts:142`): auto-paying citation debt from embedding similarity alone is a human-free bypass of the debt gate — and it makes the Phase 4 self-minted-debt XP exploit infinite. Debt payment is always a proposal (Phase 3).
- **`getHarness` must throw on unknown id** instead of silently substituting the stub (`src/harness_adapter.ts:22` registry). A misconfigured model name currently degrades to canned stub output that *looks* like a working agent.
- **Server fail-closed:** auth is off by default (`src/server.ts:65` — `if (!API_TOKEN) return true`), CORS is `*` (`src/server.ts:120,263`), and the shipped Dockerfile binds `0.0.0.0` (`deploy/Dockerfile:14`). Refuse to start without `CHAMBER_SERVER_TOKEN` unless `CHAMBER_SERVER_INSECURE=1`; scope CORS to configured origins.
- **Hard-code consequential-never-auto-approve.** Today it is a *disableable seeded workflow rule*, and `matchesRule` treats a payload with **missing `stakes` as `routine`** — so omitting a field bypasses the guarantee. Add a hard block beside the existing constitution block at `src/approval_workflows.ts:266`: consequential stakes never auto-approve regardless of rule table contents, and **missing stakes is treated as consequential** (fail closed), not routine.

**Exit (two suites, so CI can't fake the sandbox):**
- `npm run check` (CI, fake backends): `REQUIRED=1` + backend `none` refuses · seatbelt-shaped results carry `isolation:"no-network-no-write"` and are rejected for `write_fs`/`network` · blocked commit leaves a **post-rollback** `audit_event` row and `verifyAuditChain` passes · fabricated pin mints blocking debt (`probes/pin_bypass.ts` exits non-zero) · unknown harness throws · auto-approve of a consequential or stakes-less payload is refused with the rule table maximally permissive.
- `npm run check:sandbox` (deployment Mac, real docker): the original escape probe (read `$HOME`, write `$HOME`, resolve DNS) **fails** under docker; the probe exits non-zero if any escape succeeds. **Sandbox tests must fail, not skip, when docker is absent.**

---

## Phase 2 — Gated agent loop

Split: **2A** is the engine — new `src/agent.ts` `runAgentTurn` + new `src/authorize.ts` — CI-tested end-to-end against a deterministic scripted harness. **2B** migrates the five turn surfaces onto it and hardens Telegram. The old plan treated this as one step and its exit criteria depended on Phase 3's `search` tool and a CLI that didn't run; both fixed below.

### 2A — Engine

**Tool-call protocol.** The model emits a single JSON object per step — exactly one of:

```json
{"thought": "...", "tool": {"name": "...", "args": {"named": "args"}}}
{"thought": "...", "final": "reply text"}
```

**One tool call per step** — no arrays. Per-call authorization, audit, and spend metering stay 1:1 with model decisions, and local models mangle arrays. `ToolSpec` gains a minimal `argsSpec: {name, type, required?, description?}[]` (it has **no arg schema at all** today); the dispatcher validates named args, rejects unknown keys, and serializes to positional argv so `runTool`'s existing contract (`src/tools.ts:125`) is untouched. Gated internal tools — `search` (P3), `commit_belief`, `remember`, `propose_skill` — dispatch to their typed functions, never through argv.

**Parse pipeline:** strip code fences → take outermost `{…}` → `JSON.parse` → shape-validate. On failure, **one retry on the same harness** with the exact validation error appended. Second failure ends the turn with a **deterministic refusal template** — a constant string, itself covered by a test asserting it passes `enforceReplyContract` — outcome `refused_parse`, audited `session`-category. Parse failures never escalate to cloud (garbage in, expensive garbage out).

**Termination — four conditions, checked between steps; every non-completed outcome writes one audit row and a visible reply footer:**

1. Model emits `final` → `enforceReplyContract` → done.
2. Wall clock: `CHAMBER_TURN_DEADLINE_MS` (default 120 000) per turn, plus per-request `AbortSignal.timeout` — `src/model.ts` has **no timeout today**; a hung LM Studio hangs the turn forever.
3. Spend: new `spendForTurn(db, turnId)` against the level's per-turn budget. The `turn_id` column already exists on `spend_event` (`sql/schema_spend_approvals.sql:28`); only global N-hour windows are queryable today (`spendLastHours`). Exceeding budget ends the loop with a partial answer, never silently.
4. `CHAMBER_MAX_STEPS` (default 6) → one forced-final completion with tools disabled → if that too fails, the refusal template.

**`authorizeToolCall(db, {scopeId, tool, args, level})` in `src/authorize.ts` — enforced *inside* `runTool`**, so the agent loop, `mcp_bridge` (which duplicates a weaker high-risk check at `src/mcp_bridge.ts:44-48` — delete it), and the CLI all pass one chokepoint. Check order — first failure denies; every denial writes `security`-category audit (`tool_denied`) + a gate event:

1. Resolve tool from the registry; unknown tool or missing scope → deny (missing scope treats as L0).
2. Capability level via `resolveLevel(db, scopeId)` — **constant L0 until Phase 4**, but the interface is final now. Missing/malformed `scope_progression` row → L0.
3. `effectivePolicy(db, scopeId)` (`src/scope.ts:76`): `strict` caps tool classes at `compute` and kills **all** auto-approval. Companion fix: `proposeWrite` must call `effectivePolicy` instead of reading the global posture env directly, or per-scope strict does nothing.
4. Risk vs level: `max(tool.risk[])` must be within the level's classes (Phase 4 table). `shell` is never level-unlocked.
5. Skill-manifest union: the active skill's `capability_manifest` *adds* to the baseline allowlist; **absent manifest adds nothing** (today absent manifest means allow-all — inverted here and in `tryActivateSkill` step 4 in the same commit, Phase 5). Manifest entries get a `{kind: "tool"|"host"|"path", …}` discriminator; risk always resolves from the registry row, never the manifest (closes laundering).
6. Spend precheck (`spendForTurn` + level budget).
7. Required isolation per risk class: `compute` → full-or-degraded; `write_fs`/`network`/`shell` → docker full only. The resolved backend is returned in the authorization constraints and passed as `runInSandbox`'s `require` param (1.1), which refuses anything weaker — authorize and execute can't disagree (TOCTOU closed).

Delete `CHAMBER_ALLOW_HIGH_RISK_TOOLS` (`src/tools.ts:169`) — per-scope, per-level authorization replaces the global switch. Also fix in 2A, *before any routing stats accumulate*: `src/model.ts` requires `CHAMBER_API_KEY` even for LM Studio which needs none (`src/model.ts:86` — make it optional for non-OpenAI bases) and hardcodes ~gpt-4o-mini pricing (`src/model.ts:121`) — replace with a per-model cost table; otherwise every local completion is mispriced and Phase 4's router learns from poisoned numbers.

**Error/retry taxonomy:**

| Failure | Handling | Ends turn? |
|---------|----------|-----------|
| Parse failure | retry 1× same harness with validation error | 2nd failure → yes, refusal template |
| Transport failure (timeout, conn refused) | retry 1× local, then **the** cloud-escalation case | if cloud also fails → yes, partial |
| Unknown harness id | immediate config error (`getHarness` throws, 1.5) | yes |
| Tool denial | denial fed back to model as a tool result | 2 identical denials → yes |
| Sandbox crash | stderr fed back as tool result | no |
| Budget / deadline exceeded | — | yes, partial answer + footer |

**Async migration.** `runAgentTurn` is async via `complete()` — `completeSync` throws for real backends (`src/model.ts:166`). The blast radius is all six `completeSync` call sites; five are shallow. The hard one: **faculty runs `completeSync` (`src/faculty.ts:178`) inside `tryActivateSkill`'s `BEGIN IMMEDIATE`** (`src/try_activate_skill.ts:119`, `openDeliberation` called at `:316`) — model I/O inside an open write transaction. Split `openDeliberation` into `computeVotes` (model I/O, called *before* the TX) + `recordDeliberation` (sync, in-TX). Safe because the heuristic veto already wins over model votes and the activation path never feeds in-TX state into the deliberation prompt.

**Harnesses:** register LM Studio (`CHAMBER_API_BASE` at its OpenAI-compatible server, key optional) and Claude API (escalation) in the registry at `src/harness_adapter.ts:22`. For CI: a **scripted harness** — a `ModelHarness` returning caller-injected canned responses in sequence — so every loop behavior is deterministic without LM Studio. Live LM Studio runs are manual acceptance checks, not CI.

**Exit 2A (CI, scripted harness, no LM Studio):** scripted turn executes an echo tool and the reply passes the contract · a `network`-class tool at L0 → denied + `security` audit row + denial fed back to the model · two garbage completions → `refused_parse` with the template reply · budget exhaustion mid-turn → partial reply with footer + audit row.

### 2B — Surfaces and Telegram

`runAgentTurn(db, {message, scopeId, sessionId, turnId, surface, actor, actorVerified})`. Each surface becomes a thin adapter: identity/scope resolution → surface pre-filters (rate limit, quarantine) → engine → render → `onPendingWrite` hook for approvals UI. **Migration order: CLI → server → Slack → Discord → Telegram last** (highest exposure, weakest current state). Each migrated surface keeps its legacy path behind `CHAMBER_LEGACY_TURN=1` for one phase, then the flag and the dead code are deleted.

**Rule: no surface migrates to the loop until it has** auth, rate limiting, quarantine, scope mapping, and an approvals UI. For Telegram that means a new `src/telegram_ops.ts` ported from the `slack_ops.ts` pattern: chat-id allowlist, rate limit, quarantine, per-chat scope mapping, async long-poll replacing the sync `spawnSync("curl")` at `src/gateway.ts:73` (which blocks the whole process today), and approvals via the existing `onPendingWrite` hook + `callback_query` buttons. Telegram currently has **no auth at all**. Delete the orphaned `src/plugins/telegram.ts`. Add a `PILOT.md` Telegram addendum (acceptance stage below).

Also here: the minimal actor-identity model (defined in Phase 4, needed by approvals from first migration), and `resolveMemoryProposal` (`src/memory.ts:365`) honoring its `pending_write_id` linkage (`src/memory.ts:283`) and erroring on unsupported `demote`/`merge` actions instead of silently ignoring them.

**Exit 2B:** `grep -rn "wantsMemory\|wantsSkill\|wantsBelief" src/` returns nothing · Telegram: message from an unknown chat id is refused before any model call; an allowlisted approver's `callback_query` flips a `pending_write`; an unauthenticated callback does not · `server.ts` with no token set refuses to start · all five surfaces produce turns through `runAgentTurn` (one grep: no surface file calls `complete`/`completeSync` directly).

---

## Phase 3 — Evidence and retrieval

The citation gate only has teeth if the model can *earn* pins instead of inventing them. **Reframed from "new code" to "wrap what exists": `src/debt.ts` already implements most of this phase.**

- **`search` tool** unifies retrievers that already exist: `searchVector` (`src/vector.ts:213`, MiniLM via `src/embedder.ts:136`) over `vector_document` (docs + code chunks — `src/code_index.ts:80` already content-addresses chunks) and session FTS (`src/sessions.ts`; session hits are context-only unless session-pinnability lands — optional-if-time, see 1.3). Every hit returns `{text, refId, kind, snapshotHash}` read straight from the corpus row — a pin the model cites is one Phase 1.3 verifies **by construction**, because it came from the same store verification reads. **Embedder-model partition fix:** `vector_document` rows must record the embedding model/dimension and `searchVector` must filter to the active embedder's partition — mixed-model cosine scores are noise; on partition miss, fall back to FTS rather than cross-model similarity.
- **Debt payment loop — refactor, don't duplicate.** `proposeDebtPayment` **already exists** (`src/debt.ts:51`) with signature `(db, debtId, opts)` doing retrieve-and-propose, and already writes `pays_subclaim` (`src/debt.ts:124`) — the old plan's claim that the column is "always null" was wrong, and its proposed `(db, debtId, sources)` signature collides. Keep the existing function and its 4 call sites; change its *disposition*: always set `citation_debt.status = 'proposed_paid'` and queue a `pending_write(target: "debt")`; human approval flips to `paid` + `paid_at`, and **`belief_source` rows for the payment land only on approval**. The similarity auto-pay branch is already gone (1.5).
- **`debt` write target:** `WriteTarget` is a TS union (`src/approvals.ts:18`) *and* a SQL `CHECK` on `pending_write.target` — adding `"debt"` requires the `migrateRebuildTable` helper from Phase 0, not just a TS edit (the insert would violate the CHECK at runtime while typechecking clean).
- **Corpus ingest is net-new**, not a wiring job: `scripts/ingest_merkle_corpus.ts` is a 10-doc fixture script, not an ingester. Build `chamber ingest <path>` walking a directory into `vector_document` with real snapshot hashes, running as an `ingest` `JobKind` in the job queue (new kind), with **lease reclamation** for jobs whose worker died mid-lease (the queue has no reclaim today — an ingest crash would strand the corpus half-built).
- `openBlockingDebts` (`src/commit_belief.ts:51`) already treats `proposed_paid` as still-blocking, so an in-flight proposal correctly does not unblock the claim. Use as-is.

**Exit:** `chamber ingest` on a fixture directory → `search` returns a hit carrying `snapshotHash` → `commit_belief` citing it → **zero debt minted** · same commit with a fabricated hash → blocking debt · `chamber debt pay <id>` → `citation_debt.status='proposed_paid'` + a `pending_write(target:'debt')` row · `belief_source` payment rows exist **only after** approval; before it, the claim stays blocked.

---

## Phase 4 — Capability levels and routing (was Phase 5)

**Entry criterion (the hard gate, made mechanical): `npm run check:sandbox` green on the deployment Mac.** No level above L0 exists in a build whose sandbox negative tests haven't passed where the agent actually runs.

**Structural rule: promotions are proposals; demotions are automatic.** XP threshold met → the system files `pending_write(target: 'capability')` (CHECK rebuild via the Phase 0 helper) → a **verified human** approves → level changes. Demotion executes immediately without approval (asymmetric fail-safe). The agent never self-approves its own capability level — literally.

### Gaming analysis — vectors verified against the code, and what closes them

| Vector | Code reality | Defusal |
|--------|-------------|---------|
| Trivial-turn farming (+1) | Worse than assumed: server auth off by default + CORS `*` (`src/server.ts:65,120`) = drive-by scriptable turn source | 1.5 server fail-closed; `turn_clean` requires a real model completion; cap 5/day |
| Self-minted-debt loop (+10) | Mint→retrieve→pay is structurally identical to the *desired* learning loop; `CHAMBER_AUTO_PAY_DEBT=1` (`src/debt.ts:142`) made it **infinite and human-free** | Auto-pay removed (1.5); the oracle is the verified human approver; `debt_paid` requires the debt be older than the paying turn; cap 3/day |
| Forged approver (+5) | `decided_by` is client-supplied free text through `server.ts` with auth off — spoofable with one curl today | Identity model below; XP only on `decided_by_verified` |
| Same-subject replay | Nothing prevents re-earning on the same subject | `UNIQUE(scope_id, kind, subject_id)` on `xp_event` |
| **Demotion griefing** | If denials demote, anyone who can message the bot (Telegram has no auth) can DoS the agent's level | **Denial ≠ violation.** Denials feed back to the model; only the violation definitions below demote |
| Task-done spoofing (+5) | Telegram unauthenticated; "done" is a free-text claim | `task_done` disabled until 2B ships surface auth; then verified-approver only |

### Economy

`sql/schema_progression.sql` — **must be appended to `SCHEMA_FILES` (`src/db.ts:8-23`) or it never loads** (the Phase 0 meta-test catches this):

- `scope_progression(scope_id PK, level, xp, promotion_frozen_until, updated_at)` — **missing row = L0 by design** (the seeded `default` scope gets no row and starts at L0; fail closed).
- `xp_event(id, scope_id, kind, delta, subject_id, audit_id, created_at, UNIQUE(scope_id, kind, subject_id))`.
- `approver(id, surface, external_id, label, added_at)`.

XP awards happen **in the same transaction as the earning action** — XP can never be minted by a rolled-back action.

| Kind | Δ | Daily cap | Requirements |
|------|---|-----------|--------------|
| `turn_clean` | +1 | 5 | real model completion; no gate block in turn |
| `proposal_approved` | +5 | 5 | verified approver; proposal was agent-originated |
| `debt_paid` | +10 | 3 | verified approver; debt older than paying turn |
| `task_done` | +5 | 3 | verified approver; disabled until 2B |
| `violation` | — | — | state change (demotion), **not** negative points |

**Minimal identity — one table, one column, four call sites; no ocean-boiling:** actor = `<surface>:<external-id>`. `cli:local` is implicitly trusted (physical access). `slack:<uid>` / `discord:<uid>` / `telegram:<uid>` are trusted iff present in `approver` (`chamber approver add telegram:12345 "AB"`). Server-supplied actor strings are recorded but **never XP-eligible**. Surfaces compute `actorVerified` at their boundary (2B); `decideWrite` stores a new `decided_by_verified` column.

**Promotion dampening — threshold AND time AND human signal:** promotion eligibility requires the XP threshold **and** ≥N distinct active days at the current level (3 for →L1/→L2, 5 for →L3, 7 for →L4/→L5) **and**, for →L3 and above, ≥5 verified-approver events at the current level. Pure `turn_clean` grinding can never reach the auto-approval levels.

**Demotion:** a violation drops one level, resets XP to the new level's floor, and freezes promotion for 72h; a second violation inside the freeze → L0. Violations are: ≥3 identical denied high-risk attempts in 24h, an integrity failure (audit-chain verification failure, fabricated pin at consequential stakes), or explicit `chamber demote`. *(Considered and rejected as over-engineering: re-climb XP multipliers, content-hash proposal dedup — the caps + idempotency + human approval already bound the damage; complexity is its own attack surface.)*

### Unlock table (corrected)

The old table had one "stakes ceiling" column using `"elevated"` — **not a valid belief stake** (`sql/schema.sql:26`: beliefs are `routine|consequential` only). Stakes split per surface: the belief auto-path caps at `routine` at *every* level (consequential always queues for a human); skill-activation stakes admit `elevated` from L3. `write_fs` (workdir-only) unlocks **before** `network` — exfiltration is the top measured threat on this machine (`~/.secrets` exists), and a workdir write is strictly less dangerous than an open socket. MCP tools are network-class → L4. `shell` — the fifth risk class (`src/tools.ts:18`), which the old table omitted — **never unlocks at any level.**

| Level | Tool classes | Belief auto-path | Activation stakes | Auto-approve | Budget/turn (USD micros) |
|-------|--------------|------------------|-------------------|--------------|--------------------------|
| L0 | none (read-only context) | routine | — | none | 5 000 |
| L1 | `read` | routine | routine | none | 20 000 |
| L2 | + `compute` (sandboxed, full or degraded) | routine | routine | **working-layer memory writes only** | 50 000 |
| L3 | + `write_fs` (workdir only, docker full) | routine | elevated | + skill activation — **locked until Phase 5 exit** | 100 000 |
| L4 | + `network`, MCP (docker full) | routine | elevated | + tool-synthesis proposals | 200 000 |
| L5 | full allowlist minus `shell` | routine | elevated | widest ruleset | 500 000 |

- The old L2 "auto-approve memory writes" was a genuine propose-only violation — durable-layer memory writes are learning. Narrowed to the **working layer only**; durable promotions go through `resolveMemoryProposal` and a human, at every level.
- `strict` scopes cap tool classes at `compute` and disable **all** auto-approval regardless of level (authorize step 3).
- Consequential stakes and `constitution` targets never auto-approve at any level — hard-coded in 1.5, not a rule-table row; levels must not weaken it.

### Routing / self-tuning (propose-only, no weight training in v1)

- Task classes are derived **post-turn from the audited tool-call list** — `chat` (no tools) / `retrieval` / `commit` / `skill` / `ops` — no classifier model, nothing to game pre-turn.
- `task_class_stats(scope_id, task_class, harness_id, attempts, successes, avg_steps, avg_cost_usd_micros)` updated per turn.
- **Router v1 makes exactly two decisions:** transport-failure escalation (2A taxonomy) and sticky per-class escalation when local success `< 50%` with `n ≥ 5`. A single run measures the draw, not the model — below the sample floor, local-first stands. Cost numbers are trustworthy because the model cost table was fixed in 2A *before* stats accumulated.
- Harvested lessons become memory/skill **proposals** through `runDreamCycle` (`src/memory.ts:241` — already propose-only; keep). Approved-session corpus accumulates toward a later MLX LoRA — explicitly out of scope for v1.
- `chamber level` — level, XP, next unlock + what's missing (days/approver events), recent `xp_event` rows, routing stats. `chamber approver add/remove/list`. `chamber done <turnId>` (verified surfaces only).

**Exit:** fresh scope resolves L0 and a `compute` call is denied+audited · scripted XP to threshold produces a `pending_write(target:'capability')` **and no level change** · approving it unlocks `compute` · injected violation (with injected clock) demotes one level, sets the 72h freeze, and the demotion is in the audit chain · replayed `xp_event` insert with a duplicate `(scope, kind, subject)` is rejected · `task_done` and forged-approver paths refuse XP.

---

## Phase 5 — Skill execution and the L3/L4 unlock (was Phase 4)

Skills are the largest unknown in the tree — **nothing writes `skill_snapshot` today**, so in `teeth` mode every activation refuses at `src/try_activate_skill.ts:76`. Sequenced last deliberately; L3's auto-skill-activation unlock flips only on this phase's exit.

- **Teeth mode is already scheduled to arrive by itself:** `suspension_flip_at` is seeded `datetime('now','+7 days')` (`sql/schema.sql:216`) and checked at `src/try_activate_skill.ts:45-54` — the kernel flips from shadow to teeth **7 days after first boot** whether or not anything can pass. Critic-clear must exist *before* any flip narrative; re-seed the flip as part of this phase's rollout, not the DB's birthday.
- `matchSkills` is `(db, utterance)` (`src/skills_registry.ts:129`) — **no scope argument**. Add `scopeId` so skill candidacy respects scope policy; today every scope sees every skill.
- **Registry/snapshot key mismatch:** `skill_registry` rows have `skreg_` ids (`src/skills_registry.ts:36`) while `skill_snapshot` is keyed by `name` (`sql/schema.sql:92,110`) and `tryActivateSkill` looks up by name+hash. `criticClearSkill` must reconcile the two keys (write the snapshot under the name the gate queries, carrying the registry id) — otherwise a "cleared" skill is cleared under a key the gate never reads.
- `criticClearSkill(db, skillId, contentHash, capabilityManifest)` — a different model family per locked Fork D — writes `skill_snapshot` with `cleared_hash` + manifest; the clear itself is proposed and human-approved (propose-only applies to critics too).
- **Absent manifest inverts to baseline-only** in `tryActivateSkill` step 4 and `authorizeToolCall` step 5 **in the same commit** (an allow-all default in either is the same hole).
- Hold-commit policy: activation under an open hold on a load-bearing belief refuses in teeth (exists); assert it stays true through the async migration.
- Then flip `suspension_mode` shadow → teeth (Fork C), and unlock the L3 row's auto-skill-activation (Phase 4 table).

**Exit:** critic-clear writes a snapshot that `latestClearedSnapshot` **actually finds** (the name/id join proven by test) · a cleared skill activates in teeth mode and steers a scripted turn (its manifest tools authorized, out-of-manifest tool denied) · a skill with a stale load-bearing dependency refuses in teeth with a persisted hold · `activateSkillRegistry` can no longer activate without the gate (1.5 regression) · **only after this suite is green does the L3 unlock row flip.**

---

## Acceptance — pilot week (not CI)

Run the `deploy/PILOT.md` loop as the owner's daily driver for one week — CLI + Telegram, LM Studio primary, Claude escalation. Friction log, spend footer accuracy, queue age, promotion-proposal review latency. Kill criteria from PILOT.md apply. PILOT.md gains a Telegram addendum (2B). This stage exists because several exit criteria above are *mechanical* stand-ins for the actual question — "is this thing a usable governed agent" — which only use can answer.

---

## Missing-work slotting

| Item | Phase | Why there |
|------|-------|-----------|
| cli.ts revival + smoke test | 0 | everything downstream runs through `chamber` |
| async test runner + canary | 0 | Phase 2's async tests would silently pass |
| SCHEMA_FILES meta-test | 0 | protects P4's schema from silent non-registration |
| `migrateRebuildTable` helper | 0 | needed by 2A (spend channel), P3 (`debt`), P4 (`capability`) |
| post-rollback audit ordering | 1.2 | audit row must survive the ROLLBACK |
| per-kind pin formula registry | 1.3 | doc vs code-chunk hash formulas differ |
| server fail-closed + CORS scope | 1.5 | XP farming + forged approvers ride the open server |
| hard-coded consequential guard + missing-stakes=consequential | 1.5 | seeded row is disableable; absent field bypasses |
| checkpoint signing | 1.4 | net-new; droppable on overrun |
| scrubEnv HOME drop | 1.1 | sandbox env leak |
| model.ts timeout / optional key / cost table | 2A | before routing stats accumulate |
| `authorizeToolCall` chokepoint in `runTool` | 2A | one door for loop, mcp_bridge, CLI |
| `spendForTurn` + spend `scope_id`/`tool` channel migration | 2A | per-turn budgets need per-turn queries |
| five-surface unification + `CHAMBER_LEGACY_TURN` | 2B | one engine, five adapters |
| `telegram_ops.ts` (auth/rate/quarantine/scopes/async poll/approvals) | 2B | Telegram is the weakest surface and ships last |
| actor identity (`approver` table + `decided_by_verified`) | 2B/4 | approvals need it at first migration; XP needs it for every award |
| `resolveMemoryProposal` honors `pending_write_id`, errors on demote/merge | 2B | silent ignore is a silent failure |
| embedder-model partition + FTS fallback | 3 | cross-model cosine is noise |
| `chamber ingest` + `ingest` JobKind + lease reclamation | 3 | the "ingester" is a 10-doc fixture |
| `debt` WriteTarget SQL CHECK migration | 3 | TS-only edit fails at runtime |
| progression schema + economy + `chamber level/approver/done` | 4 | — |
| `criticClearSkill` + key reconciliation + hold policy + L3/L4 flip | 5 | — |

## Explicit deferrals (decided, not forgotten)

- **Scope `parent_id` inheritance walking** — `effectivePolicy` applies the env-global floor + the scope's own policy; the parent chain is never walked. Documented as non-inheritance; the global posture floor is the actual mechanism. Revisit if nested scopes get real use.
- **Corpus re-embedding pipeline** (embedder upgrades) — partition fix in P3 makes it safe to defer.
- **Content-hash XP dedup** — rejected as over-engineering; caps + UNIQUE + human approval bound it.
- **Session-FTS pinnability** — optional-if-time in P3; sessions stay context-only otherwise.
- **Seatbelt workdir-EPERM tuning** — docker-only is an acceptable P1 ship state.
- **MLX LoRA** — out of scope for v1 (unchanged).

---

## Critical files

**New:** `src/agent.ts` (loop), `src/authorize.ts` (chokepoint), `src/pins.ts`, `src/progression.ts`, `src/routing.ts`, `src/telegram_ops.ts`, `sql/schema_progression.sql`, `tsconfig.json`, scripted harness in `tests/`.

**Heavily modified:** `src/sandbox.ts` (runDocker + isolation + require + fail-closed), `src/commit_belief.ts` (audit ordering + pin verification), `src/try_activate_skill.ts` (audit + manifest inversion + computeVotes split), `src/tools.ts` (argsSpec, registry fix, risk from registry, authorize in runTool), `src/debt.ts` (proposal disposition, auto-pay removal), `src/model.ts` (async, timeout, key-optional, cost table), `src/faculty.ts` (computeVotes/recordDeliberation), `src/cli.ts` (revival, loop adapter), `src/server.ts` (fail-closed auth), `src/gateway.ts` (→ telegram_ops), `src/db.ts` (no fallback, rows helper, SCHEMA_FILES), `src/audit.ts` (inTx flag), `src/secret_box.ts`, `src/approvals.ts` + `src/approval_workflows.ts` (targets, hard guard, verified approver), `src/memory.ts` (resolveMemoryProposal), `src/skills_registry.ts` (scope arg, gated activation), `tests/harness.ts` (async + negative tests throughout).

**Reused as-is:** `merkle*.ts`, `scope.ts` (plus the one `proposeWrite` call-site fix), `job_queue.ts` (plus lease reclaim), `spend.ts` (plus spendForTurn), `vector.ts`, `embedder.ts`, `sessions.ts`, `code_index.ts`, `contract.ts` (post-P0).

---

## Verification

Per phase — `npm run check` before and after every change; no phase exits red. Phase-specific exit criteria live in each phase above; **all are runnable commands or assertable tests.** For the record, the criteria they replaced and why: old Phase 2's exit invoked `search` (a Phase 3 deliverable) from a CLI that couldn't run; "regex intent detection deleted" covered one of five surface ladders; "demonstrably steering a turn" wasn't an assertion; and sandbox tests could green by *skipping* when docker was absent — skips now fail the sandbox suite.

**Benchmark honesty — corrections run both directions, in one pass:**
- *Down:* `benchmarks/BENCHMARK.md` scores T1 ("allowlist + sandbox before activate") and A3 ("offline verify receipt") at 2 (`benchmarks/BENCHMARK.md:61-64`) — honest today: 1 and 1; the sandbox doesn't isolate and there is no offline receipt verifier. A1 (hash chain) is arguable: the chain is real but an unkeyed sha256 in the same DB file — annotate rather than re-score until checkpoint signing lands.
- *Up:* the same doc is stale *against* Chamber — it says **55/55** tests (`:90`; actual 99/99) and scores S1 at 1 citing "multi-messenger gateway" as a gap (`:66,92`) though Slack and Discord surfaces have shipped since.
- Re-run `benchmarks/scorecard.ts` after Phase 1 and correct the whole scoreboard; a one-directional correction reads as selective, and the doc's own "fair use of results" section demands better.
