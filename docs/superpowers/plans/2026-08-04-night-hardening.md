# Night Hardening — spec and plan

**Date:** 2026-08-04
**Branch:** `feat/night-hardening` off `main` at `48da69b`
**Policy:** branch only. **`main` is never touched.** The owner is asleep and cannot answer questions; everything here was decided before the run began.

Spec and plan are one document deliberately. The tasks were fully specified in the design conversation, and a single durable artifact survives context loss better than two.

## Why this work

The durable-daily-driver branch merged, and its own merge commit records a caveat: *"server.ts, the gateway runners, and slack/discord ops still read CHAMBER_DB directly and default to /tmp, so durability is currently a CLI-only property."* That is the last real gap between "Chamber survives a reboot" and "Chamber survives a reboot."

Three smaller honesty gaps came out of the final whole-branch review, and a fourth problem is structural: every deferred finding from two plans lives only in `.superpowers/sdd/progress.md`, which is gitignored scratch that `git clean -fdx` destroys.

## Global constraints

- Zero runtime dependencies. `package.json` `dependencies` must stay absent/empty. `node:` builtins only.
- Precedence stays environment → config → default. Every existing `CHAMBER_*` variable keeps working.
- An empty or whitespace-only environment variable is not a setting and must fall through.
- No API key readable from a config file; a file-sourced `model.base` stays loopback-restricted.
- No new `sql/*.sql` files.
- `npm run test` passes 265/265 at branch point and must stay green.
- The runner is strict: a test returning a Promise without `async` fails outright; every registered test must produce a result. Write synchronous tests.
- Tests must never read or write a real user config and must never ingest `~/Vault`.
- `chamber` is installed globally as a symlink into this working tree, so it runs whatever branch is checked out. Do not check out another branch in the main tree; use a scratch worktree.
- The launchd job is deliberately **unloaded**. Do not reload it.
- Commit format: `type: description`, with body, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Task A — durability beyond the CLI

**The gap.** Six call sites read `process.env.CHAMBER_DB ?? "/tmp/chamber.sqlite"` and none imports `loadConfig`:

- `src/server.ts:50` (module-scope `db`), `:417`, `:426` (both log the path)
- `src/gateway_runner.ts:113`
- `src/slack_ops.ts:36`
- `src/discord_ops.ts:36`

So the CLI writes to `~/.local/share/chamber/chamber.sqlite` while every daemon writes to `/tmp` — two different corpora, and the daemon's evaporates on reboot. The `??` also fails to fall through on `CHAMBER_DB=""`, which `src/config.ts` fixed for the CLI and these files never received.

**What to do.** Route all six through `loadConfig().database`, so one resolver decides the location for every entrypoint. `openChamberDb` already creates the parent directory and accepts an `onRedirect(actual)` callback; the two logging sites in `server.ts` must report the path actually opened, not the requested one — they are logs an operator trusts.

**Judgement required.** `src/server.ts:50` opens the database at module scope, so a malformed config would throw during import rather than at a catchable point. Decide whether that is acceptable (fail-closed on startup is defensible for a server) or whether it needs restructuring, and justify the choice.

**Tests.** For each of the four files: the configured database is used when `CHAMBER_DB` is unset; `CHAMBER_DB` still wins when set; `CHAMBER_DB=""` falls through rather than resolving to an empty path. Prove non-vacuity by reverting.

**Deliverable.** The merge commit's "durability is CLI-only" caveat is no longer true.

---

## Task B — honesty gaps in what Chamber reports

Four small defects from the final whole-branch review, each a case of Chamber knowing something and not saying it.

1. **`config show` never prints ingest roots or excludes.** `explainConfig()` emits `database`, `model.base`, `model.name` and `config` — nothing about `ingest`. An operator cannot inspect their own privacy boundary without opening the file, and the spec's criterion 5 says "every setting".
2. **The overlap error names canonicalised paths, not what the operator wrote.** `assertNoOverlap` reads `roots[i].root`, which `parseIngest` already replaced with the canonical path — contradicting the code's own comment and leaving no way to tell which config entry to remove when symlinks or case-folding are involved. Carry the original string through for the message.
3. **`help()` documents only `chamber ingest <path>`.** The no-argument configured-roots form — the one the scheduled job uses — is undocumented. **Any help-text edit must avoid backticks: a stray one produces a `SyntaxError` that kills the CLI while the suite stays green, which has shipped twice.**
4. **`ingest` parses the config twice.** `case "ingest"` calls `loadConfig()` directly instead of the already-resolved module-level value, costing a redundant parse plus a `realpath`/`stat` pass over every root.

**Tests.** One per defect. For (3), a subprocess assertion that `chamber help` exits 0 and mentions the no-arg form.

---

## Task C — make deferred findings survive

Every deferred item from both plans exists only in a gitignored scratch ledger. Promote them into a committed `docs/KNOWN_LIMITATIONS.md`, written for someone who has never seen this repository, each as what it is, what it costs, and what would fix it.

Content to carry across, all verified during the sessions that produced them:

- **The sandbox does not isolate on this machine.** `probes/sandbox_escape.ts` reports ESCAPE CONFIRMED. Nothing shipped executes model-generated code, so nothing today is exposed — but it gates every capability level above L0 and is the defect `docs/NEXT_LEVEL_PLAN.md` Phase 1 exists for.
- **`chamber checkpoint` is manual, unsigned, and defaults to `/tmp`**, while the audit chain tip and `merkle_checkpoint` live in the same SQLite the agent writes. Tail truncation is undetectable.
- **`mcp_tool_pin.schema_hash` and `description_hash` are write-only.** Nothing reads them; the `tool_drift` reason the type declares is never produced. Per-tool MCP drift detection does not exist.
- **`mcp_client.ts` sets `content_hash` to `String(body.length)`** — a length, not a digest, so equal-length bodies collide trivially. Inert today because `activateSkillRegistry` ignores it; a landmine if MCP imports are ever routed through `tryActivateSkill`'s mutation gate.
- **Wrong-but-real citations are not detectable.** A pin proves a passage is what it claims to be, not that a claim follows from it. Observed live: a model cited a real passage and misread the numbers in it. This is a stated non-goal, not a bug, and must not be described as solved.
- **Deleted and renamed notes leave stale rows** that are still retrieved and still verify. The corpus has no notion of deletion.
- **A shrinking note gives tail citations `not_found`** rather than `hash_mismatch`, even when the content is still present verbatim at a lower ordinal.
- **Overlapping ingest roots** duplicate silently — now rejected at config load, but still possible via two explicit-path runs.
- **`ingest` has no default exclude list.** Pointing it at a vault root ingests every non-dotted folder unless excludes are passed.
- **No request timeout.** A stalled model endpoint hangs `chamber ask` indefinitely.
- **CJK lexical retrieval is near-useless** — FTS5's `unicode61` tokenizer treats a CJK run as one token. Consistent, not crashing, but not useful.
- **Nothing catches a ranking regression.** The hybrid-retrieval tests are the only guard against silent quality drift.
- **The scheduled job's log records neither the exit code nor which database was checked.**

Reference `docs/NEXT_LEVEL_PLAN.md` where a limitation has planned work, so the document points forward rather than only cataloguing.

---

## Execution

Fresh implementer per task, then an Opus review, then a fix pass if the review finds anything. Findings recorded in `.superpowers/sdd/progress.md` as they land.

**Stop conditions.** Stop and write up rather than guessing if: a review raises something needing an owner decision; a fix would require changing a documented decision from an earlier plan; or the suite cannot be returned to green.

**Never:** merge to `main`, reload the launchd job, ingest `~/Vault`, publish anything, or touch a real user config.
