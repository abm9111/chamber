# Changelog

All notable changes to Chamber. Versions before 0.1.6 are described in the git
history and the GitHub releases.

## 0.1.8 — 2026-09-28

### Fixed

- **Ingest no longer reads hidden folders or non-notes through links.** A
  symlink into a dotted folder (`notes → .obsidian`, `y.md → .obsidian/x.md`)
  was walked and indexed without `--include-dotted`, and a `.md` link to a
  non-note file took the link's extension. The dotted and extension rules now
  apply to where a link lands, and a linked note needs a note name as well as
  a note target. Existing rows indexed that way are removed by `chamber
  prune`.
- **The claim check reads what a citation shows.** The model is shown each
  passage's title and path; a name found only there (a company in its page's
  file name) is now found, from the file's own name and title only — never
  folder names, never numbers of any kind.
- Quantities match across scales by value: `1M AED` / `1 million AED`,
  `11k` / `11,000`. A glued `m`, `M` or `K` counts as a scale only next to a
  currency, so `9m yacht` and `3M tape` vouch for no millions. A bare number
  is no longer satisfied by a scaled one (`9 users` against `9 million users`
  passed before).
- A family name before its version counts (`Qwen` in `Qwen3.5-122B`); a
  capital before a digit does not (`GPT` in `GPT4`, `B` in `B2B`).
- A closing quote or bracket after a full stop still ends the sentence, and
  abbreviations before one (`Dr.”`, `(Gen.)`) still hide no name.

Measured on a held-out set of 200 claims and 74 real answer claims judged
blind: see `docs/KNOWN_LIMITATIONS.md` §2.

### Changed

- The README leads with `chamber_check`: the check your AI agent runs on your
  notes.

## 0.1.7 — 2026-09-28

### Added

- **`chamber_check` (MCP): the check your AI agent runs on your notes.** An
  agent passes its own claims with the notes they came from (absolute paths,
  `file.md#pN` refs or passage ids). Each claim comes back `SUPPORTED`,
  `TERMS_ABSENT` (naming the missing terms), `NO_TERMS`, `STALE` (the note
  changed on disk since it was indexed, so it is not judged), `NOT_FOUND` or
  `NO_SOURCE`. Unlike the check on model answers, it also checks the word that
  opens a claim, unless it is a common word ("Postgres was chosen in 2024").
  It reads a note only when the note's real path is a note ingest indexed —
  never through a link to an excluded, hidden or non-note file, and never a
  FIFO or device — and anything else fails closed as `STALE` with the
  reason. The check uses no model. It is read-only unless `record: true`, which
  commits only the supported claims through the gate, pinned to a small
  covering set of the passages that hold their terms.
- The MCP server sends `instructions` on `initialize`, telling the host when to
  call `chamber_check` and what `SUPPORTED` does not mean.

### Fixed

Upgrade if you rely on `[ALLOWED]`: the first fix below affects `ask`.

- **A term split across two cited passages no longer counts as found.**
  Passages were joined with a newline, so "…was 5" ending one and "million
  users…" opening the next satisfied "5 million", which neither says. This
  affected `ask` and every path through the commit gate.
- A name set apart by markup at the start of a claim (`**Tesla** makes it`,
  `- **Tesla:** …`) is checked again; after a label colon, a common word is
  skipped only when the phrase carries on, so a lone value (`Model: Claude`,
  `Released: May 5`) is checked.
- The claim-support term check now treats file names (`package.json`) and
  counts written as words (`four`, `twenty-five`) as terms, and reads `’`
  and `'` as one apostrophe. After a label colon it skips a common word
  instead of flagging it ("**Privacy:** Users…").

## 0.1.6 — 2026-09-27

### Security

- **A real citation no longer certifies a claim its passage does not contain.**
  Before this release a verified pin proved only that the cited passage exists
  and is unchanged, so "Kingroon filament is made on the Moon and costs $900 per
  kg [1]" came back `[ALLOWED]` over a real note about Kingroon. Every number,
  name and domain in a claim must now occur in the passages it cites; a claim
  that fails keeps none of its citations and lands as `DEBT`, `UNSUPPORTED` or,
  with `--strict`, `REFUSED`, naming the missing terms as `terms_absent: …`.
  The check runs where beliefs are written, so `ask`, `turn`, the server and
  the Discord, Slack and gateway runners all get it.
- **A cited line containing "as noted", "acknowledged" or "no evidence" no
  longer skips the gate.** Such lines were classed as chatter or aporia —
  never recorded, never printed — even when they cited a source.
- **Debt payment checks and writes its pin under one lock**, and re-checks the
  debt's status there: a waived debt could be auto-paid, and a prune between
  the check and the write could leave a debt paid by a deleted passage.

Upgrade if you rely on `[ALLOWED]`. The remaining known gaps in the support
check — it is a term check, not entailment — are listed in
`docs/KNOWN_LIMITATIONS.md` §2.

### Added

- `ask` shows the rest of a split section it retrieves a piece of. Long
  sections are stored in several passages and retrieval could return one, so
  answers were drawn from part of a table; each sibling piece is now shown as
  its own numbered, verifiable passage. A note says when a section the answer
  cites was cut short.
- `chamber prune` removes passages whose file is now covered by an ingest
  root's `exclude` list, not only files deleted from disk. An excluded
  passage is removed even when a belief cites it — the dry run names each
  such belief first, the audit log records `evidence_pruned`, and `verify`
  reports the pin `not_found`. No path of an excluded file is kept.
- `chamber --version` (also `-v`, `version`), which works with a broken config.
- The MCP server re-reads its config on every call, so a changed model base
  takes effect without reconnecting. An explicit `CHAMBER_*` environment
  variable still wins; the database stays pinned until reconnect.

### Changed

- Headings in an answer print as `[HEADING]` and are no longer recorded as
  unsourced observations. Bolded claims are no longer stored with a mangled
  leading `*`.
- The ingest metadata of each passage now carries its section number.
  **Run `chamber ingest` once after upgrading** — until then sibling
  expansion stays off for passages written by older versions. Existing pins
  are unaffected: the pin hash covers title, body and reference only.
- `qs` (dev dependency only) 6.15.3 → 6.16.0; `npm audit` reports no
  vulnerabilities.

### Verified

Sandbox isolation was re-proven on Linux with bubblewrap: the probe payload
ran, could not read `/etc/passwd`, and had no network.
