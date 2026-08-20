# Chamber in your Obsidian vault

Chamber's `verify` command already tells you when a citation's ground moved
underneath it. [Chamber Drift](https://github.com/abm9111/chamber-obsidian)
is a companion Obsidian plugin, in its own MIT-licensed repo (first released
as 1.0.0), that renders that report inside your vault: a sidebar panel
listing every drifted belief, and a quiet banner on notes that carry one.
This page covers the Chamber side of the setup — getting `verify --json`
into the vault correctly and on a schedule. The plugin's own README covers
the UI, its settings, and what it does with the file once it exists.

## Division of labour

Chamber checks; the plugin renders. Ingesting, hashing and verifying all
happen outside Obsidian, on a schedule you control — see below and
[`deploy/SCHEDULING.md`](../deploy/SCHEDULING.md). The plugin does none of
that: it makes no network call, spawns no process, and has no code path that
writes to your vault or your notes. It reads one file — the report your own
scheduled job already produced — and renders what is in it, nothing else. If
a report is wrong, stale, or missing, that was decided before the plugin ever
saw it; there is no "verify now" button, on purpose.

## The report one-liner

The plugin watches one file, `report.json`, inside an `_chamber/` folder in
your vault. Writing it safely is one line:

```sh
chamber verify --json > "<vault>/_chamber/.report.tmp" ; [ -s "<vault>/_chamber/.report.tmp" ] && mv "<vault>/_chamber/.report.tmp" "<vault>/_chamber/report.json"
```

Replace `<vault>` with your vault's actual filesystem path — neither launchd
nor cron expand `~` for you.

Two guards, both earned the hard way:

- **The temp file sits next to its destination, not in `/tmp`.** `mv` is only
  an atomic rename when source and destination share a filesystem. `/tmp` is
  routinely a different one (tmpfs on Linux), where `mv` silently degrades to
  copy-then-unlink — which reintroduces the half-written read this line
  exists to prevent. Same-directory `mv` is instant and atomic; the plugin
  never observes a partial file.
- **The gate is `[ -s … ]`, not `&&` after `verify`.** `chamber verify` exits
  1 exactly when it finds drift — that is its most important output, not a
  failure. `chamber verify --json && mv …` would discard the report on every
  run that found something and keep only the boring ones. `[ -s … ]` checks a
  different thing: whether the command produced *any* output at all. A run
  that writes nothing — wrong `PATH` under launchd, `chamber` not on it, a
  crash before the first byte — leaves the temp file empty, the guard fails,
  and the last known-good `report.json` is left alone instead of being
  overwritten with nothing.

## `_chamber/`, not `.chamber/`

The folder is underscore-prefixed on purpose. Obsidian's vault index ignores
dot-folders entirely — no `create`/`modify`/`rename` events for anything
inside one, and Obsidian Sync does not sync them either. A dot-prefixed
report path is invisible to the plugin except through a slow poll, and never
reaches a synced phone at all. This is the opposite of this repo's own CI
convention — `.chamber/chamber.sqlite`, dotted on purpose to stay out of a
directory listing (see [`CI_DRIFT_GATE.md`](CI_DRIFT_GATE.md)) — so do not
reuse that path inside a vault; the dot means something different in each
place.

The temp file's *name*, `.report.tmp`, is dot-prefixed for the opposite
reason: a transient file mid-write is exactly what you don't want the vault
index noticing, and it lives inside the underscore folder anyway. The `mv`
target is what has to be visible, and it is.

## Scheduling it

This is [`deploy/SCHEDULING.md`](../deploy/SCHEDULING.md)'s job with the
`chamber verify` line replaced by the one-liner above. That page has the full
reasoning for the login shell (`-lc`, so the job inherits the `PATH` `npm
link` needs), for running `chamber ingest || echo …` unconditionally instead
of `ingest && verify` (an ingest failure must never silently skip verify),
and for the `%`-in-crontab trap — read it once rather than have it repeated
here, where the two copies could drift apart from each other.

What's different for a vault: `chamber verify` alone is a hash comparison
against stored pins, no model involved, and its cost scales with how many
citations you have. `chamber ingest` is the expensive step — it re-walks and
re-embeds every file under the configured root on every run, not just what
changed (KNOWN_LIMITATIONS entry 15). Running both every 15 minutes, as
below, is unremarkable for a personal vault. If ingest gets slow enough to
notice, split the two: ingest on a coarser schedule, and the bare one-liner —
which only reports on whatever the last ingest already found — on a tighter
one, to keep the vault's copy fresh in between.

**macOS (launchd)**, every 15 minutes. Save as
`~/Library/LaunchAgents/com.chamber.verify-obsidian.plist`, substituting
`REPLACE_WITH_HOME` and `REPLACE_WITH_VAULT` for real paths (same placeholder
convention as `deploy/launchd/com.chamber.verify.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.chamber.verify-obsidian</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>echo "=== chamber $(date '+%Y-%m-%dT%H:%M:%S%z') ==="; chamber ingest || echo "!! ingest FAILED (exit $?) - verifying against the corpus as it stands, which may be stale"; chamber verify --json > "REPLACE_WITH_VAULT/_chamber/.report.tmp" ; [ -s "REPLACE_WITH_VAULT/_chamber/.report.tmp" ] &amp;&amp; mv "REPLACE_WITH_VAULT/_chamber/.report.tmp" "REPLACE_WITH_VAULT/_chamber/report.json"</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>REPLACE_WITH_HOME/Library/Logs/chamber-verify-obsidian.log</string>
  <key>StandardErrorPath</key><string>REPLACE_WITH_HOME/Library/Logs/chamber-verify-obsidian.log</string>
</dict>
</plist>
```

The one-liner's `&&` is written `&amp;&amp;` above because `<string>` is XML content, where a bare `&` is a syntax error — confirmed with `plutil -lint`, which rejects the unescaped form outright (`Encountered unknown ampersand-escape sequence`). launchd decodes `&amp;&amp;` back to a literal `&&` before handing the line to `/bin/sh`, so the job runs exactly the one-liner from above; only the saved `.plist` file needs the escape. Paste the bare one-liner into a `<string>` unescaped and the plist fails to load, silently as far as the job is concerned — `plutil -lint path/to/the.plist` catches it before `launchctl load` does. cron never hits this: a crontab is not XML, so the plain one-liner is correct there.

Load it with `launchctl load ~/Library/LaunchAgents/com.chamber.verify-obsidian.plist`.

A separate label from `com.chamber.verify` (the daily notification job
already in `deploy/launchd/`) is deliberate — that job's desktop notification
and this job's vault write are different consumers of the same `verify`, and
loading this one must not silently replace that one.

**Linux (cron)**, every 15 minutes:

```cron
*/15 * * * * /bin/sh -lc 'echo "=== chamber $(date -Is) ==="; chamber ingest || echo "!! ingest FAILED (exit $?) - verifying against the corpus as it stands, which may be stale"; chamber verify --json > "$HOME/Vault/_chamber/.report.tmp" ; [ -s "$HOME/Vault/_chamber/.report.tmp" ] && mv "$HOME/Vault/_chamber/.report.tmp" "$HOME/Vault/_chamber/report.json"' >> "$HOME/.local/state/chamber-verify-obsidian.log" 2>&1
```

Create the log directory first (`mkdir -p ~/.local/state`) — a redirect into
a directory that does not exist fails silently, and cron mails the error to a
mailbox nobody reads.

## Mobile

The transport is a file in the vault, so mobile works wherever the vault
syncs. iCloud and Syncthing sync everything by default; nothing extra is
needed.

**Obsidian Sync users need one toggle.** First-party Obsidian Sync ships with
"Sync all other types" turned off, and `report.json` — not a Markdown file —
rides on that toggle exactly like any other non-Markdown file. Without it,
the report is written correctly on your desktop and simply never reaches your
phone; nothing on either end reports an error. Enable it at **Settings →
Sync → Sync all other types**. The plugin's own missing-report state names
this on mobile rather than showing an unexplained empty panel.

## The contract: two consumers now

`verify --json`'s field-by-field shape is documented once, in
[`CI_DRIFT_GATE.md`](CI_DRIFT_GATE.md) — this page does not repeat it; two
descriptions of the same JSON drifting apart from each other would be exactly
the failure this product exists to catch. What this feature changed is how
many things read that shape: the composite GitHub Action (its `report`
output is the same object) and now the Obsidian plugin, parsing a synced copy
off disk. Both are external and neither controls Chamber's release schedule,
so **changes to this shape must stay additive.** `generatedAt` is the
precedent this was built on: added as a new field, documented as absent from
reports written by older Chamber versions, with every consumer required to
treat that absence as "age unknown" rather than an error — never a field
renamed or repurposed under a consumer that isn't watching this repo's
commits.

## Install

Not yet in Obsidian's community plugin registry as of this writing — a
submission is prepared; the [plugin repo](https://github.com/abm9111/chamber-obsidian)
has current status. Until then: [BRAT](https://github.com/TfTHacker/obsidian42-brat)
→ "Add Beta Plugin" → `abm9111/chamber-obsidian` → Add Plugin → enable
**Chamber Drift** under Community plugins.
