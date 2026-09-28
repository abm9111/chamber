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

> **Correction, 2026-09-26.** The last line of this entry said `[ALLOWED]`
> means "this source is real and says what the citation says it says". The
> second half was false: `[ALLOWED]` meant the source is real and unchanged,
> nothing more. Reproduced against the live vault — "Kingroon filament is
> manufactured on the Moon and costs $900 per kg [1]" came back `[ALLOWED]`
> over a real filament note.
>
> One slice of that is now checked. `ask` requires every number, capitalised
> name and domain in a claim to occur in the passages it cites
> (`src/claim_support.ts`); a claim that fails keeps none of its citations and
> lands as `DEBT`, `UNSUPPORTED` or, under `--strict`, `REFUSED`, with the
> missing terms named as `terms_absent: …`. `probes/claim_support.ts` is the
> gate. On a 10-question run over the vault it flagged 5 of 39 cited claims:
> one correctly (a term from an uncited passage), four wrongly, all from
> parsing (versions, addresses, scraped cells glued together), each fixed and
> pinned by a regression test before this shipped.
>
> **It runs at the commit, for every caller.** The check lives in
> `enforceClaimContract` and reads the cited passages from the corpus, so
> `ask` and every path through `enforceReplyContract` — `chamber turn`, the
> server, the Discord, Slack and gateway runners — get the same rule. (A first
> version ran inside `ask` only. Those other paths pass no sources today, so
> nothing on them could be certified `ALLOWED` anyway — verified — but the
> function accepted `sources`, and the first caller to pass them would have
> certified fabricated specifics. Leg 4 of the probe holds that shut.) Only
> pins that verify are judged: a missing or drifted row is rejected by the
> commit with its own reason, never relabelled `terms_absent`.
>
> The judgement below still stands for everything that check cannot see. It
> is not entailment. A fabrication built from words the passage already holds
> ("the policy forbids returns") passes, and so does one whose only specific
> is a plain name opening the sentence ("Tesla makes it [1]") — a sentence's
> first word is capitalised whatever it is, so it is only checked when its
> shape says name (`UAE`, `AliExpress`, `3DPrintU`). Read `[ALLOWED]` as "the
> source is real, unchanged, and contains this claim's specifics", never as
> "this claim is true".
>
> A second review ran the real path and found ten more ways through; the
> fixable ones are closed and pinned by a test (any-script digits and
> letters, `eBay` and `9XFabs` shapes, names after `:` `(` and dashes, scale
> words and suffixes, decimal commas, cited lines on the aporia branch). What
> still passes, by design of a term check: numbers written as words ("nine
> hundred"), a date whose parts each occur somewhere in the passage, a word
> found inside a glued name (`Express` in `AliExpress` — the same rule that
> reads scraped `FormingHandicraft` cells), and a currency symbol swapped
> around a correct number (`€9` for `$9`). It also flags some faithful claims
> — `$9` against `$9.00`, `.5` against `0.5`, `US` against `U.S.`, plurals of
> non-acronym names — which costs those claims their `[ALLOWED]` and nothing
> else. On the final 10-question vault run: 40 cited claims, 2 flagged, both
> correctly (terms absent from every cited passage), 0 wrongly.
>
> Later rounds narrowed names after abbreviations: listed ones (`e.g.`,
> `Dr.`, `Sgt.`, `Dept.`, `Ave.`, …), dotted initials in either spacing
> (`U.S.`, `a.k.a.`, `J. R. R.`) and capitalised one- or two-letter words
> (`Jr.`, `Mt.`); the list is case-insensitive, so `GEN.` counts. An
> abbreviation that is none of those — `Messrs.` — still hides the next
> name; a wider shape rule (any capitalised word of up to five letters) was
> tried and reverted because "Paris." and "Sony." then flagged the next
> ordinary sentence. A leading minus is part of its number (`-5%` ≠ `5%`)
> unless the dash directly follows a letter, a digit, a unit or a closing
> bracket (closing emphasis between them allowed: `**10%**–20%`), where it
> is a range or an id (`19-25`, `2°–8°C`, `10%–20%`, `AGPL-3.0`); a first
> version listed sign positions instead and missed markdown (`**-5%**`), a
> second missed a minus opening a line. Accepted, fail-closed: `p.-5` and
> `1.-5%` read the dash as a minus. Open, fail-open, found by the final
> pre-push audit (VIGIL AIML-008, 2026-09-27) and documented rather than
> patched by owner decision — sign handling had reached the point where
> each fix opened a new variant: HTML dash entities (`&ndash;`, `&mdash;`,
> `&#45;`, `&#x2d;`, `&#8211;`, `&hyphen;`) are not read as minus signs, so
> "Q3 sales &ndash;5%" still certifies "Q3 sales grew 5%" (only `&minus;`,
> `&#8722;` and `&#x2212;` are). Likewise open: `Messrs.` hides the next
> name, and a letter touching a dash reads as an id ("Q-5"), `$9m` / `lakh` / `%` reducing to a bare number, and a
> passage's own `1,000 million` being flagged. Accepted, knowingly: a
> capitalised ordinary word after a label or dash is now checked, so
> "Delivery: Roughly 5 days [1]" is flagged when the passage lacks
> "roughly" — the cost of catching "Manufacturer: Tesla [1]"; and a number
> restated in another form (`9 million` for `$9M`, `10 thousand` for
> `10,000`, Indian digit grouping) is flagged rather than matched.
>
> **Revised 2026-09-27 — label colons.** Checking every word after a colon
> was far costlier than the 0-in-50 vault eval suggested: models format
> answers as "**Claude Code:** Users point…", and on answers over a
> 279-thread community corpus 6 of 9 flags were such words ("Users",
> "People", "Claiming", "Large"). After a label colon a word on a common-word
> list (`src/common_words.ts`) is now skipped when the phrase carries on;
> anything else is still checked, so "Manufacturer: Tesla" and a lone value
> ("Model: Claude [1]") are caught. Re-run on the source (an earlier re-run
> went through a stale `dist/` build and is withdrawn): 28 ALLOWED and no
> term flag on the corpus questions; on the vault eval 3 flags of 49 cited
> claims. **Corrected 2026-09-28:** only one of those was right ("AI" against a
> passage saying "AIP"). The other two ("Silversmith", "School") were scraped
> table cells glued to the next cell's text ("Silversmithtechnical"); the
> replay that "verified" them used a word-boundary search with the same blind
> spot. Lowercase-to-lowercase glue is indistinguishable from "Moon" inside
> "Moonlight", so it stays a known false flag on scraped tables. A plain sentence start
> after `. ! ?` keeps the older rule, so "Tesla makes it [1]" stays unchecked
> in `ask` (a name set apart by markup, "**Tesla** makes it", is checked) —
> extending the common-word test there flagged ordinary openers ("Sales",
> "Shipping") that a hand-written list cannot cover; closing it needs a real
> word list.
>
> **Measured 2026-09-27 — what the check catches.** 200 labelled claims over
> 40 vault passages (80 supported, 120 not). The term check wrongly flagged 1
> supported claim (a Spanish passage cited for "UAE") and caught 22 of 120
> unsupported (invented values 19/25). With file names (`package.json`) and
> counts written as words (`four`) as terms it catches 26 of 120, with the
> same 1 wrong flag: most invented values (23/25), almost no negations (0/30),
> wrong attributions (0/15), false comparisons (2/20) or values swapped within
> the same passage (1/30). Those are entailment, and are what a model checker
> is for (MiniCheck-DeBERTa scored AUC 0.89 on the same set). `’` and `'` are
> one apostrophe. A file is checked by its base name, so a claim that puts it
> in the wrong directory is not caught.
>
> **`chamber_check` (2026-09-27).** The MCP check an agent runs on its own
> claims uses the same term check, plus the word that opens each claim unless
> it is a common word — so "Postgres was chosen in 2024" is flagged, where
> `ask` lets a plain opener through. On the benchmark it catches 28 of 120
> with the same 1 wrong flag of 80 (`ask`: 26 of 120). The common-word list
> was extended after seeing its misses, so those figures are optimistic.
> What it still does not catch:
> - A product named after a common word at an opening ("Numbers", "Teams",
>   "Notes", "Next" followed by more words) is read as the ordinary word.
> - Counts are checked from two to ninety-nine; "one" (a pronoun as often as
>   a number), "a hundred" and above are not.
> - A count costs a false flag when the note lists the items without counting
>   them ("the two tools" against a note naming both), and "two-factor" is
>   flagged against "multi-factor".
> - **Revised 2026-09-28 (held-out set and real answers).** The check reads
>   what a citation shows: the body, plus the names in its title and file
>   path (never their digits, so a path's date cannot supply a claimed
>   number). A quantity matches across scales by value (`1M` / `1 million`,
>   `11k` / `11,000`), so the "restated number" case above now matches for
>   scale words; a bare number no longer matches a scaled one (`9 users`
>   against `9 million users`, which it did before). A glued `m` is read as
>   million, so `5m long` (metres) satisfies "5 million". On a held-out
>   set of 200 claims written by a different model, wrong flags fell from 10
>   to 7 of 80 in check mode. The rest are an abbreviation expanded
>   (`CA` / `California`), scraped glue (`Serna BioW21Ontario`,
>   `Silversmithtechnical`), and claims that add a term the note lacks.
>   Real answers (74 claims, judged blind): 2 wrong flags of 69, both glue.
>   Accepted costs of that revision (review H): a file's own name counts, so a
>   note named `stripe-vs-adyen` vouches for "Stripe"; a family name matches
>   its versioned form ("Falcon" in "Falcon9", "Pixel" in "Pixel8") when the
>   letter before the digit is lowercase; a glued lowercase `k` is thousands,
>   so "10 km" against "10k run" is flagged; a glued `m`/`M`/`K` is a scale
>   only after a currency, so "9 users" is satisfied by "9m users".
> - A bullet (`-`, `*`, `+`, `•`) opens a line like a sentence start, so in
>   `ask` a plain name right after one ("+ Tesla makes it [1]") is the plain
>   opener above and is not checked. A label closed by a full stop
>   ("**Pricing**. The plan…") is read as a name and flagged.
> - `chamber_check` reads a note only when its real path is that indexed note
>   or another note the same root indexed. A note inside a symlinked folder is
>   indexed under the link's path while its real path is not, so it comes back
>   `STALE` ("links to a file this root did not index") rather than judged.
>   Following the link safely would mean re-deriving ingest's exclude and
>   dot-folder rules in the check, and the two disagreeing is how a link to an
>   excluded file came to be read (review E, 2026-09-27). A directory swapped
>   for a link between resolving and opening leaves a small window; Node has no
>   `openat`.
> - Meaning, as everywhere in this section: a negated or misattributed claim
>   built from the note's own words is `SUPPORTED`.

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

> **Correction, 2026-09-13.** The central objection below — that deletion is
> unsafe because "a file absent from the walk is indistinguishable from one an
> `--exclude` pattern pruned" — is true of walk attendance and false of
> existence: an excluded file is still on disk. `findGoneDocuments`
> (`src/pins.ts`) therefore keys on `existsSync` and covers the whole corpus,
> not just the pinned slice; `chamber verify` reports the count, and
> `chamber prune` removes them (dry run by default, `--confirm` to act).
>
> Two guards make that safe, and both are pinned by tests. An ingest root that
> does not resolve to a directory is skipped whole, because an unmounted
> volume makes every file under it look deleted and a per-file sweep would
> delete the corpus on the first mount failure — unreachable is unknown, never
> empty. And a passage a belief still cites is never pruned: its file is gone,
> so the stored body is the last copy of that evidence, and `verify` already
> reports it. Prune also names unreadable roots rather than reporting "nothing
> to prune", since those are opposite states that otherwise print the same
> sentence.
>
> What still stands: **renames still duplicate.** Identity is
> `(root, relative path)`, so a renamed file is ingested fresh while the old
> path's rows survive — `prune` now removes the old copy once the rename means
> its path no longer exists, but nothing recognises the two as the same note,
> so a pin on the old path does not follow the rename. The original text stays
> below, dated.

> **Correction, 2026-09-26.** The other half — a file still on disk that an
> exclude now covers — was open until today, and it was the half an operator
> actually reaches for: adding `exclude` to a root that had already been
> ingested steered only the next walk, and every passage already written
> stayed and kept answering retrieval. `prune` could not see them, because
> their files existed. `findExcludedDocuments` (`src/pins.ts`) now matches
> stored rows against each configured root's `exclude` list with the walk's
> own normalisation (`excludeMatcher`, `src/ingest.ts`), and `chamber prune`
> lists them in their own section and removes them with the same dry run, the
> same pin exception and the same single transaction. (Revised the same day,
> owner decision: an *excluded* passage is removed even when a belief cites
> it — an exclude is usually a privacy act, and a kept cited passage went on
> answering retrieval. The dry run names each citing belief before anything is
> deleted, each deletion is written to the audit chain as `evidence_pruned`
> in the same transaction, and verify reports those pins `not_found`. A gone
> file's cited passage is still kept: its stored body is the last copy of the
> evidence.) The mistyped-exclude
> risk the text below raises is bounded by the dry run, which names every file
> before anything is deleted, and by `ingest` refusing a pattern that matches
> nothing. Still open: a symlink inside a root retargeted to somewhere outside
> it is skipped by the walk as `symlink_escape`, but the rows an earlier
> ingest wrote through it are neither gone nor excluded, so prune does not
> list them. And when the config stops parsing, `chamber_corpus` and
> `chamber_verify` keep answering from the open database with the notice on
> stderr only, not in the tool result.



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

> **Partial fix, 2026-08-18.** The *moved* half of this class is now rescued —
> for the `hash_mismatch` variant. A 3-month backtest on a real vault (434
> pins) measured one top-of-note insertion firing all nine pins below it while
> each body sat byte-identical one slot down; `findMovedWithinFile`
> (`src/pins.ts`) now re-frames same-file rows at the pin's recorded position
> and reports those as moved (`relocations` in `verify --json`), not broken.
> The shrink variant this entry opens with is **still not fixed**: a deleted
> row leaves `not_found`, and with the row gone there is no recorded position
> to re-frame against — vdoc ids are opaque hashes, and `belief_source` stores
> only `(kind, ref_id, snapshot_hash)`. The durable fix is to store the pinned
> `source_ref` on `belief_source` at commit time; until then a note that
> shrinks past a moved passage still reports it as vanished.
>
> **Shrink case closed, 2026-08-19.** `belief_source.pinned_ref` now records the
> `path#pN` a pin was minted against, captured from the verdict at commit time —
> the only moment the row is known to exist. When the row is later swept, the
> report path re-frames the surviving passages of that file at the recorded
> position and reports `moved: note.md#p4 → note.md#p2` instead of `not_found`.
> Measured on the scenario this entry describes: a five-section note losing two
> sections from the top went from `not_found` with no ref at all, to a
> relocation naming both positions and the section title, counted as verified.
>
> `belief_source.pinned_root` records the ingest root alongside it, because
> `source_ref` is root-relative and so names a path rather than a file. The
> first version derived the root from whichever rows still held that path and
> refused when they disagreed; review showed that only refuses while both
> vaults are observable — with the pin's own vault swept for that file, one
> unrelated vault holding the same filename was a majority of one and the
> rescue resolved into the wrong corpus. Nothing is derived now: no recorded
> root, no rescue. Pins written before these columns existed carry NULL and
> keep the old behaviour — verified against a real 434-pin database, whose
> verify counts were unchanged by the migration.
>
> **Genuinely deleted text still reports `not_found`**, and now names the
> position it was minted against — in the CLI's default output, the `--json`
> struct and the MCP tool alike, each marked as historical rather than as a
> place to go and look. The first version of this change put it only in
> `--json`, so the claim was true of the output almost nobody reads.
>
> **And the rescue introduces one limitation of its own** — stated here because
> the commit that added it wrongly called this inherited. The primary
> relocation matches on `snapshot_hash`, which *contains* `source_ref`, so it
> can only ever match a row whose title, body and position are all identical:
> proof that nothing moved. Re-framing deliberately decouples content identity
> from position identity, which is what lets it follow a shifted passage — and
> what leaves it unable to distinguish "the same paragraph, moved" from "a
> different paragraph that reads identically." So a pinned passage that is
> **edited** while a byte-identical copy of its old text survives elsewhere in
> the same file is reported as a relocation, and its belief still counts as
> fully verified. Reproduced deliberately during review; no attacker privilege
> is needed, only an ordinary edit plus a duplicate (an appendix, a changelog,
> a templated section). The rescue is scoped to one `ingestRoot` and one file,
> and callers no longer render it as "support intact" — but content-addressing
> cannot close this. The fix is the same one the shrink case needs: store the
> pinned `source_ref` on `belief_source` at commit time, so a rescue can
> require a coherent shift rather than a content match alone.

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

**Measured, 2026-09-13**, against a real 43,541-passage corpus, comparing FTS5
`MATCH` recall to ground truth (`body LIKE`) for one probe term per script:

| probe   | passages containing it | FTS matches | recall |
|---------|-----------------------:|------------:|-------:|
| English |                     56 |          53 |    95% |
| Arabic  |                     13 |          13 |   100% |
| CJK     |                     80 |           6 |   7.5% |

Two corrections to the text above. It is not "no results, consistently" — a CJK
run matches when a query happens to reproduce a whole token exactly, which is
7.5% of the time here rather than 0%. And the entry's silence about other
non-Latin scripts reads as though they share the problem: **Arabic does not**.
`unicode61` splits on Unicode category boundaries, and Arabic is
space-separated, so its words tokenize normally — full recall on this corpus,
which holds more Arabic (1,786 passages, 4.10%) than CJK (1,236, 2.84%).

**What would fix it, and why it is not being done.** A tokenizer that segments
CJK — SQLite's `trigram` is the zero-dependency option; a proper segmenter
would cost a dependency Chamber does not have.

The reason to leave it: the tokenizer is a property of the FTS table, so
changing it rebuilds the index for the *entire* corpus and changes matching
semantics for every language in it, to raise recall on 2.84% of passages that
are — in this corpus — scraped third-party Chinese pages (`grizzlysms.com/cn`,
`zh-CN` product docs) rather than operator-authored notes. Trigram also matches
substrings, which changes Latin ranking as a side effect.

That calculus is corpus-dependent, not permanent: a corpus whose CJK is
first-class content should make the swap, and the measurement above is the way
to decide rather than guess. Unplanned, deliberately.

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

## 15. The embedder truncates at 256 tokens, and the chunker overshoots it

> **Added 2026-09-26 — a split section reached the model in part.** Keeping
> passages under the embedder's limit splits 8,242 of the vault's 18,755
> sections into pieces, and retrieval ranks pieces independently. The
> filament note's Tier 1 table had its header, Eryone and Geeetech in one
> piece and Elegoo alone in the next; retrieval returned the second, and three
> of three answers named 4 of the 8 brands the note lists. `ask` now shows a
> retrieved piece's siblings — same file, root and heading path — as their
> own numbered, pinned passages (`src/siblings.ts`), up to 5 per section and
> 2k in total; the same question then named 8 of 8, three of three. The cost
> is prompt size: on a 10-question vault run nearly every answer used the
> full 2k. A section cut by the cap is announced only when the answer cites
> it (6 of 10 answers on that run), because a note on every answer is one
> nobody reads.
>
> Sections are identified by the chunker's own section number, stored in each
> passage's metadata at ingest. Title and position could not tell one split
> section from consecutive sections sharing a heading — a daily log's run of
> `## Entry` sections was shown as one section, with a bogus "partial" note
> (round-3 review). A passage ingested before this change has no section
> number and gets no expansion until the next `chamber ingest`, which rewrites
> metadata without touching pins (the pin hash covers title, body and ref
> only). Measured on a re-ingested copy of the vault: every one of 44,037
> passages numbered; 8,258 of 18,809 sections split (43.9%); the filament
> question 8 of 8 brands, three of three. Open: section numbers are stable
> for identical bytes but renumber when a section is inserted above, and
> `ingestDirectory` writes a file's rows without a per-file transaction — an
> ingest interrupted mid-file can leave old-numbered pieces beside new ones,
> and until the next complete ingest of that file a hit may be shown with a
> stale piece of a different section (round-4 review, reproduced with a
> simulated crash; the title-and-adjacency rule before it had the same
> window). Each piece still carries its own pin, so no citation is affected.

`embedMinilm` shells out to `python3` with `scripts/embed_minilm.py`. Most of
what this entry used to describe has been closed; what follows separates the
two.

**Closed: the availability check answered the wrong question.**
`minilmAvailable()` tested that two *files* exist. Both ship in the repo, so it
returned true on every checkout — including on the machine whose resolved
`python3` had neither numpy nor onnxruntime. `embedMinilm` threw, `embedLocal`
caught, a 256-dimension hash vector went in where a 384-dimension semantic one
belonged, and nothing downstream could tell: a hash vector is a valid vector.
The 08:30 job re-embedded 28,508 passages that way every morning and exited 0,
and `chamber ask` answered *"nothing in the corpus matches this question"* for
material sitting in the index.

It now runs the embedder on a fixed input and requires a 384-dimension vector
back, cached per interpreter path. `minilmInstalled()` keeps the files
question, because the two callers need different answers: an install with no
model files should quietly use hash vectors, while an install whose interpreter
cannot run the model must throw for anyone who passed `prefer: "minilm"`.

**Closed: the downgrade is audible, and a mismatched corpus says so.** The
fallback warns once per process naming the underlying error; `CHAMBER_PYTHON`
names the interpreter explicitly, because PATH is the thing that differs
between an interactive and a login shell; and `chamber ask` compares the
query's model against the corpus's dominant model and says so in its note
channel rather than returning an empty result with no cause.

**Closed: one subprocess per passage.** `embedLocalBatch` is wired into
`src/ingest.ts`, which was the path that took 75 minutes for 28,500 passages.
`upsertDocument` still embeds singly for callers that hand it a body rather
than a vector, which is correct for one-off writes and for query embedding.

**Open: 1.24% of passages lose their tail, and the chunker is why.** 256 tokens
is all-MiniLM-L6-v2's own trained `max_seq_length`, so truncating there is
correct — raising it would exceed what the model was trained for. Doing it
silently was not: a half-embedded passage produces a valid vector, verifies
(pins hash the stored body, not the vector), and counts toward the passage
total. The only symptom is a query that cannot find text the corpus visibly
contains, which reads as bad retrieval rather than as content that was never
indexed.

`chamber ingest` now reports it — passage count, tokens dropped, longest input
— on stderr, where a scheduled run greps for surprises.

Measured over a real 43,541-passage corpus on 2026-09-13: **541 passages
(1.24%) exceeded the limit and 80,989 tokens were dropped**, the worst single
passage losing 370 of its 626. Narrow, and it was invisible until counted.

**Mostly closed, 2026-09-13: the estimator, not the cap, was wrong.** The
chunker does bound every passage — at 220 *estimated* tokens, with deliberate
margin under 256. The estimate was the defect: `ceil(len/6)` per alphanumeric
run undershot the real wordpiece count on 47.7% of that corpus, so 541
passages sat under the cap while exceeding the window. One content shape
explains it — long runs containing a digit (base64, hashes, API tokens, UUIDs)
split near one token per 1.5 characters, and an 800-character blob charged 134
tokens cost 573. Non-ASCII was not implicated: of 2,628 passages over 20%
non-ASCII, zero exceeded the limit.

Opaque runs are now charged accordingly. Measured by re-chunking the 154
affected files and counting real wordpieces: passages over the window fell
from 540 to 113, and **tokens silently dropped fell from 80,970 to 2,846** —
96.5% of the lost text recovered.

The narrowness of the predicate is the interesting part. A first version
treated anything not purely lowercase/Capitalised as opaque, which swept in
every CamelCase product name (`OpenClaw`, `TestFlight`) and removed the last
breaches at the cost of re-chunking 54.8% of files and 73.7% of all passages.
Boundary churn is cumulative — shifting one unit's estimate moves every
packing boundary after it — so a 2% change in estimated size is not a 2%
change in the corpus. The shipped predicate touches 154 files instead, and
before accepting even that: of the 47 pins in the corpus that resolve to a
passage, zero are in a file that re-chunks, so no belief loses its evidence.

**Still open.** 113 passages (0.34%) overshoot by small margins, and they are
mostly single unsplittable opaque runs where the oversized-unit path bounds by
characters rather than wordpieces. No estimator closes that; only splitting on
a real tokenizer would, and that would make chunk boundaries depend on whether
python is installed — different machines chunking the same note differently,
which is a worse defect than a truncated tail. A corpus ingested before this
change keeps its old boundaries until re-ingested.

Also note: `models/minilm/tokenizer.json` declares `truncation.max_length:
128`. The script overrides it to 256 explicitly, so the model's full length is
used — but any *other* consumer of that tokenizer file gets 128 silently. A
measurement script written against it reported "0 passages over 256" for this
corpus, which was the instrument capping, not the data.

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

## 18. `npx` could not run this package at all before 0.1.3

> **Correction, 2026-08-14 (same day, hours later).** The entry below was
> wrong twice within hours of being written, in ways worth recording. First:
> it claimed Node 26 lifts the node_modules type-stripping restriction — a
> clean-cache test on 26.5 refuted that; the restriction is effectively
> universal on current Node. Second and worse: the "every local verification
> had quietly run on Node 26" line understated the failure. The local npx
> verifications were green because npm resolved the LOCAL repository package
> (matching name@version at the working directory) and never executed the
> registry tarball at all — the verified-cold claims made after 0.1.1 and
> 0.1.2 were false, and the tarball additionally never shipped
> `fixtures/demo`, so `try` would have failed even without the stripping
> error. Green checks that never tested the real path, on the project that
> exists to catch exactly that. Fixed in 0.1.3: the tarball ships compiled
> JavaScript (`prepack` → `dist/`; the bin shim prefers it) plus the demo
> fixtures, and the release checklist now requires the clean-cache,
> neutral-cwd tarball test before any publish.

Node refuses to strip TypeScript types for files under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) on Node 24, and `node_modules`
is exactly where `npx` installs `@bu7umaid/chamber`. So `npx -y
@bu7umaid/chamber try` — the README's own npm one-liner — dies on the current
LTS. Node 26 lifts the restriction; the git-clone path runs TypeScript from a
regular directory and needs only the documented 23.6 floor. Found by the
GitHub Action's self-test on a stock `ubuntu-latest` runner (Node 24.19) after
every local verification had quietly run on Node 26.

**What it costs.** The lowest-friction install path silently excludes the
default Node of most CI images and many machines, with a raw stack trace as
the only explanation. The bin shim's version guard checks the 23.6 floor and
passes 24 — correct by its own rule, wrong about this case.

**What would fix it.** Ship compiled JavaScript in the npm tarball (a
`prepack` build; the repository itself stays TypeScript-direct), or teach the
bin shim to catch this specific error and say "Node 26+, or clone" instead of
stack-tracing. Until one of those lands, the action and docs pin Node 26.

## 19. `ask` on the stub answered in a real model's voice, unlabelled

*Added and fixed 2026-08-16, found by an audit of this repository rather than
by using it — which is the uncomfortable part: `CLAUDE.md` has warned "never
demo `ask` on the stub" for weeks, and this file, the one that is supposed to
be the honest surface, did not carry it.*

`CHAMBER_MODEL` defaults to `stub` (`src/model.ts`), and `model.mode` is
optional in the config file with no default applied (`src/config.ts`) — so
`applyModelEnv` seeds nothing, `complete()` falls through to `stubComplete`,
and a config that simply omits `model.mode` gets canned text. For a question
beginning what/who/how/why that text is:

> I can answer from committed observations and retrieved corpus pins only. Ask
> me to search or state a fact: claim.

which reads exactly like a real model declining for lack of sources. It was
returned by `chamber ask` and by the `chamber_ask` MCP tool with no marker,
followed by a per-claim citation verdict block computed over that canned
sentence — so a `[verified]` under it meant the canned sentence had cited a
real passage, not that anything had been answered.

**The one existing signal did not reach the reader**, twice over. It was a
`console.error` line in `src/mcp_server.ts`, which lands in the MCP host's log
rather than in the tool result anyone reads; and on this exact path it printed
`model=undefined`, because the env var it echoes is the one that was never set.

**Fixed.** `AskResult` now carries `modelMode`, and both surfaces render
`stubDisclosure()` above the answer — one shared function, because a
disclosure each surface phrases for itself is one a surface eventually drops.

**What remains.** The disclosure is a label, not a refusal: `ask` still answers
on the stub, deliberately, because `chamber try` and the demos depend on an
offline deterministic path. A reader who ignores five lines of capitals gets
the old behaviour back.

## 20. The runtime image ships 56 HIGH/CRITICAL CVEs with no fix available

Nothing scanned the image until 2026-09-13. `npm audit` and Dependabot read
`package.json`, and runtime dependencies here are deliberately empty — so both
reported a clean project while `node:24-bookworm-slim` carried **62 HIGH or
CRITICAL CVEs**. A dependency gate that cannot see the operating system is not
an image gate, and the absence of findings was the absence of a scanner.

**Fixed, in part.** `deploy/Dockerfile` now applies the base's security
updates and deletes npm, npx and corepack — never used at runtime, and the
carrier of three of the six fixable HIGHs (its bundled `tar`,
`brace-expansion` and `ip-address`). That took the fixable count from 6 to 0,
measured. CI's `image` job builds the Dockerfile and fails on any HIGH or
CRITICAL **that has a fix available**.

**What remains, and it is the larger number.** 56 HIGH/CRITICAL have no
upstream fix — 52 HIGH and 4 CRITICAL, one of which (zlib) upstream has marked
`will_not_fix`. The `image` job passes `--ignore-unfixed`, so none of them
blocks a build.

That is a deliberate tradeoff, and the honest way to read the green badge is:
*no CVE with an available fix is present*, not *the image is free of critical
vulnerabilities*. The alternative — failing on the unfixable set — makes the
job red on the day it is added and red every day after, which is the failure
this project keeps fixing elsewhere: an alarm that always fires is one its
reader learns to wave through. The full set, unfixable included, is printed to
the job summary on every run so the number stays visible rather than becoming
folklore.

**What would actually close it:** a smaller base. Most of the 56 are in
Debian packages this image never executes. `node:24-alpine` or a distroless
base would remove them by removing the surface, which is the same choice the
npm deletion made. Not done here because the embedder path's Python
dependencies (`scripts/embed_minilm.py`, numpy/onnxruntime) are not yet proven
on musl, and shipping an image whose semantic gate silently degrades to hash
vectors would trade a scanner number for a correctness regression.
