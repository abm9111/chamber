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
Hermes scores are backed by **shipped design** (MEMORY.md / skills loop / gateway / approvals) and community field reports (cost opacity, skill auto-improve risk, epistemic opacity).

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
| G2 | No self-approve of self-authored skills | 0 | 2 |
| G3 | Multi-faculty blocking votes | 0 | 2 |
| G4 | Constitution ratification friction | 1 | 1 |
| C1 | Spend visible by channel | 1 | 2 |
| C2 | Background loops metered | 0 | 2 |
| M1 | Memory capacity ledger | 1 | 1 |
| M2 | Forgetting with dependency impact | 1 | 2 |
| M3 | Dream propose-only | 0 | 2 |
| A1 | Audit hash chain | 1 | 2 |
| A2 | Incremental Merkle root | 0 | 2 |
| A3 | Offline verify receipt | 1 | 2 |
| T1 | Allowlist + sandbox before activate | 1 | 2 |
| T2 | SCIP/code-graph consumer | 0 | 1 |
| S1 | Messaging surface breadth | 2 | 1 |
| S2 | Self-improving skill loop | 2 | 0 |
| S3 | TLS/token production hardening | 1 | 2 |
| | **Total / 40** | **13** | **33** |

Percent: Hermes **32.5%** · Chamber **82.5%** on *this* rubric (governance-weighted by design).  
Live Chamber probes: **9/9** (`benchmarks/scorecard.ts`).

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
| Tests | **55/55** harness |

**Gaps vs a full product:** multi-messenger gateway, skill marketplace, rich TUI, automatic skill growth (intentionally out of scope).

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

Community mitigations (Brain VNext, external vaults, skill judges) prove the gap is real: power users bolt governance *onto* Hermes.

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
