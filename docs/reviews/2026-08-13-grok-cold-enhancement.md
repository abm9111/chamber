I'll cold-review Chamber against the brief: read the listed docs and core sources first, then rank 6–8 grounded enhancement proposals from evidence.Next I'll ground proposals in the actual ask/pins/commit/MCP paths and the schema that backs them.I have enough grounded evidence. Drafting the ranked proposals and the full report.# Cold review — Chamber enhancement proposals

## 1. Verdict

**ISSUES**

Review completed against source in `/work/repo`. No execution blockers for static analysis; full `npm test` / `npm run probes` not required for this purpose and not run end-to-end. The product’s stated invariant and machinery are real; the highest-leverage gaps are retrieval miss-visibility, corpus lifecycle honesty, and product-shape underuse of the audit/verify substrate.

## 2. Summary

Chamber already has the rare machinery: transactional belief commits (`src/commit_belief.ts`), content pins + drift scan (`src/pins.ts` `verifyPin` / `verifyBeliefSources`), hybrid/exact retrieval (`src/vector.ts` `searchVector`, `src/ask.ts` `runAsk`), hash-chained audit + external anchors (`src/audit.ts`, `src/anchor.ts`, `src/checkpoint_export.ts`), and a narrow MCP surface (`src/mcp_server.ts`: ask/verify/corpus).

What fails users first is not “more gates.” It is (a) answers that are fully `[ALLOWED]` while retrieval missed the right note, (b) `verify` that stays green on deleted evidence (KNOWN_LIMITATIONS §5), and (c) shipping Q&A as the product while the unique asset is the ledger/chain. Six of eight proposals stay inside the invariant; two re-shape who the product is for.

## 3. Findings — ranked enhancement proposals

### P1 — high — Surface retrieval miss; do not only gate citations

1. **Idea.** Treat “every claim cited, wrong question answered” as a first-class failure mode and make hybrid/exact disagreement audible next to the answer.
2. **Mechanism.** `runAsk` (`src/ask.ts`) already runs hybrid by default and supports `exact` phrase mode (`AskOptions.exact` → `lexical.mode: "phrase"`). `searchVector` (`src/vector.ts`) returns `retrievedBy: "semantic" | "lexical" | "both"` and `lexicalScore`. CLI/MCP expose `--exact` / `exact` (`src/cli.ts` ask case; `src/mcp_server.ts` chamber_ask). Today those signals die at ranking: the model only sees top-k passages and never learns a high-lexical hit was dropped or that exact mode would have retrieved a different set. Dogfood case in the brief matches KNOWN_LIMITATIONS §2 + §12: provenance gate cannot catch wrong-but-real or wrong-passage retrieval.
3. **Smallest shippable slice.** After retrieval, if the unfiltered hybrid top-k and an exact/phrase pass disagree on membership of the highest-idf rare terms, set `AskResult.note` (already rendered on answer path) with the missed `sourceRef` labels via `passageLabel`. Add one adversarial fixture: corpus with two similar policies; query naming a rare proper noun that only the lexical leg holds.
4. **Unlocks.** Operators can see “supported by what was retrieved” vs “the corpus has a better hit.” Closes the lived failure that every citation being ALLOWED still answers the wrong question.
5. **Cost/risk.** Low code risk; does not invent NLI. Admits KNOWN_LIMITATIONS §2 (claim-follows-from-passage is non-goal) and §12 (no golden retrieval eval yet — this is a diagnostic, not a quality floor).

---

### P2 — high — Tombstone deleted files so `verify` cannot pass on vanished evidence

1. **Idea.** When a note leaves the walk, mark its passages deleted and fail pins against them with reason `deleted`, not silent success.
2. **Mechanism.** KNOWN_LIMITATIONS §5 documents this exactly: deleted files are never visited; `verifyPin` re-hashes the stored row (`src/pins.ts`); pin stays valid. Ingest shrinks tails for shortened files (`src/ingest.ts` ~758–775) but deliberately does not treat absence as delete (exclude vs gone). Identity is `(root, relative path)`.
3. **Smallest shippable slice.** Persist last-run exclude set + last-seen file set on ingest; post-walk, for paths present last run, absent this run, and not matching recorded excludes → set `vector_document` tombstone flag (or status column) rather than hard-delete. `verifyPin` / `verifyBeliefSources` report `deleted` (extend `PinFailure` / `BeliefSourceFailure` carefully — CHECK constraints on `gate_event.action` mean new verbs go via `appendAudit`, free text — see CLAUDE.md / `sql/schema.sql`).
4. **Unlocks.** The README product sentence (“source changed underneath a conclusion”) becomes true for removal, not only edit. Scheduled `chamber verify` (launchd/systemd under `deploy/`) becomes a real integrity check for deleted policy notes.
5. **Cost/risk.** Medium. Must not delete on mistyped exclude (repo already argues this at `src/ingest.ts:763–766`). Unplanned in `docs/NEXT_LEVEL_PLAN.md`. Schema migration on SQLite.

---

### P3 — high — **Product shape:** Chamber as a CI gate for docs/code/policy drift, not a personal-notes chatbot

1. **Idea.** Market and ship the scheduled verify loop as a drop-in CI step over any markdown/code corpus, with exit non-zero on pin failure — Q&A optional.
2. **Mechanism.** Already exists end-to-end: `chamber ingest` → `commitBelief` / ask commits beliefs with pins → `verifyBeliefSources` → CLI exits non-zero on broken **or** degraded pins (`src/cli.ts` ~1364–1427; probe `probes/verify_partial_drift.ts` documents the old hole). `src/code_index.ts` indexes TS/JS/Python into the same `vector_document` store. `deploy/systemd/chamber-jobs.timer` and `deploy/launchd/com.chamber.verify.plist` already schedule ingest+verify. Demos `demos/02_ledger_cannot_lie.ts` and README verify transcript are the pitch deck.
3. **Smallest shippable slice.** A one-page “use in CI” path: `chamber init` profile with repo-relative roots, `chamber ingest && chamber verify` GitHub Action / exit code contract, fixture under `fixtures/` for README claims pinned to source files. No model required for verify (README: “No model involved”).
4. **Unlocks.** Buyers who do not want local RAG still need “policy/docs drifted under a stated commitment.” Turns ~2-star niche tool into a generic drift detector for teams and open-source maintainers.
5. **Cost/risk.** Product/docs focus, not architecture rewrite. Invariant preserved. Risks: identity on renames (KNOWN_LIMITATIONS §5–6), default-empty excludes (§10) will poison CI if pointed at whole monorepos.

---

### P4 — high — Embedder preflight + per-corpus model stamp (stop silent hash poisoning)

1. **Idea.** Refuse or loudly fail scheduled ingest when MiniLM is expected but unavailable; record which embedder produced each vector so query/corpus disagreement is detectable.
2. **Mechanism.** KNOWN_LIMITATIONS §15: `minilmAvailable()` (`src/embedder.ts`) checks files only; `embedLocal` falls back to `local-hash-v1`; `searchVector` filters `e.model = ?`. Observed: launchd re-embedded ~28k passages as hash vectors while interactive ask used MiniLM → “nothing matches.” `embedLocalBatch` exists and has no ingest callers (same entry). `corpusStats` (`src/corpus.ts`) counts kinds/files, not embedding models.
3. **Smallest shippable slice.** (a) One-shot spawn probe in preflight / `chamber status` / scheduled job banner. (b) `corpusStats` group-by `vector_embedding.model`. (c) Wire `embedLocalBatch` into ingest for the 75-minute → minutes win.
4. **Unlocks.** Makes the citation product usable on real vaults under launchd/systemd. Without this, every other enhancement is scored against a dead index.
5. **Cost/risk.** Low–medium. Fail-closed on missing python may break bare installs — surface as explicit config (`require_minilm: true`) rather than silent soft-fail. Batch path already used in `commit_belief.ts` paraphrase leg (throws on failure — CLAUDE.md singular/batch divergence).

---

### P5 — medium — **Product shape:** Sell the audit chain; treat vault Q&A as the demo of the chain

1. **Idea.** Productize hash-chained `audit_event` + Merkle + external anchor as a standalone “append-only decision log any tool can feed,” with ask/verify as one client.
2. **Mechanism.** `appendAudit` / chain verify (`src/audit.ts`); incremental Merkle `rootAtSeq` (`src/merkle_inc.ts`); signed checkpoints (`src/checkpoint_export.ts` ed25519); anchor log outside DB (`src/anchor.ts`); demo `demos/02_ledger_cannot_lie.ts` proves truncation detection. FIELD_NOTES.md Part 3: peer harnesses lack hash-chained audit. KNOWN_LIMITATIONS §3: checkpoints were historically manual/unsigned/`/tmp` — signing/path work is partially present now (default path beside config in current `checkpoint_export.ts`); scheduled production of anchors is still the weak half.
3. **Smallest shippable slice.** Documented `chamber audit append` / library export for external writers that must go through the same chain; nightly `checkpoint` + `appendAnchor` in `chamber-jobs`; receipt verify as the primary CI artifact. Keep `commitBelief` FM-6 (check+write one transaction) as the *only* way beliefs enter — external writers get audit events, not free belief rows.
4. **Unlocks.** Differentiates against every RAG CLI. Teams that never ask questions still need tamper-evident “what did the agent decide.”
5. **Cost/risk.** Medium product complexity. Do not open a bypass of `commitBelief` for beliefs. Anchor still co-located with operator disk (KNOWN_LIMITATIONS §3 ceiling: not remote timestamping).

---

### P6 — medium — Retrieval golden set as a real CI floor

1. **Idea.** Fifty judged query→passage pairs with recall@k / MRR floor that fails the build when hybrid weights, chunker, or embedder change.
2. **Mechanism.** KNOWN_LIMITATIONS §12: harness asserts rank on synthetic fixtures (`tests/harness.ts`), not corpus quality; `benchmarks/` scores control plane, not retrieval. Hybrid math lives in `src/vector.ts` (`lexicalStrength`, LEXICAL_WEIGHT comments).
3. **Smallest shippable slice.** `fixtures/retrieval_golden.json` + runner in `tests/` or `benchmarks/scorecard.ts`; seed from `fixtures/demo/` refunds/office notes plus 2–3 adversarial near-misses (the dogfood class).
4. **Unlocks.** Makes P1 durable. Without this, “fix retrieval miss” lands and then regresses invisibly.
5. **Cost/risk.** Low. Maintenance burden of judgements. Does not solve CJK FTS (§11) or wrong-but-real citations (§2).

---

### P7 — medium — Belief ledger as a gated write API for other tools

1. **Idea.** Expose a deliberate multi-writer surface (`chamber believe` / MCP tool) so other agents and scripts mint beliefs only through `commitBelief`, and MCP stop being “ask that happens to write.”
2. **Mechanism.** `commitBelief` (`src/commit_belief.ts`) is the gate; CLI `believe` / `pay-debt` exist (`src/cli.ts`). MCP deliberately exposes only ask/verify/corpus (`src/mcp_server.ts` header: no skill activation, no approve, no ingest). `chamber_ask` already writes via `enforceClaimContract` → `commitBelief` (`src/contract.ts`) — documented, but hosts cannot commit a human-authored belief without going through the model path. Schema: `belief`, `belief_source`, `citation_debt` (`sql/schema.sql`).
3. **Smallest shippable slice.** MCP tools `chamber_believe` and `chamber_debts` / `chamber_pay_debt` that call the same functions as CLI; tool descriptions state write semantics as clearly as current `chamber_ask` does. Optional: JSON-lines stdin batch for CI (pairs with P3).
4. **Unlocks.** Chamber becomes the shared ledger other tools write into; Q&A is one writer among many. Aligns with “gates exist so a human/tool passes through them.”
5. **Cost/risk.** Medium trust design. MCP header correctly refuses self-approval; keep that. Debt paraphrase leg remains weak (KNOWN_LIMITATIONS §14 + calibration notes). Do not add auto-approve tools.

---

### P8 — low/medium — Content-addressed pin relocation report (shrink/`not_found` honesty)

1. **Idea.** When id lookup fails, report “content still present at new ref” via existing `snapshot_hash` index instead of bare `not_found`.
2. **Mechanism.** KNOWN_LIMITATIONS §6; `idx_vector_doc_snap` exists; `verifyPin` already has `allowRelocation` for reporting only (`src/pins.ts` ~139–220) with a written warning not to grant support on relocation (probe `probes/pin_bypass.ts`). Wire reporting path fully into CLI messages; never into commit support.
3. **Smallest shippable slice.** Default `verifyBeliefSources` drift report uses `allowRelocation: true` for messaging only; print relocated `sourceRef`.
4. **Unlocks.** Operators stop re-ingesting as a no-op fix when ordinals shifted.
5. **Cost/risk.** Low if support grant stays off. Miswiring relocation into the commit gate reopens pin bypass.

---

### Explicitly not proposed (refusal candidates)

- Full agent loop / capability ladder (`docs/NEXT_LEVEL_PLAN.md` L1+) while sandbox is still the structural risk surface (KNOWN_LIMITATIONS §1, `src/sandbox.ts`, `probes/sandbox_escape.ts`). Gates without isolation invert the project’s thesis.
- NLI or model-in-gate “claim follows from passage” — stated non-goal (KNOWN_LIMITATIONS §2; `src/chunk.ts` comment).

## 4. What you ran

| Action | Outcome |
|--------|---------|
| Read `README.md`, `docs/KNOWN_LIMITATIONS.md` (all 15+ entries incl. paraphrase calibration addenda), `docs/FIELD_NOTES.md`, `docs/NEXT_LEVEL_PLAN.md` (partial), `sql/schema.sql` | OK |
| Read/skim `src/ask.ts`, `pins.ts`, `commit_belief.ts`, `mcp_server.ts`, `vector.ts`, `contract.ts`, `debt.ts`, `anchor.ts`, `checkpoint_export.ts`, `corpus.ts`, `code_index.ts`, `embedder.ts`, `cli.ts` (verify/ask paths), demos/probes headers | OK |
| Grep: hybrid/exact, verify exit counters, span_hash, embedLocalBatch, tombstone language | OK |
| Minimal in-process smoke of `upsertDocument`/`commitBelief` | Partial — Node **v22.23.2** in sandbox (engines want **≥23.6**); commit API smoke rejected for pin wiring, not used as product evidence |
| `npm test` / `npm run probes` / `npm ci` | **Not run** (report-only enhancement brief; env Node below engines) |

**ASSUMPTION:** Partial-drift exit fix in current `src/cli.ts` (broken+degraded) supersedes the historical “exit 0 on partial loss” described in `probes/verify_partial_drift.ts` header — treat probe as regression guard, not current bug report, unless re-run red.

## 5. Open questions

- None blocking the ranking. Optional: whether first public “lived field report” should dogfood P3 (CI on this repo’s own docs) before more MCP surface (P7).

---

### Build first / refuse

**Build first: P1 (retrieval-miss visibility).** It is the only failure real readers will feel before they trust any pin, and it reuses hybrid/exact machinery already shipped in `runAsk` / `searchVector` without inventing new epistemology.

**Refuse: agent autonomy / skill-execution ladder above L0.** The repo’s own limitation #1 and FIELD_NOTES state the sandbox does not isolate and there is no real agent loop; granting autonomy on that foundation is the exact failure Chamber exists to prevent.
