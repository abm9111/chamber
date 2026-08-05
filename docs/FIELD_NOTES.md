# Field notes — what four agent harnesses teach us

Read on 2026-08-04: **qm** (multiplayer agent harness, ~239k lines TS), **jcode** (local coding agent, ~678k lines Rust), **background-agents / Open-Inspect** (distributed control plane, TS+Python), plus **openmed**, **openalgo** and **hiring-without-whiteboards** for distribution, and **skills-main** / **karpathy-llm-wiki** for knowledge packaging.

Source archives are in `~/Downloads/*.zip`. They were read from a scratch extraction that no longer exists, so file references below are for provenance — re-extract to follow them.

Claims are marked **[verified]** where they were checked against this repository directly, and **[reported]** where they come from a reader's analysis of an external repo and were not independently re-run.

---

## Part 1 — Verified defects in this repository

All five checked directly on 2026-08-04. These are not opinions.

**Per-scope isolation does not exist.** `scope_id` is written on session insert and **never read** — no query filters by it. `requiresHumanForRoutine()` in `src/scope.ts` has **zero production callers**. Re-checked 2026-08-05: still zero. **[verified]**

> **Correction, 2026-08-05.** This entry also asserted that `benchmarks/QM_PORTING.md` "records this capability as delivered", under a **[verified]** tag. That sentence was not verified and is not true — see the correction at the end of this section. A verification mark on an unchecked claim is worse than the claim, because it tells a reader the checking already happened. The rest of the entry stands.

**The job queue wedges permanently on a crash.** `src/job_queue.ts` contains no lease TTL, no heartbeat, and no reaper — zero matches for `heartbeat|lease_expires|reclaim|reap`. A worker that dies mid-job leaves that row in `running` forever. qm evolved past exactly this design. **[verified]**

**Six surfaces throw under `CHAMBER_MODEL=openai`.** `completeSync` is called at `src/cli.ts:398`, `src/faculty.ts:178`, `src/server.ts:261`, `src/slack_ops.ts:117`, `src/discord_ops.ts:185`, `src/gateway_runner.ts:177`, and `src/model.ts` throws for openai mode. `chamber ask` survives only because it uses async `complete()`. **[verified]**

**Every HTTP turn starts a new session.** `src/server.ts:201` calls `startSession` unconditionally, so `POST /turn` has no history. **[verified]**

**There is no agent loop.** `runTool` appears twice in `src/` — its definition and one CLI call site. No `tool_call` handling exists anywhere. The gates are excellent; the loop they gate has not been built. **[verified]**

**Pattern worth naming.** `benchmarks/BENCHMARK.md` cited "Brain VNext", a project that does not exist. For a project whose thesis is that no claim becomes load-bearing without verifiable evidence, documentation drift is not a cosmetic problem. **Treat every capability claim in `docs/` and `benchmarks/` as needing the same verification a code change gets.**

> **Correction, 2026-08-05.** This paragraph originally read "the second Chamber document found to overstate in a single day" and named `QM_PORTING.md` as recording sketched work as delivered. Checked line by line, that is wrong. `QM_PORTING.md` is a *port map*: it carries a "Chamber today" column stating the current state, a separate "Port?" column answering whether to port, and then "Concrete Chamber modules to add (ordered)" with day estimates and a suggested sprint. It describes work to do, not work done, and its own columns keep the two apart.
>
> `BENCHMARK.md`'s retraction stands and is dated 2026-08-02 in that file. So the count was one document, not two.
>
> This correction is the point of the paragraph it corrects. An unverified claim about another document's unverified claims is the same defect one level up, and it survived here for three days inside the essay arguing that capability claims need checking. The verified finding below — that `requiresHumanForRoutine` has zero production callers — is unaffected: `QM_PORTING.md` never said otherwise.

---

## Part 2 — Decisions you will face

### A turn should be a durable row, not a function call

qm's `Run` carries `status`, `attempts`, `errorAttempts`, `maxAttempts`, `leaseToken`, `leaseExpiresAt`, `workerId`. The worker claims, heartbeats on an interval, and **three consecutive lost heartbeats abort the running turn via `AbortSignal`** — which threads into the harness and into sandbox exec. Transient heartbeat *errors* reset the counter; only genuine lease loss aborts, so "the database blipped" and "another worker took my lease" are distinguished explicitly. **[reported]**

Two counters, not one: `errorAttempts` counts real failures, `attempts` counts claims. A poison-pill run that crashes the worker *before* it can record a failure still gets parked by claim count. That is a bug class most people discover in production.

**For Chamber:** this is the single most concrete gap. Adopt lease + heartbeat + reap before anything else in the queue.

### Retry should be decided by exception type, not by a catch-all

qm has a six-line `NonRetryableTurnError` whose message is **the only error text a user ever sees**; everything else collapses to a generic string and lands in an operator log. Two files, large behavioural payoff. **[reported]**

### An approval is loop termination, not a blocking prompt

When qm needs human approval it pushes a pending approval, sets `pausedOnApproval`, and returns `terminate: true`, which unwinds the harness loop. The turn returns `{ status: "pending_approval", pendingApprovals }`; the surface renders buttons; approving **re-submits the original turn body** with an approval token. The pause survives process restart because it lives in a durable map, and a `session`/`always` scope becomes a persisted grant. **[reported]**

**For Chamber:** `pending_write` and `decideWrite` already exist. What's missing is the *resumable* half — a pause that is a turn outcome and can be re-entered with the original request.

### Multi-principal confidentiality is about forty lines

Every history entry carries a scope label assigned by a small classifier. Model context is then the **intersection** over everyone present:

```ts
return entries.filter((e) => audience.every((p) => principalEntitledToScope(p, e.scopeLabel, …)));
```

`audience.every` — a floor, not a union. If one person in the room cannot see it, nobody's model context contains it. qm also tracks bitemporal participant windows, so someone who joined at entry 50 and left at 120 sees exactly that slice, permanently, including in later recall. **[reported]**

**For Chamber:** cheap, and required the moment a second principal exists. Telegram or a Slack channel makes this immediately real.

### Denial lists must normalise before matching

qm's `scannableCommand()` strips heredocs, unwraps double/single/ANSI-C quoting, removes backslash escapes, and **recursively re-scans payloads passed to nested shells to depth 8** before matching against a deliberately tiny rule set. **[reported]**

Chamber's sandbox denials match raw strings, so `sh -c "$(echo … | base64 -d)"` walks straight through.

### Outbound messages need a transactional outbox

qm enqueues with an idempotency key, claims with a TTL, and acks. A worker dying between "model produced a reply" and "Slack accepted it" neither loses nor duplicates the message. Chamber posts inline. **[reported]**

### Capture the prompt cache boundary before appending volatile blocks

qm records `stableSystemBytes = systemPrompt.length` *before* appending the time block and memory block, and passes it as `systemCacheBoundary` so the stable prefix stays cacheable. One line, real money. **[reported]**

### Isolation: nobody has solved it, and the honest ones say so

- **jcode: none.** It runs `bash -c` as the real user. Zero hits for seccomp, landlock, bubblewrap, chroot in application code. Its own crate docs record that a user lost their home directory. The gate added afterwards covers only `bash`, and its `Confirm` tier is unlocked by **the model supplying a ≥25-character justification string** — self-attestation, defeated by one sentence of injection. **[reported]**
- **background-agents: perimeter only.** Fresh remote microVM per session, and inside it `{"*": {"*": "allow"}}` — deliberately ungated, because the VM *is* the boundary. **[reported]**
- **qm: honest.** Its `SECURITY.md` states plainly that command policy *"is a speed bump against mistakes and injection, not a sandbox boundary."* **[reported]**

**For Chamber:** `probes/sandbox_escape.ts` reporting ESCAPE CONFIRMED puts this repo in ordinary company, not behind. The lesson is not "catch up" — it is **qm's disclosure discipline**. State the ceiling of your control in the document where you claim the control.

### Nobody enforces spend, and that is a gap worth owning

jcode declares `api_daily_budget` and never enforces it; the real per-cycle budget is the English phrase `"stay under 50k tokens"` in a system prompt, on an **unattended, unsandboxed** loop. background-agents has no token or cost cap at all. **[reported]**

Chamber's per-channel spend ledger and turn footer are ahead of the field here. Don't lose that.

---

## Part 3 — Where Chamber genuinely leads

**Tamper-evident audit.** qm's default audit log is a **50,000-entry in-memory ring buffer**; there is no hash chain, no Merkle tree, no tamper-evidence anywhere in its audit code — despite its own house rule being "durable by default". jcode and background-agents have none either. Chamber's `entry_hash = sha256(prev_hash || canonical JSON)` plus incremental Merkle is the one thing across all four repositories that nobody else built. **[reported]**

**Fail-closed as default posture**, rather than fail-open-with-audit.

**Epistemic machinery** — beliefs, citation debt, content pins, faculty deliberation — has no analogue in any of the four. qm has approvals and audit; it has nothing that models an *obligation to cite*.

**One warning about what not to copy:** qm's skill signature is HMAC over the manifest only, so `status`, `scopeId` and `grantedCapabilities` sit *outside* the signature, and the secret falls back to a per-process random value when unconfigured — silently invalidating every signature on restart. **[reported]**

---

## Part 4 — Publishing, trust, and contribution

**Redefine your domain's worst failure as a security defect.** openmed's `SECURITY.md`: *"A defect that causes identifiers to leak — a redaction bypass — is a **security** defect, not an ordinary bug"*, with a floor: *"Privacy-impacting defects are never rated below High."* Chamber's analogue: **a false PASS — a verification that succeeds when the claim beneath it is false — is a security defect.** One hour of work, available at zero users. **[reported]**

**Never make an unverifiable claim.** openmed's headline "340M+ downloads" exists **only inside a PNG**; the README carries zero dynamic badges. For a project whose value proposition is verification, that pattern is a trust liability. Prefer a live badge, and prefer no claim to an unverifiable one. **[reported]**

**A gate that doesn't gate is worse than no gate.** openalgo sets `continue-on-error: true` on backend lint, Bandit and pip-audit, and runs five of its eighty test files. Its green badge is decorative. Three honest jobs that fail beat twenty-eight that don't. **[reported]**

**Contribution mechanics that don't consume the maintainer** — from `hiring-without-whiteboards`, 15 files, 765 entries, one person: a **510-byte `CRITERIA.md`** converting merge decisions from taste into rule application; the format spec shipped as **its own published lint plugin**; a link checker that fails the build on rot; `stale.yml` with `only: pulls` so abandoned contributions close themselves; removal as a first-class path with right of reply. Net effect: **roughly fifteen seconds of maintainer time per PR.** **[reported]**

**One install path.** openalgo's `INSTALL.md` describes a toolchain its own 2.0 rewrite obsoleted, while the README describes another. Both sit at the repo root; a newcomer's natural first click is the wrong one. Every additional entry-point doc is a future contradiction.

**Ship for coding agents.** openmed treats them as a distribution channel — `AGENTS.md`, `llms.txt`, ~40 Agent Skills, an installer targeting Claude Code, Codex and OpenCode from one repo. Uncontested channel, and well aligned for a verification tool, since agents are the actors that should be running verification steps. **[reported]**

---

## Part 5 — On packaging knowledge for agents

`karpathy-llm-wiki` states an invariant almost identical to Chamber's citation gate — *"Every load-bearing fact in wiki/ exists verbatim in the raw/ files linked by that article's Raw field"* — and enforces it with a **432-line grep-based checker**, not hashes. It extracts quoted strings, dates and numbers and verifies each appears verbatim in the linked source. **[reported]**

Two lessons worth holding.

**Its precision is better than ours in one respect.** Chamber pins a hash of the whole document, so any edit flags every conclusion resting on it — including a typo fix that never touched the cited claim. Grep checks whether *the specific claim* survived. Fewer false alarms is not a small thing for a scheduled check nobody is watching.

**It splits enforcement explicitly.** Prose handles judgement; code handles the mechanical string comparison a model degrades at. The docstring names what it deliberately does not check and why. Chamber has never drawn that line.

Also worth copying from both skill repos: a **Design Boundaries section naming what you chose not to build**, and description lines written as *literal trigger phrases* when a skill mutates state, versus *situational* phrasing when it only advises — because a false positive on a state-mutating skill writes to disk.

---

## The shortest version

The field has solved durable cancellable work, resumable approvals, and multi-principal confidentiality — and Chamber has none of them. Chamber has solved tamper-evident, fail-closed accountability — and the field has none of it. Nobody has solved isolation or spend enforcement.

The instinct recorded in `QM_PORTING.md` — take the fleet machinery, keep the constitution — was right. The machinery was sketched rather than ported, and the gates now guard a loop that does not exist.
