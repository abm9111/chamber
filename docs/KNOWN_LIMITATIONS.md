# Known limitations

Chamber's premise is that a system which reasons about evidence should be honest about
its own. This file is where that applies to Chamber itself.

Everything below was verified against the code on 2026-08-04, at commit `da801fd`, by
reading the named source or running the named probe — including every line citation,
which is re-checked rather than carried forward. Each entry says what the limitation
is, what it actually costs you, and what would fix it. Where a fix is already planned,
the entry points at `docs/NEXT_LEVEL_PLAN.md`; where nothing is planned, it says so.

**One entry was added and removed again on 2026-08-05.** The two flagship gates wrote
outside the tamper-evident chain — `probes/gate_audit.ts` had been exiting non-zero on
every run, reporting 4 `gate_event` rows against 0 `audit_event` rows, and this file
did not mention it. Writing it down made it obvious enough to fix the same day, so the
entry is gone and the probe now reports `gates are chained`. Recorded here because the
sequence is the argument for keeping this file honest: the gap survived as long as it
was undocumented.

Two of these are not defects in the ordinary sense and should be read carefully rather
than skimmed: the sandbox does not isolate, and a citation can be genuine and still be
wrong. Neither is theoretical.

---

## 1. The sandbox does not isolate

`src/sandbox.ts` is named for containment it does not provide. Running
`probes/sandbox_escape.ts` on the development machine, with
`CHAMBER_SANDBOX_REQUIRED=1` set, produces this:

```
CHAMBER_SANDBOX_REQUIRED = 1
detectSandboxBackend()   = docker
backend reported: subprocess  ok: true
{ "homeReadable": true, "sshExists": true, "secretsExists": true,
  "wroteOutside": true, "net": "RESOLVED 104.20.23.154" }

>>> ESCAPE CONFIRMED — sandbox does not isolate
```

Three separate failures stack up. `detectSandboxBackend()` reports `docker`, but no
`runDocker` function exists — the docker branch dispatches to `runSubprocess` and the
result is relabelled `"subprocess"`. `CHAMBER_SANDBOX_REQUIRED=1` is a no-op: the
refusal check at `src/sandbox.ts:204` is unreachable whenever a backend is detected, so
the fail-closed switch never closes. And the code that runs reads `$HOME`, sees
`~/.ssh` and `~/.secrets`, writes outside its working directory, and resolves DNS.

**What it costs.** Today, less than the probe suggests, and you should know exactly why.
No path in the shipped code routes model-generated code into the sandbox — there is no
agent loop, and `runTool`'s registry lookup queries a `skill` table that no schema
creates, so only Chamber's own three built-in tools are reachable through it. But two
paths do execute source that did not come from Chamber: `chamber tool synth` runs
whatever text or file you hand it (`src/cli.ts:1406`), and `verifyMcpToolSource` runs
the `source` field of a tool declared by an imported MCP manifest
(`src/mcp_bridge.ts:91`). Both execute with your full user privileges. Anyone treating
"it ran in the sandbox" as a safety statement is wrong.

The larger cost is structural. Every capability level above L0 — the whole autonomy
ladder Chamber is being built toward — is gated on this being real. Granting an agent
more freedom on a sandbox that does not sandbox is precisely the failure the project
exists to prevent.

**What would fix it.** Write a real `runDocker` (`docker run --rm --network none
--read-only --memory 512m --pids-limit 128`), remove the relabel-to-`subprocess`, make
`SandboxResult` report the isolation it actually achieved rather than the backend it
hoped for, and make `CHAMBER_SANDBOX_REQUIRED=1` refuse anything weaker than full
isolation. Backends are not interchangeable: docker blocks `$HOME` reads, macOS
seatbelt and Linux bwrap do not, so those two are a degraded tier and not a substitute.
This is `docs/NEXT_LEVEL_PLAN.md` Phase 1.1, and `npm run check:sandbox` passing on the
deployment machine is the stated entry criterion for any capability level above L0.

## 2. A citation can be genuine and still be wrong

This one is a stated non-goal, not a bug, and it is not solved.

Chamber's citation gate proves that a cited passage is the passage it claims to be: the
pin is a hash of the stored content, verification re-hashes the stored row, and a
fabricated pin is not merely rejected but unrepresentable — the model only ever sees
bracket numbers, never document ids or hashes, so it has nothing to forge with
(`src/ask.ts:1-13`).

What the gate cannot do is tell you the claim follows from the passage. It has no
opinion on whether the model read the passage correctly.

**What it costs.** This has been observed live, not merely reasoned about: a model cited
a real passage and misread the numbers inside it. The pin verified perfectly, the claim
committed as `[ALLOWED]`, and nothing in the system registered a problem. A
wrong-but-real citation is indistinguishable from a correct one at every layer Chamber
controls. The comment at `src/chunk.ts:26-29` states this plainly — "a citation gate
cannot catch a wrong-but-real citation; only chunking can."

**What would fix it.** Nothing in Chamber's design, and nothing is planned, because this
is a boundary rather than a gap. Verification is about provenance; whether a conclusion
follows from its evidence is a judgement Chamber deliberately does not claim to make.
Retrieval quality mitigates the failure mode — passage-level chunking exists largely
because whole-file embeddings retrieved plausible-but-wrong notes — but mitigation is
not detection. Read Chamber's `[ALLOWED]` as "this source is real and says what the
citation says it says," never as "this claim is true."

## 3. Checkpoints are manual, unsigned, and land in `/tmp`

> **Correction, 2026-08-13.** Two of this entry's three claims have since been closed
> in code and one was closed in deploy: `src/checkpoint_export.ts` now generates an
> ed25519 keypair and signs receipts, the default output path is config-resolved
> rather than `/tmp`, and `deploy/launchd/com.chamber.daily-snapshot.plist` runs the
> export on a schedule. What still stands is the ceiling the last paragraph names:
> the anchor log lives on the same disk as the operator, so this is
> tamper-evidence against corruption and casual edits, not against an attacker
> with full write access to the machine. A limitations doc that overstates a
> weakness costs credibility in the same coin as one that hides it, so the
> original text stays below, dated, rather than silently rewritten.

`chamber checkpoint` writes a Merkle receipt over the audit chain. Three things limit
what that receipt is worth. It is never invoked automatically — no cron entry, no
launchd job, no queue kind calls it, and `maybeAutoCheckpoint` (`src/merkle.ts:388`) has
no callers at all. It is unsigned: `src/checkpoint_export.ts:41-48` is a bare
`writeFileSync` of JSON, and there is no signing key, HMAC, or ed25519 anywhere in the
tree. And its output path still defaults to `/tmp/chamber-checkpoint.json`
(`src/cli.ts:1677`) — the recent work that moved the *database* onto a durable
config-resolved path did not touch the checkpoint *output* path.

**What it costs.** The audit chain's tip and the `merkle_checkpoint` table live in the
same SQLite file that ordinary writes go to. Anyone with write access to that file can
truncate the tail of the chain and re-anchor it, and nothing detects this, because the
only record that would contradict them is in the file they just edited. An unsigned
receipt in `/tmp` is not an independent witness: it is deleted on reboot, and even while
it exists it can be regenerated by whoever did the tampering. The chain is tamper-*evident*
against corruption and accident. It is not tamper-evident against write access.

**What would fix it.** Sign the receipt with a key held outside the database
(`CHAMBER_CHECKPOINT_KEY`, ed25519), write it somewhere durable by default, and produce
it on a schedule rather than on request. `docs/NEXT_LEVEL_PLAN.md` Phase 1.4 specifies
the signing work and flags it as net-new code that is droppable if the phase overruns —
so it is planned, but it is the first thing scheduled to be cut.

## 4. A stalled model endpoint hangs the process forever

`src/model.ts:93-104` calls `fetch` with no `signal`, no `AbortController`, and no
timeout. There is no `CHAMBER_TURN_DEADLINE_MS` or any other implemented deadline on the
model path.

**What it costs.** `chamber ask` routes through `complete()` and inherits this. A model
server that accepts the connection and then stops responding — a local LM Studio that
has wedged, a remote endpoint that black-holes the request — hangs the command
indefinitely with no output and no error. Under the scheduled job this is worse than a
crash: a hung run produces no log line at all, so the absence of a failure reads as
success. Note the inconsistency, which is a useful signal that this is an oversight
rather than a decision: MCP calls are bounded (`curl -m 30`, `src/mcp_client.ts:53-58`)
and embedding subprocesses are bounded (`src/embedder.ts:140,163`). Only the model call
is not.

**What would fix it.** An `AbortSignal.timeout` on the request plus a per-turn wall
clock. Specified in `docs/NEXT_LEVEL_PLAN.md` Phase 2A, which calls out this exact line
of code.

## 5. The corpus has no notion of deletion

Re-ingesting a directory does delete, and the boundary is worth stating precisely,
because an earlier revision of this entry said flatly that it never removes rows. For a
file it actually walked and read, the shrink sweep (`src/ingest.ts:758-775`) removes the
tail rows a shortened note no longer covers — that is entry 6's subject. What it never
removes is the rows of a file that has *disappeared*. The walk builds its list from files
that exist, so a deleted file is simply never visited and its rows are never reconsidered.
This is deliberate and documented at `src/ingest.ts:763-766`: a file absent from the walk
is indistinguishable from one an `--exclude` pattern pruned, and deleting rows on that
basis would let a mistyped exclude silently destroy corpus.

A rename is the same problem wearing a different hat. Document identity is
`(root, relative path)`, so a renamed file is ingested fresh under its new path while
the old path's rows survive untouched. You end up with both copies.

**What it costs.** Stale rows are fully live. Retrieval does not consult the filesystem —
it filters on embedding model and source kind only — so a deleted note still comes back
as a search hit and can still be cited. Worse, it still *verifies*: `verifyPin` re-hashes
the body stored in the row, and nothing about that row changed when the file was deleted,
so the pin is valid and `chamber verify` reports the belief as soundly supported.
Verification of a deleted file is tautological. A claim can rest on evidence you removed
months ago, and every check Chamber runs will agree it is fine.

**What would fix it.** A post-walk reconciliation pass that can distinguish "excluded" from
"gone" — which requires recording the exclude set that produced an ingest run so a later
run can tell the two apart — plus tombstones rather than hard deletes, so verification can
report `deleted` instead of silently succeeding. Nothing in `docs/NEXT_LEVEL_PLAN.md`
covers this; it is unplanned work.

## 6. A shrunk note reports its tail citations as `not_found`

> **Correction, 2026-08-13.** The content-addressed fallback this entry says is
> missing now exists: `verifyPin` takes `allowRelocation` and does an indexed
> `snapshot_hash` lookup when the id misses, and `verifyBeliefSources` passes it
> for drift reporting (never for granting support at commit — that distinction is
> what `probes/pin_bypass.ts` guards). A moved-not-gone passage is reported as
> relocated rather than `not_found`. The original text stays below, dated.

When a note is edited down to fewer passages, ingest correctly deletes the orphaned tail
rows. A belief that pinned one of those rows then fails verification with reason
`not_found` (`src/pins.ts:173`), because lookup is by document id and that id no longer
exists.

**What it costs.** `not_found` and `hash_mismatch` call for different responses, and the
code knows it — `src/ingest.ts:668-672` argues at length that `hash_mismatch` is
actionable because it tells you the evidence *moved*, while `not_found` only tells you
it is gone. The shrink case reports the less useful of the two even when the cited text
is still present verbatim, just at a lower ordinal in the same file. There is no
content-addressed fallback: an index on `snapshot_hash` exists (`sql/schema_vector.sql:24`)
and `verifyPin` never queries it. So an operator investigating a failed verification is
told their evidence vanished when it actually just moved up the page. No test pins down
which verdict this case produces.

**What would fix it.** Fall back to a `snapshot_hash` lookup when the id misses, and
report a distinct reason — the content is unchanged, only its position moved. The index
needed for this already exists. Unplanned.

## 7. Per-tool MCP drift detection does not exist

> **Correction, 2026-08-13.** This entry's central claim was wrong, and wrong in
> the direction this document keeps being wrong: overstating the weakness. A
> same-roster rewrite of one tool's description or schema was ALWAYS caught,
> because `hashToolsList` hashes every tool's name, description and inputSchema
> into the whole-list hash — the harness test that mutates one description and
> asserts drift has passed since the pin landed. What was true: the failure was
> anonymous (`list_drift`, no tool named), the per-tool columns were written and
> never read, and the declared `tool_drift` reason never fired. As of today
> `verifyToolsAgainstPin` reads the per-tool pins and splits the diagnosis:
> roster changes report `list_drift` naming what was added/removed; a
> byte-identical roster whose tool content moved reports `tool_drift` naming
> each drifted tool and whether its description or schema changed. The original
> text stays below, dated.

`mcp_tool_pin` stores a `schema_hash` and a `description_hash` for every tool an MCP
server declares (`sql/schema_mcp_pin.sql:14-15`). They are written by `pinToolsList`
(`src/mcp_trust.ts:82-102`) and read by nothing. The only `SELECT` touching either
column anywhere in the repository is a test assertion. Correspondingly, `tool_drift` —
declared as a failure reason in the `PinCheck` union at `src/mcp_trust.ts:118` — is
never constructed at runtime; `verifyToolsAgainstPin` can only ever return `no_pin` or
`list_drift`.

**What it costs.** Less than it first appears, and the distinction matters. List-level
rug-pull detection is real and wired in: `verifyToolsAgainstPin` compares a hash of the
whole tool list and is called on the live MCP path (`src/mcp_client.ts:213,322`). So a
server that adds, removes, or renames a tool after you trusted it is caught. What is not
caught is a server that keeps its tool list identical and changes what a single tool
*does* — rewriting one tool's schema or description while the roster stays byte-identical.
That is the more interesting attack, and the columns that would detect it are dead
weight. The declared type promises a check the code cannot perform, which is worse than
not declaring it.

**What would fix it.** Have `verifyToolsAgainstPin` compare per-tool hashes against the
stored pin rows and emit the `tool_drift` its own type already declares. The data is
being collected; only the comparison is missing. Unplanned.

## 8. MCP-imported skills are content-hashed by length

`src/mcp_client.ts:272` writes a skill's `content_hash` as `String(body.length)`. That
is a character count, not a digest. Any two bodies of equal length hash identically.

Note that the analogous code in `src/mcp_bridge.ts:83` does the right thing —
`sha256(body)` — so this is a single site, not a pattern.

**What it costs.** Nothing today, and the reason it costs nothing is fragile.
`activateSkillRegistry` (`src/skills_registry.ts:114-127`) is a bare status `UPDATE`
that never reads `content_hash`, so the bad value is inert. But `tryActivateSkill` — the
real gate — does compare content hashes, refusing activation when the current hash does
not match the last critic-cleared one (`src/try_activate_skill.ts:225`). The moment
MCP-imported skills are routed through that gate using the stored column, an attacker
who can edit a skill body to the same length gets a free pass through the mutation check.

This is worth flagging because that routing is *planned*. `docs/NEXT_LEVEL_PLAN.md`
Phase 1.5 calls `activateSkillRegistry` an ungated side door and specifies routing it
through the gate. That change is correct and also exactly what arms this landmine. Fix
the hash first.

**What would fix it.** Replace `String(body.length)` with `sha256(body)`, matching
`mcp_bridge.ts`. One line.

## 9. Overlapping ingest roots still duplicate via explicit paths

Overlapping roots are rejected when they come from the config file: `assertNoOverlap`
(`src/config.ts:256-289`) runs unconditionally on parse and refuses both identical and
nested roots, with a live case-folding probe so a case-insensitive filesystem cannot
sneak a duplicate past it.

The explicit-path form bypasses that check entirely. `chamber ingest <path>` goes
straight to `ingestDirectory`, which never reads the config and keeps no registry of
previously ingested roots.

**What it costs.** Running `chamber ingest /vault` and then `chamber ingest /vault/notes`
duplicates every passage under `notes/`, silently. Document identity is the path
*relative to the root*, so the same file is `notes/a.md#p0` under one root and `a.md#p0`
under the other — two different identities, no collision, no unique index on `source_ref`
to catch it, and the existing collision warning does not fire because it only triggers on
matching relative paths. Duplicated passages inflate their own apparent corroboration in
retrieval and skew the term statistics that lexical ranking depends on. Nothing reports
that it happened.

**What would fix it.** Record ingested roots in the database and run the same overlap
check against that record on every explicit-path run, not only on config parse. Unplanned.

## 10. Ingest has no default exclude list

The directory walk prunes one thing by default, and even that is switchable: dot-prefixed
entries are skipped unless `--include-dotted` is passed (`src/ingest.ts:365-372`). Beyond
that skip and whatever the operator supplies, nothing is filtered — `ingest.exclude`
defaults to an empty array in both the CLI and the config file.

**What it costs.** Point `chamber ingest` at a large directory and it descends into every
non-hidden folder there, ingesting every `.md`, `.markdown`, and `.mdx` file it finds —
vendored dependencies, archived material, other people's checkouts, anything. The cost is
not only noise: an unrelated vendored source file has already been observed outranking a
genuine note for a near-verbatim query, so unbounded ingest degrades retrieval and
therefore degrades the evidence beliefs get pinned to. For a tool whose config file *is*
the privacy boundary, a walk that defaults to taking everything puts the entire burden on
the operator getting excludes right the first time. For contrast, `src/code_index.ts:178`
does carry a hardcoded skip list; ingest has no equivalent.

**What would fix it.** A default exclude set covering the obvious cases (`node_modules`,
`dist`, `vendor`, archive folders), overridable and printed by `chamber config show` so
the operator can see what is being skipped rather than having to infer it. Unplanned.

## 11. CJK lexical retrieval does not work

The full-text index is declared without a tokenizer (`sql/schema_vector.sql:39-44`), so
FTS5 uses its default, `unicode61`. `unicode61` splits on Unicode category boundaries. A
run of CJK text has no internal boundaries, so an entire clause becomes a single token.

**What it costs.** Lexical search over CJK content matches only on exact whole-run
equality, which in practice means it matches almost nothing. It does not crash and it
does not produce wrong results — it produces no results, consistently. Semantic retrieval
still works, so CJK queries degrade to embedding-only rather than failing outright, but
the hybrid ranking that the rest of the corpus benefits from is effectively unavailable.
Worth noting that the repository's *other* FTS5 table does set a tokenizer explicitly
(`sql/schema_hermes_parity.sql:44-50`), so this is an omission rather than a considered
default.

**What would fix it.** A tokenizer that segments CJK — the `trigram` tokenizer that ships
with SQLite is the zero-dependency option and handles CJK acceptably; a proper segmenter
would be better and would cost a dependency Chamber does not currently have. Unplanned.

## 12. Retrieval quality has no corpus-level regression guard

This entry was narrower than first recorded, and the correction is worth stating: the
hybrid-retrieval tests *do* assert rank order, not merely presence. They pin a target
passage to an exact rank under semantic-only scoring and assert hybrid moves it to rank 1
(`tests/harness.ts:1186-1202`), assert that lexical overlap cannot float an unrelated
passage past a correct answer (`:1261-1266`), and assert the bm25 candidate cut tapers
rather than cliffs (`:1636`). A change to the semantic/lexical weights or the idf math
would break them.

**What it costs.** What those tests protect is a handful of hand-built adversarial
fixtures with synthetic embeddings at hardcoded cosine distances. They are regression
pins on specific known failure modes, not a measure of quality. There is no golden set,
no relevance judgements, no `ndcg`/`recall@k`/`mrr` anywhere in the tree, and the
`benchmarks/` directory scores control-plane architecture rather than retrieval. So the
changes most likely to degrade real-world results — swapping the embedding model,
altering the chunker, or simply growing the corpus until term statistics shift — would
not move a single test. Given that retrieval quality is what stands between the citation
gate and the wrong-but-real problem in entry 2, this is the least measured part of the
most load-bearing path.

**What would fix it.** A small golden set of queries with judged relevant passages, run
as a scored eval with a floor that fails the build. Fifty queries would catch most of
what matters. Unplanned.

## 13. The scheduled job's log names neither its database nor its exit status

This entry has now been corrected twice, and both corrections narrowed it. The launchd
job (`deploy/launchd/com.chamber.verify.plist`) *does* log ingest's exit code — the `||`
branch prints `!! ingest FAILED (exit $?)` — and that chaining is deliberate and well
reasoned, so that a missing root cannot silently disable the drift check.

The finding itself also reaches the log, which an earlier revision of this entry denied.
`chamber verify` prints the belief id, its text, and a `hash_mismatch` or `not_found` line
per failed pin, each with a paragraph saying what that reason means, and closes with a
count (`src/cli.ts:1202-1250`). On a clean run that count is all there is — `0 belief(s)
checked, 0 with no verified support left` — but a run that found drift does not look like
one that did not.

Two things are genuinely missing. The job's exit status is `chamber verify`'s, non-zero
exactly when a belief has no verified support left (`src/cli.ts:1250`); launchd does not
write a job's exit status to its log, and the job does not echo it. And no run names the
database it used: the banner that prints `db: <path>` belongs to `status`, `turn` and
`queue` (`src/cli.ts:553,878,886`), and neither `ingest` nor `verify` calls it.

**What it costs.** Anything monitoring this job by exit status rather than by reading its
prose has nothing to key on, and no run states which corpus it checked. The second one is
not hypothetical: `chamber` is installed as a symlink into a working tree, so it runs
whichever branch is checked out. A *redirect* would at least announce itself — a fallback
to `/tmp` or `:memory:` writes two `chamber: WARNING —` lines naming both paths
(`src/db.ts:212-215`, `src/cli.ts:215-221`), and this job points `StandardErrorPath` at
the same file as `StandardOutPath`, so they land in this log — but the ordinary case
states the path nowhere.

**What would fix it.** Have `verify` print the resolved database path, and have the job
echo verify's exit status after it returns. Unplanned.

## 14. Citation debt is keyed on exact text; the paraphrase leg over it is weak

**Status, 2026-08-09.** A semantic leg was added after this entry was written, so
a paraphrase no longer escapes unconditionally. It is not a fix: the two sections
at the end of this document measure it and record where it fails. Read them
together with this one — this entry explains the mechanism, they explain what the
addition is actually worth. The description below is of the exact-hash leg, which
is unchanged and remains the reliable half.

The debt gate's blocking condition is keyed on `claim_hash`, and
`claimHash(type, text)` is sha256 over the exact claim text after whitespace
normalisation (`src/hash.ts:4-7`; consumed at `src/commit_belief.ts:85-97` and
`:185`). Two sentences asserting the same fact in different words are two
different hashes. An assertion blocked from being re-committed word-for-word
commits freely the moment it is reworded — and language models reword by
default.

**What it costs.** Verified by `probes/debt_paraphrase.ts` (added 2026-08-05,
exits 1 while this holds): an unsourced assertion commits and mints blocking
debt; the verbatim repeat is correctly REJECTED by that debt; a paraphrase of
the same claim commits `ok: true` while the original debt is still open. Debt
prevents *repetition*, not *reliance* on the same unsupported claim. The review
brief's sentence that debt "blocks anything built on top of" an unsupported
assertion overstates the mechanism twice over — once here, and once because a
belief-kind source is verified by existence only (`src/commit_belief.ts:239-250`),
so a belief carrying open blocking debt still counts as verified support when
cited. `--strict` (`requireVerifiedSupport`) refuses the paraphrase too, but it
refuses every unsourced assertion, original included — it is not a paraphrase
defence, and it is not the default path.

**What would fix it.** Nothing simple, and it should be said plainly: exact-text
keying is the only zero-dependency option, and any semantic-equivalence check
(embedding similarity over claim text, an NLI model) costs either a dependency
or a model call inside the gate. A belief-kind citation that consulted
`belief.status` and open debt — refusing support from a debt-laden or superseded
belief — closes the second half with a SELECT the gate already nearly performs.
Unplanned.

## 15. The embedder can silently downgrade, and runs one subprocess per passage

`embedMinilm` shells out to `python3` with `scripts/embed_minilm.py`. Two things
follow from that, and the first one destroyed a real corpus.

**It can fail without saying so.** `minilmAvailable()` (`src/embedder.ts:56`)
tests that two *files* exist. It does not test that the embedder *runs*. So on a
machine where the resolved `python3` lacks `numpy` or `onnxruntime`, availability
reports true, `embedMinilm` throws, and `embedLocal(_, "auto")` falls back to a
256-dimension hash vector. A hash vector is a valid vector, so nothing
downstream can tell.

Observed on the development machine on 2026-08-05, not reasoned about: an
interactive shell resolved `python3` to an interpreter with the dependencies,
while a **login** shell — which is what `launchd` and `systemd` units run —
resolved it to `/usr/bin/python3`, which has neither. The scheduled 08:30 job
therefore re-embedded all 28,508 passages with `local-hash-v1` every morning and
exited 0. `chamber ask` answered *"nothing in the corpus matches this question"*
for material sitting in the index, because the query was a 384-dimension MiniLM
vector and every stored vector was a 256-dimension hash.

**What it costs.** Every other signal reported health. `verify` exited 0, the
passage count was correct, and content pins verified — pins hash the stored
*body*, not the vector, so the citation gate cannot see this. The only visible
symptom was ingest finishing in two minutes instead of seventy-five, and nothing
watches for a check being suspiciously fast.

**Mitigated, not fixed.** The fallback now prints one warning per process naming
the underlying error, and `CHAMBER_PYTHON` names the interpreter explicitly —
PATH is the thing that differs between shells, so a PATH-dependent setting
cannot resolve it. What remains unfixed is the shape of the check:
`minilmAvailable()` still answers a question about files rather than about
execution, which is the same defect `engines/preflight.md` calls "a probe that
cannot fail". Nothing records, per corpus, which embedder produced it, so a
database cannot report that its vectors and its queries disagree.

**And it is slow.** `upsertDocument` calls `embedLocal` once per passage — a
fresh python startup and ONNX model load each time, measured at ~158 ms. A
28,500-passage corpus takes about 75 minutes. `embedLocalBatch`
(`src/embedder.ts:304`) exists to amortise exactly this and **has no callers**.
Wiring it in is the single largest performance win available in the ingest path.
Unplanned.

## The paraphrase gate softens when its embedder is unavailable — deliberately

The semantic half of the citation-debt gate needs a real embedder. When one is
not available — no python3, no onnxruntime, or a model with no calibrated
threshold — the check cannot run, and Chamber **commits anyway**.

That is a decision made on 2026-08-09, not an oversight. The alternative is a
hard invariant: refuse every assertion the semantic check could not examine. It
was rejected because a missing interpreter would then stop all assertion commits
— a broken dependency taking the ledger down rather than softening one check.

What makes allowing defensible is that the softening is never silent:

- the verdict carries `paraphraseCheck: "skipped"`, so a caller can see it;
- a `debt:degraded` row lands in the hash-chained audit log, written from a
  `finally` so a later refusal cannot erase it;
- a failure to write even that row warns on stderr rather than vanishing.

The exact-hash leg of the gate is unaffected and still blocks. Only the
*paraphrase* leg softens, so a verbatim repeat of an indebted claim is still
refused; a reworded one may pass.

**If you need the hard invariant**, `src/commit_belief.ts` is the place: the
`paraphrase.attempted && !paraphrase.semantic` branch currently records and
proceeds. Making it refuse is a small change; living with a ledger that stops
accepting assertions when python3 breaks is the part to weigh.

## The paraphrase leg does not work well, and the measurement says so

Calibrated 2026-08-09 against `fixtures/paraphrase_calibration.json` (25 labelled
pairs) with `minilm-l6-v2-q`. Re-run it yourself: `npm run calibrate:paraphrase`.

At the shipped threshold of 0.80: **2 of 5 true paraphrases missed, 8 of 17
non-restatements blocked.** True paraphrases score 0.715–0.917; non-restatements
score 0.082–0.991. The ranges overlap almost entirely, and the sweep finds **no
false-positive-free threshold anywhere between 0.50 and 0.99**.

The composition of the errors matters more than the counts:

| blocked at 0.80, but not a restatement | score |
|---|---|
| "within 30 days" vs "within 14 days" | 0.910 |
| "opens at nine" vs "opens at ten" | 0.956 |
| "kept for ninety days" vs "thirty days" | 0.863 |
| "enforces the sandbox" vs "does not enforce the sandbox" | 0.904 |
| "opens at nine" vs "closes at nine" | 0.880 |

Every number swap and every negation is blocked. Concretely: **an operator
correcting an indebted claim is refused on the grounds that the correction
restates it.** That is close to the opposite of the intended behaviour.

The cause is not the constant. Cosine over a bag-of-meaning embedding cannot
separate "says the same thing" from "says the opposite thing about the same
subject", and that separation is the entire job of this leg. Moving the
threshold trades one failure for the other — 0.90 catches 1 of 5 paraphrases and
still blocks 4 non-restatements.

**What still works:** the exact-hash leg is unaffected and blocks verbatim
repeats reliably. The debt mechanism, `pay-debt`, and `waive-debt` are unrelated
to this measurement.

**What was done about it, 2026-08-09.** The second of those two options is now
implemented: `src/claim_asymmetry.ts` supplies the signal cosine cannot, from
text already in hand and with no model. Before a block, it asks whether the two
claims conflict on a *number* (each side carrying a value the other lacks) or
disagree in *negation polarity*. Either is evidence they are not the same claim,
and the block is dropped.

Measured on the same 25 pairs, at the same 0.80: **false positives fall from 8
to 3 (4 on linux/x64), and no true paraphrase is suppressed.** Every number swap
and every negation stops being treated as a restatement, so the case that opened
this section — an operator refused for correcting an indebted claim — no longer
happens. `npm run calibrate:paraphrase` prints both columns, because only one of
them is good news and a report showing the improvement without its cost would be
advocacy.

The suppressor may only ever *remove* a block, never cause one. That direction
is not incidental: it is a blocklist, and this codebase has a written record of
what happens when a blocklist is asked to decide what is permitted. Asked only
to narrow, its failure mode is a paraphrase that gets through — the leg's
pre-existing behaviour, not a new exposure.

**What it does not fix.** The 2-of-5 true paraphrases the threshold misses are
untouched; this only ever removes blocks. Three false positives remain, and they
are the disagreements this mechanism cannot see: "opens at nine" against "closes
at nine" is a real contradiction with the same number and no negation. One
marker was measured out of the design — "no" fired on a genuine restatement
("**No** production deployment may go out unless the freeze has been in effect"),
because English writes positive rules negatively, so "no refunds are issued"
against "refunds are issued" still reads as the same polarity here.

The leg remains a heuristic. It is now a heuristic that fails in the cheaper
direction, which is different from being calibrated, and this note exists so
nobody mistakes the constant for one.

**And the constant sits inside platform noise.** darwin/arm64 measures 8 false
positives; the linux/x64 CI runner measures 9, from the same model file and the
same fixture. `audit_negation` scores 0.797 locally — three thousandths under
the threshold — and lands on the other side under a different onnxruntime build.
Which side a pair falls on is decided by the BLAS kernel rather than by meaning,
which is about as clear a statement as one could want that 0.8 is not a
calibrated boundary. The suppressor settles that particular pair — it is a
negation, so it is dropped on both architectures and its coin-flip no longer
reaches a verdict.

It does not settle the underlying problem, and running the suppressed set on
both platforms made that clearer. Reproduced in Docker rather than inferred:
three separate pairs sit within a hundredth of 0.80, and at least two cross it
between architectures — `office_dubai_vs_riyadh` at 0.794 on darwin and 0.804 on
linux, `backup_taken_vs_tested` at 0.814 and 0.807. So it was never one unlucky
pair. The threshold runs through a crowded part of the distribution, which is
what an uncalibrated boundary looks like from the inside, and both test bounds
are written to cover both architectures so the suite measures regressions rather
than hardware.

The entity swap in that list suggests the obvious next extension — a
proper-noun conflict check, by analogy with the numeric one. It is not
implemented, and it is not a small decision: paraphrases legitimately drop and
add names ("the Dubai office" / "our office"), so the false-suppression risk is
far higher than for digits. It would need its own measurement before shipping.

Two smaller findings from the same run, both now handled in code:

- Claims longer than the embedder's 256-token window are no longer compared at
  all. Two long claims agreeing for their first 256 tokens and contradicting
  afterwards embedded to the *same point* (0.991 measured), so the gate was
  blocking on text the model never read.
- The 32-candidate cap now has a deterministic `ORDER BY`, so the truncation
  warning describes a reproducible sample.
