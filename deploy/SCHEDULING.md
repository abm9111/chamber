# Scheduling `chamber verify`

`chamber verify` re-checks every stored citation pin against the corpus as it
is now. It exits non-zero exactly when a stored pin no longer verifies, either
because a belief has no verified support left or because it has lost some of it,
which makes it usable as an unattended check.

It never mutates a belief or the corpus. It only reports.

## Prerequisite

The scheduled job does not call the `chamber` on your `PATH`. `npm link` points
that command at your development checkout, so a job that called it would run
whatever branch you had checked out at 08:30. The job runs a second checkout,
pinned to a release tag:

```bash
chamber pin v0.1.9    # from a clone of this repository
```

`chamber pin <tag>` fetches the tag from your clone's `origin` and keeps
`~/.local/share/chamber-release` detached at it. The first run clones that
directory, and a later run moves it to the tag you name. The job itself never
fetches and never checks anything out, so it runs the same release every
morning until you pin another one. The release checkout sits beside
`~/.local/share/chamber`, the data directory, not inside it.

If `~/Library/LaunchAgents/com.chamber.verify.plist` is installed, pin also
checks its script, points its `config show`, `ingest` and `verify` commands at
the release checkout, and loads or reloads it. Pin refuses before it moves anything in
these cases:

- the installed script is not the one Chamber ships, or the plist has a
  `Program` key, which launchd runs instead of the script
- your clone's `origin` is an http(s) URL with a username or password in it
- the release checkout has tracked changes or a `dist/` folder
- the tag has no `bin/chamber.js`

After the checkout moves, and before it touches the plist, pin runs the release
once: `node bin/chamber.js --version` under `/bin/sh -lc`, the shell and `node`
the job uses. It must exit 0 and print the version in the release's
`package.json`. If it does not, pin exits 1, puts the checkout back on the commit
it held before and prints that commit, and leaves the plist and the loaded job
alone, so a job that was already pinned keeps running the release it ran
yesterday. If pin cannot put the checkout back, it says so and prints the
`git checkout` that does; until then the job runs the release that failed. A
first pin has no earlier release to go back to: its checkout stays on the tag
that failed, and a job still in its original form does not use that checkout.

The job runs each command as
`node "$HOME/.local/share/chamber-release/bin/chamber.js"`. It names `node`
because `bin/chamber.js` is not executable in git. The release checkout has no
`dist/`, so `bin/chamber.js` runs the TypeScript directly and needs Node 23.6
or newer.

The job runs `/bin/sh -lc`, a *login* shell, and that `-l` is load-bearing.
launchd itself hands a job a minimal `PATH`. On a stock macOS install that is
`/usr/bin:/bin:/usr/sbin:/sbin`, which contains neither `/opt/homebrew/bin` nor
`/usr/local/bin`, so the job cannot find `node`. The login shell sources your
profile and recovers the real `PATH`.

The consequence is that this job inherits your shell profile. Your interactive
`.zshrc` may put `node`'s directory on `PATH` while your `.zprofile` /
`.bash_profile` does not. Then the job logs `node: command not found` and
nothing else. Check the log after the first run rather than assuming.

Run `chamber pin` from a Terminal window on the machine's desktop, not over
SSH. The legacy `launchctl list`, `load` and `unload` that pin uses act on the
domain of the session they are run from, and the job lives in the domain of
your GUI login session. From an SSH session they can fail, or change a different
domain than the one the 08:30 job runs in.

`unload` stops the job if it is running at that moment, and on a large corpus
the 08:30 job runs for a long time (a first MiniLM ingest of about 28,500
passages took over an hour). Pin when it is not running: look at the end of
`~/Library/Logs/chamber-verify.log` first and pin only after today's
`=== verify exit N ===` line is there.

## macOS (launchd)

1. Pin a release (see the prerequisite above):

   ```bash
   chamber pin v0.1.9
   ```

   With no job installed yet, pin clones the checkout and prints that no
   LaunchAgent was installed.

2. Copy the plist and substitute your home directory:

   ```bash
   mkdir -p ~/Library/LaunchAgents
   sed "s|REPLACE_WITH_HOME|$HOME|g" \
     deploy/launchd/com.chamber.verify.plist \
     > ~/Library/LaunchAgents/com.chamber.verify.plist
   ```

   The template already runs
   `node "$HOME/.local/share/chamber-release/bin/chamber.js"`. The job's shell
   expands that `$HOME`, not `sed`.

3. Load it:

   ```bash
   launchctl load ~/Library/LaunchAgents/com.chamber.verify.plist
   ```

4. Watch it:

   ```bash
   tail -f ~/Library/Logs/chamber-verify.log
   ```

To move the job to a newer release, pin that tag. Pin reloads the agent itself:

```bash
chamber pin <tag>
```

To run it once immediately rather than waiting for the schedule:

```bash
launchctl start com.chamber.verify
```

To remove it:

```bash
launchctl unload ~/Library/LaunchAgents/com.chamber.verify.plist
```

## Daily snapshot (macOS)

`scripts/daily-snapshot.sh` writes one dated Markdown report a day to
`~/Library/Logs/chamber-daily/`: the drift result, the corpus, the ledger
counts, the gates and the repository state. It records and does not judge, so it
exits 0 even when a check inside it fails; `chamber verify` is the gate.

The template runs the copy of the script inside the release checkout, so the
report describes the release the 08:30 job ran. Its Drift and Corpus sections run
that checkout's `bin/chamber.js`. Its Ledger section opens the live database
with that checkout's `src/db.ts`, the code the 08:30 job opens it with. Opening a
database applies the opening code's schema to the file, so the Ledger never does
it with a development branch. If the checkout is missing, the report says
`release checkout missing: run chamber pin <tag>` in all three sections and does
not fall back to the `chamber` on your `PATH` or to the development checkout.
The Gates and Repository sections describe your development checkout
(`CHAMBER_REPO`, default `~/Projects/chamber`).

The Drift section opens with a `release: <tag>` line, which names the release the
report ran. It is read with `git describe --tags --always` in the release
checkout, so a checkout that `chamber pin` has moved to another tag shows the new
tag from that day on. The line reads `none` when the release checkout is missing
and `unknown` when it is there but is not a git checkout (or git cannot name it).

```bash
chamber pin <tag>      # a tag that contains the script, see below
sed "s|REPLACE_WITH_HOME|$HOME|g" \
  deploy/launchd/com.chamber.daily-snapshot.plist \
  > ~/Library/LaunchAgents/com.chamber.daily-snapshot.plist
launchctl load ~/Library/LaunchAgents/com.chamber.daily-snapshot.plist
```

**This takes effect for a release tag that contains this script.** v0.1.9's copy
of `scripts/daily-snapshot.sh` has the old behaviour: it calls the `chamber` on
`PATH` and prints `verify exit code: 0` whatever `verify` returned. Pin a newer
tag before loading this plist, or the job runs the old script from the release
checkout.

## Linux (cron)

```cron
30 8 * * * /bin/sh -lc 'echo "=== chamber $(date -Is) ==="; node "$HOME/.local/share/chamber-release/bin/chamber.js" ingest || echo "!! ingest FAILED (exit $?) - verifying against the corpus as it stands, which may be stale"; node "$HOME/.local/share/chamber-release/bin/chamber.js" verify' >> "$HOME/.local/state/chamber-verify.log" 2>&1
```

Run `chamber pin <tag>` first. Pin does not edit your crontab, so a line
written before pin existed keeps calling the `chamber` on `PATH` until you
replace it.

Two things that will bite you if you change that line:

- **Create the log directory first** (`mkdir -p ~/.local/state`). If the
  redirect target's directory does not exist, the redirect fails, the job
  produces nothing, and cron mails the error to a mailbox nobody reads.
- **Do not put a `%` in a crontab command.** cron translates an unescaped `%`
  into a newline, which truncates the command. That is why the line above uses
  `date -Is` rather than the `date '+%Y-…'` format the macOS plist uses — the
  plist is not a crontab and has no such restriction. If you do need a `%`,
  escape it as `\%`.

## Why the job does not use `ingest && verify`

The obvious form is `chamber ingest && chamber verify`. Do not use it.

`chamber ingest` exits non-zero for reasons that have nothing to do with
drift — no ingest roots configured yet, or a configured root that has moved or
sits on an unmounted volume (it ingests the remaining roots and still exits
non-zero). Under `&&`, any of those skips `chamber verify` entirely. The
scheduled check silently stops checking, and the only trace is a log line that
reads like an ordinary ingest complaint.

That is the worst available failure mode. A drift check that quietly stops
running looks exactly like a drift check that keeps finding nothing wrong.

So the job runs `verify` unconditionally and announces an ingest failure on its
own line:

```sh
chamber ingest || echo "!! ingest FAILED (exit $?) - verifying against the corpus as it stands, which may be stale"; chamber verify
```

The job's exit status is therefore `verify`'s alone, which preserves verify's
contract: non-zero iff a stored pin no longer verifies. Folding ingest's
status in would make exit 1 mean either "your evidence moved" or "a disk wasn't
mounted" — two findings that call for entirely different responses, collapsed
into one indistinguishable number. The distinction is kept in the log text,
where it can actually be read.

The job still re-ingests *first*, so drift is detected against the current state
of the notes rather than a stale corpus. Without that, `verify` would only ever
confirm what the last manual ingest saw.

## What you will see

Each run is prefixed with a timestamp, because launchd appends to this log
indefinitely and otherwise today's run and last month's run are the same
undifferentiated text.

On a healthy corpus:

```
=== chamber 2026-08-03T08:30:00+0400 ===
  database = /Users/you/.local/share/chamber/chamber.sqlite   [from default]
ingested 412 file(s) as 3907 passage(s) from /Users/you/Vault

0 belief(s) checked, 0 with no verified support left, 0 with some support lost
=== verify exit 0 ===
```

The `database` line says which file was checked. The last line is the job's
exit status, which is `verify`'s.

When a note behind a conclusion has changed:

```
=== chamber 2026-08-03T08:30:00+0400 ===
  database = /Users/you/.local/share/chamber/chamber.sqlite   [from default]
ingested 412 file(s) as 3907 passage(s) from /Users/you/Vault
blf_c8a38d3d16b7f617  0/1 pins verified
  "Client records are kept for 90 days after the engagement ends."
  hash_mismatch: vdoc_b60e21480430b775 — committed against retention.md#p0, which now holds: retention › Retention
    the cited passage is not what is stored there any more — it may have been edited, or shifted to another passage of the same note. Open the note and re-check; re-ingesting will not restore the pin.

1 belief(s) checked, 1 with no verified support left, 0 with some support lost
=== verify exit 1 ===
```

A belief that lost only some of its pins is counted in the last number instead
(`0 with no verified support left, 1 with some support lost`). It exits 1 too:
losing part of the evidence is drift.

That is the signal worth scheduling for: a conclusion you recorded months ago,
resting on a note you have since edited, surfaced without you remembering it
existed.

If you have not configured any ingest roots yet, the first run reports exactly
this and still verifies:

```
=== chamber 2026-08-03T08:30:00+0400 ===
  database = /Users/you/.local/share/chamber/chamber.sqlite   [from default]
ingest: no path given and no roots configured
  add roots to the config file, or pass a path
  run `chamber config show` to find the config file
!! ingest FAILED (exit 1) - verifying against the corpus as it stands, which may be stale

0 belief(s) checked, 0 with no verified support left, 0 with some support lost
=== verify exit 0 ===
```

Run `chamber init` and add roots under `ingest` to fix it.

## Make a real finding visible

A scheduled check is only worth having if someone notices when it fires. The
exit code goes to launchd, which does nothing with it, and the report goes to a
log file that — by construction — you only open when you already suspect
something. Left as-is, the job's most valuable output is the output you are
least likely to read.

`verify`'s exit code is the hook. It is non-zero *only* on a real finding, so
anything you attach to the failure branch fires rarely and means something when
it does. On macOS, with nothing to install:

```sh
chamber verify || { osascript -e 'display notification "A belief has lost its supporting evidence. See ~/Library/Logs/chamber-verify.log" with title "chamber verify"'; exit 1; }
```

The trailing `exit 1` matters: without it the shell reports the notifier's exit
status, and the job silently reports success on every drift it just told you
about.

Substitute whatever you actually read — a `mail` invocation, a webhook `curl`,
a line appended to a file your terminal prompt checks. The mechanism does not
matter. Attaching *something* to the failure branch does, and it is the
difference between a job that runs and a job that works.

## Expect a burst on the first run

The first scheduled run against an existing corpus may report drift on
everything at once, because a corpus ingested before the current pin formula
recomputes differently. That is correct, not a fault. Re-ingest once and the
baseline settles.
