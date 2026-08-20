# Chamber Drift — Obsidian companion plugin

**Date:** 2026-08-20 · **Status:** approved design · **Owner:** abm9111

## Why

Chamber's r/ObsidianMD launch research (vault:
`10 - Infrastructure/2026-08-09__chamber-launch-posts.md`) found *"why not a
plugin?"* asked, and top-voted, three times on the closest comparable. The held
POST 2 answers it with an explanation and one planted line: *"a thin companion
plugin that just shows the verdicts is possible later; the scheduling belongs
outside either way."* This is that plugin. It converts the post's best objection
into working code, and makes Chamber non-tangential to r/ObsidianMD (Rule 4).

Scope doctrine, fixed: **Chamber checks; the plugin shows.** Scheduling,
hashing, verification all stay outside Obsidian. The plugin is a read-only
renderer of one file.

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Transport | Report file in the vault | Works on mobile (report syncs with the vault — see the Sync caveat below); no `child_process`, no server, no token → fastest registry review; failure mode is honest staleness |
| Surfaces (v1) | Sidebar panel + per-note banner | Banner makes it native rather than a report viewer; gutter/line marks cut (passage→line mapping is fragile) |
| Registry | Try for it — submit within ~1 week | POST 2 window ~Sep 12; review queue 2–6 weeks; "submitted, BRAT meanwhile" is an acceptable fallback |
| Repo | New: `abm9111/chamber-obsidian` | Registry requires manifest at repo root + releases carrying `main.js` |
| Identity | id `chamber-drift`, name "Chamber Drift" | Descriptive, collision-safe |
| Mobile | `isDesktopOnly: false` | File transport genuinely works there — a differentiator, since Chamber itself cannot run on mobile |

## The report contract

Input is the existing `chamber verify --json` output, written by the user's
scheduled job. Documented one-liner (Chamber-side docs change only — no code):

```
chamber verify --json > "<vault>/_chamber/.report.tmp" ; [ -s "<vault>/_chamber/.report.tmp" ] && mv "<vault>/_chamber/.report.tmp" "<vault>/_chamber/report.json"
```

Two guards in one line, each earned: the temp file lives NEXT to the destination, not in /tmp: `mv` is only an
atomic rename within one filesystem, and /tmp is routinely a different one
(tmpfs on Linux), where mv degrades to copy+unlink — exactly the half-written
read this line exists to prevent. The dotted temp name keeps it out of the
vault index; the rename onto `report.json` fires the modify event the plugin
watches for. And the `[ -s … ]` guard moves only a NON-EMPTY temp file — the
redirect creates the file even when the command never runs (wrong PATH under
launchd, crash before output), and an unguarded `mv` then replaces the last
known-good report with an empty one. `&&` after verify would be the wrong
guard: verify EXITS 1 WHEN DRIFT EXISTS — its most important output — so
gating the move on exit status suppresses exactly the reports that matter.
Review caught both wrong forms shipping side by side. Exit code semantics
of the cron job are unchanged.

**Default location `_chamber/report.json` — deliberately NOT dot-prefixed.**
Obsidian's vault index ignores dot-folders: no `vault.on('modify')` events, and
Obsidian Sync does not sync them. An underscore folder gets vault events (no
polling), syncs everywhere (Obsidian Sync, iCloud), and a `.json` file does not
appear in graph/search. The path is configurable; a configured dot-path falls
back to 30-second mtime polling via `vault.adapter`.

**Mobile caveat, stated rather than discovered later:** first-party Obsidian
Sync does NOT sync arbitrary file types by default — a `.json` file rides on
the "Sync all other types" toggle, which ships off. iCloud/Syncthing sync
everything. So the mobile story is real but requires one documented toggle for
Obsidian Sync users; the plugin's missing-report state says so on mobile
("using Obsidian Sync? enable Settings → Sync → Sync all other types") instead
of presenting a silent empty panel. The panel header also shows the report's
`database` basename, so a report cron-wired to the wrong vault is visible
rather than mysterious.

Shape consumed (subset; unknown fields tolerated so Chamber can grow
additively):

```
{ database, since, checked, broken, degraded, unsourcedBeliefs,
  relocatedPins, goneFiles: [{file, passages}],
  beliefs: [{ beliefId, content, total, verified,
              failures:    [{refId, reason, sourceRef?, title?}],
              relocations: [{refId, from, to, title?}] }] }
```

Validation requires only: top-level object, `beliefs` is an array. Anything
less renders the "report unreadable" state, never a crash.

## Components (one job each)

**`ReportSource`** — locate, watch, parse, validate. Emits `Report | null` plus
a change event. Subscribes to create, modify AND rename for the configured
path (an atomic rename-over can surface as any of the three depending on
platform watcher), and additionally runs a low-frequency safety poll (every
5 minutes) regardless of events — a missed event means a silently stale panel,
which is this product's own failure mode pointed at itself. Implementation
risk, named: vault events for non-markdown files are assumed but not yet
verified on every platform; day-1 check, before anything is built on top.
Reports over 5 MB render a "report too large" state instead of freezing the
UI thread.

**`RefResolver`** — `path#pN` → `TFile | null`. Refs in the report are
relative to the *ingest* root; when that root is the vault root they map
directly. But ingesting a SUBFOLDER of the vault is an ordinary setup, and
then every ref misses at the vault root. Resolution order, deterministic:
(1) exact vault path; (2) unique path-suffix match — a vault file whose path
ends with the ref's path, accepted only when exactly one exists (a uniqueness
proof, not a guess); (3) surfaced, labeled "outside this vault", not
clickable. Ambiguity always lands in (3). No passage→line mapping in v1.

**`FileIndex`** (pure) — inverts the report: `vaultPath → {driftedPins,
movedPins, citingBeliefs[]}`. Feeds the banner and the panel's per-file filter.

**No intact counts, and that is a data fact, not a choice:** a healthy belief's
report entry carries `verified`/`total` and EMPTY `failures`/`relocations` —
the refs of intact pins appear nowhere in `verify --json` (verified against
`verifyBeliefSources`: healthy pins only increment a counter). So the plugin
cannot know which files healthy conclusions stand on, and any UI implying it
can is speced against data that does not exist. The first draft of this spec
made exactly that mistake ("Ground for 2 conclusions · 1 lost support").

**`DriftPanel`** (`ItemView`, right sidebar) —
- Header: `checked <relative-time> · N conclusions · B broken · D degraded · M moved`.
- Drifted beliefs: content excerpt + per-pin chips
  (`hash_mismatch: refunds.md#p0 — now holds: <title>`,
  `not_found: … — minted against <ref>`). Click → open file.
- Relocations in a collapsed **info** section — mirroring Chamber's own
  alarm/info split; moves are never rendered as alarms.
- `goneFiles` rendered as their own info block ("pins verify against stored
  content only"), same wording discipline as the CLI.
- Staleness warning when report age > threshold (default 48h): "report is
  3 days old — is the scheduled verify running?" Age comes from a
  `generatedAt` field INSIDE the report, never from file mtime — a synced
  copy's mtime is whatever the sync engine set it to, so mtime-based
  staleness is a control that silently stops working on exactly the mobile
  path this transport exists for. mtime is the fallback only for reports
  from Chamber versions predating the field, and is labeled "approx".
- Empty states: no report → setup instructions with the exact cron line;
  report clean → "No drift. Every pinned source still says what it said."
  — as built, and the clean claim additionally requires goneFiles to be
  empty: a deleted pinned note's pins verify against stored content
  (chamber KL 5), so the sentence is false exactly then, and the gone-files
  info block renders instead.

**`NoteBanner`** — drift-only, quiet by default: appears ONLY on notes with
drifted or moved pins — *"1 conclusion lost support standing on this note"*,
*"2 passages here moved under conclusions"*. Healthy notes get nothing, which
is both the honest rendering of the available data (above) and the more
Obsidian-native behaviour: chrome that appears only when something is wrong.
Click → opens panel filtered to that file. Injected into the view's CONTENT
container, not the titlebar chrome — layout-safe on mobile, whose header
differs. Removed cleanly on unload/toggle. Styled via `styles.css` using
Obsidian CSS variables only (theme-safe).

**`Settings`** — report path (default `_chamber/report.json`), staleness
threshold hours, banner on/off, show-relocations on/off.

## Error handling

- Missing report → instructions, not an error.
- Malformed JSON / failed validation → "report unreadable" + path.
- Unresolvable refs → listed and labeled, never guessed.
- The plugin writes nothing except its own settings. Read-only by
  construction; there is no code path that modifies a note or the report.

## Testing

Pure logic (`parse/validate`, `RefResolver` path handling, `FileIndex`
inversion) lives in `src/core/` with no Obsidian imports, under vitest.
**Fixtures are generated by real `chamber verify --json` code** against a
small synthetic corpus the regeneration script builds (checked in; as-built
deviation from the earlier "demo corpus" wording — the demo corpus cannot
produce all four required scenarios in one report) — the parser is tested against
actual Chamber output, never hand-written JSON. This is the test-the-surface
lesson applied from day one.

UI (panel, banner) gets a manual checklist in the repo (desktop + one mobile
platform). CI: `tsc --noEmit`, eslint, vitest, esbuild production build.

## Registry submission

`manifest.json` (`minAppVersion` per current API floor), README with
screenshots + the cron line, MIT LICENSE at root. No network calls, no
`child_process`, no `eval`, no `innerHTML` from report data (all rendering via
DOM APIs — report content is the user's own text, but the reviewer checks the
pattern, and untrusted-input discipline is free here). **Release tags carry NO
`v` prefix** — the registry automation requires the tag to equal
`manifest.json`'s version exactly, and `v1.0.0` vs `1.0.0` is a known
review-cycle-losing trap. PR to `obsidianmd/obsidian-releases` targeted ≤7
days from start; BRAT install documented from day one.

**Day-1 checks, before any code:** (1) vault events fire for `.json`
create/modify/rename on desktop + one mobile platform; (2) grep
`community-plugins.json` for id/name collisions with `chamber-drift` /
"Chamber Drift"; (3) confirm current `minAppVersion` floor.

## Non-goals (v1)

- No passage/line-level editor decoration.
- No "verify now" button (would need `child_process`; desktop-only; revisit
  post-registry as an optional desktop enhancement).
- No reading of Chamber's SQLite, ever — the report file is the only contract.
- No multi-root mapping UI; unresolvable refs are labeled instead.

## Timeline

Build ~3 days · screenshots/README day 4 · registry PR day 5–7. POST 2
(~Sep 12) then answers "why not a plugin?" with either "in the registry" or
"submitted — BRAT meanwhile", both working answers.

## Chamber-side changes

One additive field, plus docs:

- **`generatedAt` (ISO-8601) added to `VerifyRunReport`** — verified absent
  today. Additive, so the Action (which passes the object through) and every
  documented consumer are unaffected; `docs/CI_DRIFT_GATE.md`'s field list
  gains one entry. Needed because staleness is a core plugin feature and file
  mtime does not survive sync honestly.
- Docs: README + a short `docs/OBSIDIAN.md` with the report one-liner and a
  pointer to the plugin repo. The `verify --json` shape now has a second
  external consumer; it was already documented as a contract, and stays one.
- An optional `--out <path>` flag with atomic write is a later nicety, not a
  dependency.

The plugin repo's fixture-regeneration script imports a LOCAL chamber
checkout (`CHAMBER_SRC`, default `../chamber`) rather than `npx` — as-built
deviation, and a necessary one: the published 0.1.4 package predates
`generatedAt`, so npx-generated fixtures could never contain the field the
staleness tests exist for. Dev-time only; the plugin at runtime has zero
Chamber dependency.
