# Chamber — week-1 kernel

Governable cognition for a premium agent that must beat Hermes on **epistemic integrity**, not tool count.

## Invariant

> No assertion may become executable, citable, or load-bearing except through a gate whose check and write commit in one transaction — anything else may decay, park, or be defeated, but it may never silently pass.

Where that invariant does not yet hold, and what a verified citation does and does not prove: [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md). Read it before trusting any output.

## Layout

```text
sql/schema.sql                       Week-1 tables + CHECKs
sql/schema_spend_approvals.sql       spend_event + pending_write + policies
sql/schema_approval_workflows.sql    automated approval rules + audit
src/types.ts
src/hash.ts
src/db.ts                            loads all 14 schemas
src/commit_belief.ts
src/try_activate_skill.ts
src/spend.ts
src/approvals.ts                     propose / decide / queue
src/approval_workflows.ts            evaluateWorkflows (auto approve/reject)
src/audit.ts                         hash-chained audit trail
src/merkle.ts                        Merkle checkpoints + inclusion proofs
tests/harness.ts                     **runnable** acceptance suite (287 tests)
tests/ACCEPTANCE_TESTS.md
tests/SPEND_APPROVALS.md
tests/APPROVAL_WORKFLOWS.md
tests/AUDIT_TRAIL.md
tests/MERKLE.md
package.json
```

## Run tests

```bash
cd artifacts/chamber
npm test
# or: node --experimental-strip-types tests/harness.ts
# suites: --suite=gates|spend|approvals|audit
```

**Last run: 287/287 passed.** Specs are no longer paper-only.

## Gates (week-1)

| Function | Blocks when |
|----------|-------------|
| `commitBelief` | Assertion (`belief`\|`commitment`) with open **blocking** citation debt; missing pins; defeater used as source; fast-path belief-typed commit |
| `tryActivateSkill` | Open holds; load-bearing stale beliefs (teeth); content ≠ last **critic-cleared** hash; manifest over-ask |

Retraction types (`defeater`, `unknown`) commit freely and do not mint blocking debt (FM-5).

## Faculties (runtime roles — not week-1 model calls on fast path)

| Faculty | Arabic |
|---------|--------|
| Mind & Consciousness | فلسفة العقل والوعي |
| Epistemology | الإبستمولوجيا |
| Applied Ethics | الأخلاق التطبيقية |
| Language & Logic | فلسفة اللغة والمنطق |
| Philosophy of Technology | فلسفة التكنولوجيا |

Fast path = **zero** faculty model calls. Belief-typed commits escalate the **commit**, not necessarily the whole turn.

## Forks locked

- **A** Full defeater exemption + no-citation rider  
- **B** Epistemology solo waive routine only; human on consequential+  
- **C** Suspension shadow 7 days → teeth; flip date in `chamber_config`  
- **D** Critic = different model family  

## Week-1.5 — Hermes field P0

| Default | Value |
|---------|--------|
| `memory.write_approval` | **on** |
| `skills.write_approval` | **on** |
| `auto_skill_improve` | **quarantine** (background queues, never silent apply) |
| Pending TTL | 72h — **expire ≠ approve** |

- `recordSpend` / `spendLastHours` / `formatSpendFooter` — burn by channel  
- `proposeWrite` / `decideWrite` / `listPendingQueue` — human gate  

## Next hardenings (ordered)

1. Waiver budget + mandatory waiver decay  
2. `capability_manifest` enforced at tool dispatcher  
3. Hash-chained append-only ledger tip  

## Note on confidence

`belief.confidence` is optional UI metadata. **No gate branches on it.**
