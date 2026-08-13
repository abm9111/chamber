# Tri-party review — Chamber enhancement directions (2026-08-13)

## Scope card

- **Subject:** the whole repo, enhancement ideas ranked by leverage; brief
  required file-grounded mechanisms, smallest shippable slices, and at least
  two proposals questioning the product shape itself.
- **Author contamination:** the orchestrating session co-authored much of the
  recent tree, so it wrote the brief and verified claims but produced no
  proposals of its own.
- **Engines:**
  - *Cold Claude* — fresh headless session, no shared context
    (`docs/reviews/2026-08-13-claude-cold-enhancement.md`).
  - *Grok sandbox* — Docker, repo read-only, report-only tools
    (`docs/reviews/2026-08-13-grok-cold-enhancement.md`). Note: its sandbox
    runs Node 22 (< engines floor), so it did static analysis only.
  - *Kimi K3* — **absent**: API quota exhausted for the billing cycle (403).
    Two families reviewed instead of three.
- **Verification:** every load-bearing repo claim below was re-checked by the
  orchestrator with rg/Read against the working tree. Status marks:
  ✔ Confirmed · ◐ Partial · ✘ Refuted.

## Agreements (independent convergence, both engines)

| # | Proposal | Grok | Claude | Verified |
|---|----------|------|--------|----------|
| A1 | **Disclose retrieval misses next to the answer** — run the exact/phrase leg as a cross-check; when it holds a passage the model never saw, say so in the answer-adjacent note. | P1 (build-first) | #1 | ✔ `withheldNote`/`lexicalDegradedNote` render alongside answers (src/ask.ts:467-468); `retrievedBy` exists (src/vector.ts:146); exact/phrase mode shipped. Matches the live dogfood failure (all claims ALLOWED, wrong question answered). |
| A2 | **Tombstones — deleted evidence must not verify green** | P2 | #4 | ✔ KNOWN_LIMITATIONS entry 5 + src/ingest.ts:758-775: deleted files are never revisited; worse, deleted notes are still *retrieved and cited in new answers* (KL line 163). Claude's report-only first slice (record walked-file set, print "N passages belong to files no longer present") avoids the mistyped-exclude data-loss trap the code already documents. |
| A3 | **Product shape: CI drift gate for repos** — docs claims pinned to code/doc passages, `chamber verify` exit code fails the build. | P3 | #3 | ✔ Verify exits non-zero on broken+degraded (src/cli.ts); `indexCodeTree` writes citable `vault_page` rows (src/code_index.ts:229,271; src/pins.ts:87) — the shape is representable today. Missing: `verify --json`, a worked demo, belief-store persistence recipe. A2 is a soft prerequisite (deleted source file currently passes CI). |
| A4 | **Wire `embedLocalBatch` into ingest** | P4(c) | #2 (build-first) | ✔ Sole caller is the paraphrase gate (src/commit_belief.ts:266); ingest embeds one spawn per passage (~75 min for 28.5k passages per KL 15). The batch/singular failure-semantics divergence is documented and must be preserved (batch throws; fall back loudly). |
| A5 | **Retrieval golden set in CI** | P6 | #7 | ✔ KL entry 12: no golden set/recall@k/mrr anywhere. House pattern to copy exists (`fixtures/paraphrase_calibration.json` + report-before-gate). Makes A1 durable and is the only guard behind A4's embedder change. |

## Contradiction (the interesting one)

**Belief ledger as a write API for agents/tools** — Grok P7 proposes
`chamber_believe`/`chamber_pay_debt` MCP tools (medium priority); Claude #5
specifies the same tool and then **refuses it as specified**, on two verified
mechanisms:

- src/ask.ts's anti-fabrication design: the model never sees document ids or
  hashes, so a fabricated citation is *unrepresentable*. A commit API hands
  callers exactly that id-space — the property degrades to "rejected", a
  strictly weaker gate. ✔ (header verified)
- Debt permanence: an unsourced assertion's claim_hash is refused until paid
  (src/pins.ts:74-80 comment: "refused forever — after the tokens have already
  been paid for"). A machine-speed retry loop bricks claim hashes, and the
  paraphrase leg's measured false-positive rate would refuse its corrections. ✔

**Orchestrator verdict:** side with the refusal *as specified*. The shape is
worth revisiting only as retrieval-mediated resolution (caller supplies text,
Chamber resolves refs itself), which is not a small slice. Grok's own
cost/risk section conceded both risks; the disagreement is priority, not
facts.

## Unique findings worth keeping

- **Claude:** `tool_drift` is declared in the PinCheck union and never
  constructed (src/mcp_trust.ts:118 — single occurrence ✔): per-tool
  description drift is invisible even though per-tool hashes are already
  stored, and a description rewrite is the attack that historically worked.
  One-day close of KL entry 7, and a possible standalone story (pin your MCP
  supply chain).
  > **Correction, 2026-08-13 (post-implementation).** The "invisible" half of
  > this finding — and the ✔ this orchestrator put on it — was wrong:
  > `hashToolsList` hashes every tool's description and schema into the
  > whole-list hash, so the same-roster rewrite was always *detected*, only
  > diagnosed anonymously as `list_drift`. The error originated in
  > KNOWN_LIMITATIONS entry 7 itself, which the cold reviewer reasonably
  > trusted and this orchestrator's single-occurrence grep did not test
  > deeply enough to catch. The declared-never-constructed half stands, and
  > the fix shipped as precision, not detection: roster vs content split,
  > drifted tools named with facet. Third documented case of the honesty doc
  > overstating a weakness.
- **Claude:** KNOWN_LIMITATIONS entries 3 and 6 are stale against the code
  (ed25519 signing exists ✔; snapshot-hash relocation exists ✔) — the honesty
  doc now *overstates* weaknesses, which costs credibility in the other
  direction. Re-date and correct.
- **Grok:** embedder preflight + per-corpus model stamp (KL 15) — refuse or
  loudly warn scheduled ingest when MiniLM is expected but unavailable; record
  which embedder produced each vector. Without it, every corpus larger than a
  demo silently degrades to hash vectors on the wrong machine.
- **Grok:** sell the audit chain (hash chain + Merkle + signed checkpoints +
  external anchor) as the product for teams that never ask questions;
  ask/verify is one client. FIELD_NOTES already records that no peer harness
  has this.

## Build-first disagreement, resolved

Grok says A1 (retrieval-miss disclosure); Claude says A4 (batch embedding,
"every other proposal is scored against a dead index"). They are independent
1–2-day slices touching different files. Recommended order: **A4 → A1 → A2
(report-only) → tool_drift → A5**, then decide the A3 product-shape bet with
those in hand. Total: roughly a week of focused work, all inside the
invariant.

## Human gate — decisions needed (no auto-implement)

1. Approve the A4 → A1 → A2 → tool_drift → A5 sequence, or reorder.
2. The A3 bet (CI drift gate as the public wedge) — pursue after the sequence,
   or park.
3. Grok's audit-chain-as-product framing — fold into positioning for the field
   report / Show HN, or ignore.
4. Write-API: accept the refusal-as-specified verdict (revisit only as
   retrieval-mediated), or overrule.
5. KL entries 3/6 staleness — approve a corrections pass on the honesty doc.

— Orchestrated by the session of 2026-08-13; engines cold; all table claims
re-verified against the tree before inclusion.
