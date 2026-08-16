# Chamber vs Hermes Agent — Full Benchmark Review

**Date:** 2026-07-31  
**Chamber:** local kernel in `artifacts/chamber` (55 acceptance tests)  
**Hermes:** Nous Research Hermes Agent (source tree + public architecture docs / field UX)

## Method

This is **not** an LLM Elo contest. Both systems can wrap the same models.

We score **control-plane architecture** on 20 criteria (0–2 each):

| Score | Meaning |
|-------|---------|
| 0 | Absent or pure theater |
| 1 | Partial, optional, or soft |
| 2 | Hard default, transactional, or cryptographically checkable |

Chamber scores are backed by **live probes** (`benchmarks/scorecard.ts`) and harness.

**Hermes scores are NOT backed by execution.** They were assigned from architecture docs, community field reports, and (as of the 2026-08-02 revision) direct reading of the Hermes source tree — but Hermes has never been *run* for this comparison. That is a material weakness in a document whose subject is epistemic integrity, and it is the reason several Hermes scores were wrong in Chamber's favour until they were corrected. Treat every Hermes score as provisional until a runtime bake-off exists.

Run:

```bash
node --experimental-strip-types benchmarks/scorecard.ts
npm test
```

---

## Executive verdict

| Axis | Winner | Why |
|------|--------|-----|
| **Governable cognition** | **Chamber** | Citation debt, faculty votes, skill approve-by-default, MMR audit |
| **Operator product surface** | **Hermes** | Multi-messenger gateway, skill hub, closed learning loop, mature packaging |
| **Self-improving skills** | **Hermes** | Defining feature — Chamber *refuses* this without human gates |
| **Cost / audit transparency** | **Chamber** | Channel spend ledger + hash chain + checkpoint export |
| **Day-1 “agent that works in Telegram”** | **Hermes** | Chamber is CLI + localhost HTTP + Caddy deploy |

**Bottom line:** Hermes is the stronger **autonomous operator product**. Chamber is the stronger **epistemic governance kernel**. A premium stack may eventually **run Hermes-like surfaces on Chamber-like gates** — not the reverse.

---

## Scoreboard (architecture)

| ID | Criterion | Hermes | Chamber |
|----|-----------|--------|---------|
| E1 | Unsourced assertions debt/blocked | 0 | 2 |
| E2 | Typed epistemic claims | 0 | 2 |
| E3 | Formal APORIA blocks work | 0 | 1 |
| G1 | Skill writes need approval by default | 1 | 2 |
| G2 | No self-approve of self-authored skills | 1 | 2 |
| G3 | Multi-faculty blocking votes | 0 | 2 |
| G4 | Constitution ratification friction | 1 | 1 |
| C1 | Spend visible by channel | 1 | 2 |
| C2 | Background loops metered | 0 | 2 |
| M1 | Memory capacity ledger | 1 | 1 |
| M2 | Forgetting with dependency impact | 1 | 2 |
| M3 | Dream propose-only | 0 | 2 |
| A1 | Audit hash chain | 1 | 2 |
| A2 | Incremental Merkle root | 0 | 2 |
| A3 | Offline verify receipt | 1 | 1 |
| T1 | Allowlist + sandbox before activate | 1 | 1 |
| T2 | SCIP/code-graph consumer | 0 | 1 |
| S1 | Messaging surface breadth | 2 | 1 |
| S2 | Self-improving skill loop | 2 | 0 |
| S3 | TLS/token production hardening | 1 | 2 |
| | **Total / 40** | **14** | **31** |

Percent: Hermes **35%** · Chamber **77.5%** on *this* rubric (governance-weighted by design).  
Live Chamber probes: **9/9** (`benchmarks/scorecard.ts`).

### Corrections log — 2026-08-02

Four scores moved after checking claims against code rather than impressions. Three moved against Chamber.

| ID | Was | Now | Why |
|----|-----|-----|-----|
| G2 (Hermes) | 0 | 1 | `tools/skill_provenance.py` enforces a write-origin boundary — the curator may only auto-manage skills the agent itself created in the background-review fork; user-directed skills are off-limits. Scoring that 0 ("absent or pure theater") was wrong. It stays at 1, not 2, because agent-authored skills still execute without human ratification. |
| T1 (Chamber) | 2 | 1 | The sandbox does not isolate. `CHAMBER_SANDBOX_REQUIRED=1` is unreachable, no `runDocker` exists, and a live probe read `$HOME`, wrote to it, and resolved DNS while reporting `backend: "docker"`. |
| A3 (Chamber) | 2 | 1 | There is no offline receipt verifier. `chamber checkpoint` writes an **unsigned** JSON to `/tmp` by default and must be run by hand. |
| A1 (Chamber) | 2 | 2 (qualified) | The chain is real, but it is an unkeyed SHA-256 whose tip and `merkle_checkpoint` live in the same SQLite file the agent can write. Tail truncation is **detectable, with a caveat** — measured, not assumed; see "Known limitations". |

Hermes ships **nine** governance-related modules in core, not the two this document originally implied: `approval.py`, `write_approval.py`, `managed_tool_gateway.py`, `clarify_gateway.py`, `delegate_tool.py`, `skills_guard.py`, `skill_provenance.py`, `skills_ast_audit.py`, `website_policy.py`. Only `skills_guard.py` and `skill_provenance.py` were read directly for this revision; **G1, G4, M1-M3 and A1-A3 for Hermes remain unverified against source** and should be assumed generous to Chamber until checked.

---

## Chamber review (what exists)

| Layer | Evidence |
|-------|----------|
| Gates | `commit_belief`, `try_activate_skill`, holds, debt |
| Spend | `spend_event` + turn footer |
| Approvals | `pending_write`, workflows, default ON |
| Audit | hash chain + **MMR** peaks |
| Contracts | strict refuse / APORIA / DEBT |
| Tools | allowlist + sandbox synth |
| Memory | working→episodic→semantic + dream proposals |
| Faculty | 5 chairs, reject blocks, activate wiring |
| SCIP | ingest consumer |
| Surface | CLI, HTTP, Caddy/nginx/systemd/compose, API token |
| Tests | **99/99** harness |

**Gaps vs a full product:** skill marketplace, rich TUI, automatic skill growth (intentionally out of scope). Slack, Discord and Telegram surfaces have since shipped, so "multi-messenger gateway" is no longer a gap — though breadth (5 surfaces vs ~18-20) still favours Hermes, which is what S1 scores.

## Known limitations (disclosed, not scored)

- **Tail truncation: what is and is not detected** (measured 2026-08-07; the earlier claim here was wrong in both directions and is corrected).
  - A plain `DELETE` of the last N events **is** caught, and always was: the MMR leaves and the chain tip are separate state the delete does not touch, so `verifyAuditChain` reports *"tip last_hash does not match final entry_hash"*.
  - A rollback that resets those witnesses too leaves a database that verifies perfectly against itself. That is caught only by an **externally held earlier receipt**: `chamber checkpoint verify` re-derives the attested root from the tree's own leaves and compares it against every entry in the anchor log, so truncate-then-write-more is reported by the oldest honest anchor rather than passing as growth.
  - **The remaining limit is real.** Checkpointing is manual, so nothing forces a receipt to exist before a rollback; and the anchor log sits on the same machine, so whoever can rewrite the database can usually rewrite it too. Signing does not close this — the agent holds the key and can re-sign. Genuine externality needs off-box anchoring (a timestamping service, a signed commit pushed to a remote, separate media).
- **Faculty voting is not a soundness argument.** The rubric credits multi-faculty blocking votes (G3), but model errors are *not* independent: Kim et al. (ICML 2025) and Ron/Baudry/Monperrus (2026) reject independence across Cursor/Claude Code/Codex/Gemini/OpenCode (429 coincident failures vs 115.36 predicted, p≈1.8×10⁻¹⁸⁷). Voting is a useful noise filter, roughly 3×; it is not "N-of-M implies safer." Real assurance needs an **out-of-family** verifier — compiler, tests, policy engine, or human.
- **Governance runs in-process.** Chamber sits inside the trust boundary of the agent it governs. A prompt-injected agent bypasses it by construction. Container isolation per agent is a prerequisite, not an optimisation.
- **"Zero runtime dependencies" is dependency relocation** (corrected 2026-08-16). This bullet used to point at `vendor/xenova-transformers/`, which was deleted on that date: nothing imported it, so it was an obligation rather than a dependency. The claim it made survives the deletion and is still the honest reading — the embedder spawns `python3 scripts/embed_minilm.py`, which needs `numpy`, `onnxruntime` and `tokenizers` in whatever interpreter the `PATH` resolves, plus the ~23 MB Apache-2.0 weights committed under `models/minilm/`. None of that is visible to `npm audit`, Dependabot or SBOM tooling either. The package has no npm dependencies; it does not have no dependencies. See `NOTICE`.

---

## Hermes review (architecture)

| Strength | Detail |
|----------|--------|
| Learning loop | Skills from experience; curator; skill hub scale |
| Surfaces | 18–20+ messaging platforms, CLI, API |
| Memory tiers | MEMORY.md / USER.md / session FTS5 / skills / Honcho-style modeling |
| Ecosystem | Packaging, docs, contributors, optional security plugins |

| Structural weakness (vs Chamber rubric) | Detail |
|-----------------------------------------|--------|
| Epistemic opacity | Notes ≠ warranted beliefs; no citation debt objects |
| Self-improvement authority | Agent can author skills that then run |
| Cost visibility | Field UX: token burn vs compounding unclear |
| Audit | Sessions/logs ≠ default Merkle checkpoint |

**Retracted 2026-08-02.** A previous revision claimed: *"Community mitigations (Brain VNext, external vaults, skill judges) prove the gap is real: power users bolt governance onto Hermes."* Checked against the ecosystem, that claim does not hold and is withdrawn in full:

- **"Brain VNext" does not exist** — not on GitHub, not on Reddit, not on the open web. It appears to have been a garbled reference to `garrytan/gbrain`, which is a *memory* layer, not governance, and so fails as evidence either way. Citing a project that does not exist, in the document arguing this project's thesis, is precisely the failure mode Chamber is built to prevent.
- **What power users actually bolt on is memory, not governance.** By monthly npm downloads the ratio is about 58:1 (`mem0ai` 370,879 vs `governance-sdk` 6,340). Within the Hermes plugin format itself the two categories are statistically indistinguishable.
- **The bolt-on market has since closed anyway** — Hermes absorbed memory into core (~April 2026) with eight first-party providers.
- **"Skill judges" have no meaningful traction**: the community governance plugins found sit at 1-8 stars.

What survives of the original point is narrower and worth keeping: Hermes's self-improvement loop *does* let agent-authored skills execute, and `skill_provenance.py` bounds that by write-origin rather than by human ratification. That is a real design difference. It is not evidence of market demand, and this document should never have used it as such.

---

## Runtime probes (Chamber only)

`scorecard.ts` executes:

1. Unsourced belief → pending debt  
2. Strict contract → REFUSED  
3. Skill create → queued  
4. Model complete → spend tokens  
5. Audit chain verifies  
6. MMR leaf count ≥ 1  
7. Faculty rejects open debts  
8. Consequential+shell activate refused  
9. Expiry marks stale beliefs  

Hermes runtime bake-off would need a fixed model, fixed tasks, and spend telemetry — out of scope until both expose identical meters.

---

## Fair use of results

- **Do not claim** “Chamber is a better Hermes.” It is not a drop-in messenger agent.  
- **Do claim** Chamber is stronger on **governed commitment, audit, and anti-self-approve**.  
- **Do claim** Hermes is stronger on **agency surface and skill compounding**.  

Premium direction: **Chamber gates under a Hermes-class surface**, not philosophy cosplay inside MEMORY.md.
