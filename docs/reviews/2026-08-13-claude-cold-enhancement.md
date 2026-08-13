# Cold review — enhancement proposals, ranked by leverage

Reviewed 2026-08-13 against the working tree (branch `main`, clean at review
start). Read: `README.md`, `docs/KNOWN_LIMITATIONS.md`, `src/ask.ts`,
`src/pins.ts`, `src/commit_belief.ts`, `src/mcp_server.ts`, `src/cli.ts`
(verify/ask paths), `src/anchor.ts`, `src/checkpoint_export.ts` (grep),
`src/mcp_trust.ts` (grep), `sql/schema.sql`, `probes/README.md`,
`docs/NEXT_LEVEL_PLAN.md` (head).

Two staleness notes before the proposals, because a reviewer who repeats the
repo's own docs back at it is not reviewing. KNOWN_LIMITATIONS was verified at
commit `da801fd` (2026-08-04) and the code has moved past two entries: entry 6
says `verifyPin` never queries `snapshot_hash`, but `verifyBeliefSources` now
passes `allowRelocation: true` and `verifyPin` does an indexed
`snapshot_hash` fallback lookup (`src/pins.ts:205-224, 354-362`); entry 3 says
there is "no signing key, HMAC, or ed25519 anywhere in the tree", but
`src/checkpoint_export.ts` now generates ed25519 keys and signs receipts, and
`src/anchor.ts` chains them into an append-only JSONL log. Both entries
overstate the current gap and should be re-dated. Nothing below re-proposes
either.

---

## 1. Disclose the retrieval miss: a second-leg cross-check on every `ask`

**Idea.** After answering, cheaply probe whether a passage the answer *should*
have used was retrievable by another leg, and say so next to the answer.

**Mechanism.** This is the one live dogfood failure: every claim individually
cited, wrong question answered, and the `exact` lexical leg had the right note
all along. `runAsk` (`src/ask.ts:253`) already runs hybrid retrieval, already
supports `mode: "phrase"` with `require: true`, and already has the exact
plumbing for answer-adjacent caveats — `joinNotes`, `withheldNote`,
`lexicalDegradedNote` all render a note *alongside* the answer, never instead
of it (`src/ask.ts:229-231, 466-470`). The missing piece is one more probe:
extract the question's distinctive terms (quoted spans, rare tokens — the
lexical leg already has term extraction via `lexicalQueryNotices` /
`MAX_LEXICAL_TERMS` in `src/vector.ts`), run a phrase/`require` search, and if
its top hit is a passage the model was never shown, append a note naming the
file. The verdict machinery is untouched; this is disclosure, not gating.

**Smallest slice.** One extra `searchVector` call in `runAsk` when the
question contains a quoted phrase or a term the lexical notices flag as
distinctive; one new note string; one test with a fixture where vector rank
buries the exact match. A day.

**What it unlocks.** Today an answer formed over the wrong notes is
indistinguishable from a right one — every layer reports ALLOWED, which is
precisely the "green suite over a broken gate" pattern this repo's own
CLAUDE.md warns about, reproduced at the retrieval layer. This makes the
failure *visible* at the moment it happens, which is what the product's whole
pitch (drift you didn't ask about, surfaced anyway) promises.

**Cost/risk.** One extra FTS query per ask — negligible. False alarms on
questions whose distinctive term is genuinely everywhere; the note must be
worded as "also matched, not shown" rather than "your answer is wrong."
KNOWN_LIMITATIONS entry 12 admits retrieval quality is the least-measured part
of the most load-bearing path; this does not fix that (see #7), it makes the
operator a sensor for it.

## 2. Wire `embedLocalBatch` into ingest

**Idea.** Batch the ingest path's embeddings instead of spawning one Python
process per passage.

**Mechanism.** KNOWN_LIMITATIONS entry 15, last paragraph: `upsertDocument`
calls `embedLocal` once per passage at ~158 ms each — 75 minutes for a
28,500-passage corpus — and `embedLocalBatch` (`src/embedder.ts:320`) "exists
to amortise exactly this and has no callers." Verified today: its only caller
is the paraphrase gate in `src/commit_belief.ts:266`. The repo itself calls
wiring it in "the single largest performance win available in the ingest
path."

**Smallest slice.** Collect passages per file (or per N), call
`embedLocalBatch`, fall back to the singular path on throw. The trap is
documented in CLAUDE.md and must be honored: the batch path **throws** where
singular `embedLocal` degrades to hash vectors. That divergence is the design
decision to make explicitly — for ingest I'd argue batch-throw →
singular-fallback-with-warning preserves current semantics exactly while
capturing the win. One to two days including the Linux/no-onnxruntime test.

**What it unlocks.** The scheduled daily ingest+verify job becomes minutes
instead of an hour-plus on a real vault, which changes what corpus sizes the
product is honest about supporting. It also shrinks the surface of entry 15's
nastiest failure — the 75-minutes-vs-2-minutes gap was the *only* visible
symptom of the silent hash-vector downgrade, so while batching, record which
embedder produced each run (entry 15 explicitly asks for per-corpus embedder
provenance; a single row in `chamber_config` or an ingest-run table covers
it).

**Cost/risk.** The two paths' failure semantics have already bitten this
codebase once (a batch throw parked every assertion — see the comment at
`src/commit_belief.ts:227-234`). The fix must not let a mid-corpus batch
failure silently leave half a corpus in one embedding space and half in
another; that is a new, worse version of entry 15.

## 3. Product shape: `chamber verify` as a CI drift gate for repos, not just a cron for notes

**Idea.** Package the existing exit-code contract as a GitHub Actions gate:
claims in docs pinned to passages of code/docs, failing the build when the
ground moves.

**Mechanism.** Everything load-bearing already exists. `chamber verify` exits
non-zero on any pin failure (`src/cli.ts:1296-1428`, exit condition `broken +
degraded > 0`), and the README already frames it as "a scheduled job can act
on it." The corpus is not limited to notes: `indexCodeTree`
(`src/code_index.ts:199`) and the SCIP path index source code as `vault_page`
rows, which are the one citable kind (`src/pins.ts:87`). So "this README
paragraph stands on that function" is representable *today* as a belief whose
sources are code passages, and an edit to the function fails verify. What's
missing is machine-readable output — verify prints prose only, no `--json`
(verified by grep) — and a recipe: the SQLite file holding beliefs must
persist across CI runs (checked in, or cached as an artifact).

**Smallest slice.** `chamber verify --json` (beliefs, pins, reasons, resolved
db path — which also closes half of KNOWN_LIMITATIONS entry 13), plus one
worked example in `demos/` or docs: a repo where a doc claim is committed
against two code passages and a PR that edits one goes red. Two days.

**What it unlocks.** A distribution wedge the notes shape lacks. Personal-notes
Q&A competes with every RAG tool; "your docs claim things about your code, and
CI tells you when the code stops backing the claim" has no incumbent, needs no
model at verify time (the check is hash comparison — README dictionary: "No
model involved"), and is demoable in a public repo, which is exactly the
lived-field-report evidence the first readers asked for.

**Cost/risk.** Committing a binary SQLite file to a repo is ugly;
alternatively export/import beliefs as JSON (new code). Document identity is
`(kind, ingestRoot, ref)` — derived, so re-index in CI is stable — but
KNOWN_LIMITATIONS entry 5 bears directly: a *deleted* file's rows survive and
its pins verify tautologically, so a doc claim whose source file was deleted
passes CI. #4 is therefore a soft prerequisite for this shape being honest.

## 4. Tombstones: make verify notice evidence that was *removed*

**Idea.** Close KNOWN_LIMITATIONS entry 5 — a deleted source file currently
verifies forever.

**Mechanism.** Entry 5, verified against `src/ingest.ts:758-775`: the walk
only visits files that exist, so a deleted file's rows are never reconsidered;
`verifyPin` re-hashes the stored row, which didn't change, so
`chamber verify` reports a belief as soundly supported by a file that has been
gone for months. The entry names the fix and why it's subtle: reconciliation
must distinguish "excluded" from "gone", which requires recording the exclude
set per ingest run, and deletion should be a tombstone (a status on
`vector_document`), never a hard delete — `belief_source.ref_id` points at
these rows.

**Smallest slice.** Report-only first: record each ingest run's root, exclude
set, and walked-file list; a `verify` (or `corpus`) line saying "N passages
belong to files no longer present under their root (not excluded) — their
pins verify against stored content only." No schema-status change, no
behavior change, one to two days. Tombstones and a `deleted` pin reason are
phase two.

**What it unlocks.** The flagship check stops having a silent blind spot in
its strongest direction. "The source changed underneath a conclusion" is the
pitch; "the source was *removed* from underneath a conclusion" is the stronger
version of the same event, and today it is the one case verify actively
vouches for. Also a prerequisite for #3 being trustworthy.

**Cost/risk.** The excluded-vs-gone ambiguity is real and the code's own
comment (`src/ingest.ts:763-766`) explains the data-loss failure a naive
version caused-by-design avoids. Report-only sidesteps that entirely; the
tombstone phase must survive the "mistyped exclude" scenario. Unplanned work
per the doc — nothing in NEXT_LEVEL_PLAN covers it.

## 5. Product shape: the belief ledger as an API agents write to — proposed, and I would refuse it (below)

**Idea.** Expose `commitBelief` over MCP (`chamber_commit`) so coding agents
record decisions with pinned evidence, making Chamber the drift-checked
decision log for agent work rather than a Q&A tool.

**Mechanism.** The gate is already model-driven in one direction:
`chamber_ask` routes every claim through `enforceClaimContract` →
`commitBelief`, and the server's own header is explicit that "the gate is not
bypassed" is the guarantee, not "nothing is written"
(`src/mcp_server.ts:18-41`). A `chamber_commit` tool would be the same gate
without the model-answer step: an agent asserts "we chose X because refs A, B",
pins verify in-transaction (`src/commit_belief.ts:515-521`), the audit chain
records it, and tomorrow's verify catches the ADR whose ground moved. The
invariant is intact — this passes *through* the gate.

**Smallest slice.** One tool in `TOOLS`, one `callTool` case delegating to
`commitBelief` with `kind: "vault_page"` sources. A day.

**What it unlocks.** Chamber as infrastructure other tools depend on, which is
a different (larger) product than a CLI you talk to.

**Cost/risk — and why I'd refuse it as specified.** Two mechanisms fight it.
First, `src/ask.ts:1-13` builds the entire anti-fabrication argument on the
model never seeing document ids or hashes; a commit API requires handing the
caller exactly that id-space, so the "a fabricated pin is unrepresentable"
property degrades to "a fabricated pin is rejected" — a strictly weaker gate
re-entered through a side door, which is the pattern KNOWN_LIMITATIONS entry 8
warns arms landmines. Second, blocking debt is keyed on `claim_hash` and an
unsourced assertion is refused *forever* until paid (`src/pins.ts:76-80`); an
agent retrying noisily would brick claim hashes at machine speed, and the
paraphrase leg's measured false positives (entry 14) would refuse its
corrections. The README's line that gates "exist so a human passes through
them" is a design commitment, not copy. If this shape is ever built it needs
its own retrieval-mediated source resolution (agent supplies text, Chamber
resolves refs), which is not a two-day slice.

## 6. Finish per-tool MCP pin drift — then consider it as its own product seed

**Idea.** Implement the `tool_drift` comparison the type system already
promises, closing KNOWN_LIMITATIONS entry 7.

**Mechanism.** Verified still open: `pinToolsList` writes `schema_hash` and
`description_hash` per tool (`src/mcp_trust.ts:83-87`), and `tool_drift` is
declared in the `PinCheck` union (`src/mcp_trust.ts:118`) but never
constructed — `verifyToolsAgainstPin` compares only the whole-list hash. A
server that keeps its roster byte-identical and rewrites one tool's
description — the attack CLAUDE.md notes actually worked once ("a vendor tool
description chose the code that ran") — is invisible.

**Smallest slice.** Per-tool hash comparison in `verifyToolsAgainstPin`,
emitting the reason its own type declares; a test that mutates one
description. A day, and the entry itself says "the data is being collected;
only the comparison is missing."

**What it unlocks.** Closes the gap between what the type promises and what
the code performs — "worse than not declaring it," per the repo's own doc. And
it is the pin/verify idea applied to the MCP supply chain, where public
anxiety is high and tooling is thin; `chamber mcp-discover` + pinning +
drift-on-reconnect is a story that stands alone. **ASSUMPTION:** that
external demand exists is market judgment, not verified in the repo.

**Cost/risk.** Small. The one design question is whether description drift
blocks or warns; given the tool-description incident, block-by-default with an
explicit re-pin path matches the house style of refusing rather than
degrading.

## 7. A retrieval golden set with a floor in CI

**Idea.** Fifty judged queries over a fixture corpus, scored (`recall@k`,
`mrr`), failing the build below a floor.

**Mechanism.** KNOWN_LIMITATIONS entry 12: the hybrid tests pin specific
adversarial fixtures but "there is no golden set, no relevance judgements, no
ndcg/recall@k/mrr anywhere in the tree", and the changes most likely to
degrade real results (embedder swap, chunker change, corpus growth) "would not
move a single test." The repo already has the pattern to copy:
`fixtures/paraphrase_calibration.json` + `npm run calibrate:paraphrase`, whose
honesty (printing both columns, recording platform variance) is the house
standard.

**Smallest slice.** `fixtures/retrieval_golden.json` (query, relevant refs,
tier), `npm run eval:retrieval` printing scores with no floor — report before
gate, exactly as the calibration script did. Two days including corpus
authoring, which is the real work.

**What it unlocks.** #1 discloses retrieval misses to the operator; this
catches them before ship. It is also the only thing standing behind #2's
embedder changes — swapping ingest to batch embedding *should* be a no-op for
quality, and today nothing would notice if it weren't.

**Cost/risk.** Golden sets rot; judged relevance on a synthetic corpus
measures the fixture, not the vault. Entry 12's own framing ("fifty queries
would catch most of what matters") is the right modesty. The floor, once
added, must be re-derived per embedding model, or it becomes another 0.8 — a
constant mistaken for a calibration.

---

## Verdicts

**Build first: #2 (batch-embed ingest).** It is the repo's own
self-identified largest win, the code exists, the trap is documented, and it
converts the daily job from "tolerable on a demo corpus" to "honest on a real
one" — every other proposal is worth more on a corpus people actually run.

**Refuse to build: #5 (agent-writable commit API), as specified.** It
dismantles the "fabricated pins are unrepresentable" property that
`src/ask.ts` is built around and hands machine-speed retries a gate whose
refusals are permanent by design; the shape is interesting, but not as a
two-day MCP tool bolted onto a gate that was designed for a human's error
rate.
