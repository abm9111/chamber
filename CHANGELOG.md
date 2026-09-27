# Changelog

All notable changes to Chamber. Versions before 0.1.6 are described in the git
history and the GitHub releases.

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
