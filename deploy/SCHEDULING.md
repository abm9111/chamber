# Scheduling `chamber verify`

`chamber verify` re-checks every stored citation pin against the corpus as it
is now. It exits non-zero exactly when a belief has no verified support left,
which makes it usable as an unattended check.

It never mutates a belief or the corpus. It only reports.

## Prerequisite

The scheduled job calls `chamber`, not `node …/src/cli.ts`. Install the command
first:

```bash
npm link          # from the repository root
which chamber     # should print a path on your PATH
```

The job runs `/bin/sh -lc`, a *login* shell, and that `-l` is load-bearing.
launchd itself hands a job a minimal `PATH` — on a stock macOS install,
`/usr/bin:/bin:/usr/sbin:/sbin`, which contains neither `/opt/homebrew/bin` nor
`/usr/local/bin`, so it cannot see what `npm link` installed. The login shell
sources your profile and recovers the real `PATH`.

The consequence is that this job inherits your shell profile. If `which
chamber` prints a directory that your `.zprofile` / `.bash_profile` does not
put on `PATH` (because your interactive `.zshrc` adds it instead), the job logs
`chamber: command not found` and nothing else. Check the log after the first
run rather than assuming.

## macOS (launchd)

1. Copy the plist and substitute your home directory:

   ```bash
   mkdir -p ~/Library/LaunchAgents
   sed "s|REPLACE_WITH_HOME|$HOME|g" \
     deploy/launchd/com.chamber.verify.plist \
     > ~/Library/LaunchAgents/com.chamber.verify.plist
   ```

2. Load it:

   ```bash
   launchctl load ~/Library/LaunchAgents/com.chamber.verify.plist
   ```

3. Watch it:

   ```bash
   tail -f ~/Library/Logs/chamber-verify.log
   ```

To run it once immediately rather than waiting for the schedule:

```bash
launchctl start com.chamber.verify
```

To remove it:

```bash
launchctl unload ~/Library/LaunchAgents/com.chamber.verify.plist
```

## Linux (cron)

```cron
30 8 * * * /bin/sh -lc 'echo "=== chamber $(date -Is) ==="; chamber ingest || echo "!! ingest FAILED (exit $?) - verifying against the corpus as it stands, which may be stale"; chamber verify' >> "$HOME/.local/state/chamber-verify.log" 2>&1
```

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
contract: non-zero iff a belief has no verified support left. Folding ingest's
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
ingested 412 file(s) as 3907 passage(s) from /Users/you/Vault

0 belief(s) checked, 0 with no verified support left
```

When a note behind a conclusion has changed:

```
blf_c8a38d3d16b7f617  0/1 pins verified
  "Client records are kept for 90 days after the engagement ends."
  hash_mismatch: vdoc_b60e21480430b775 — committed against retention.md#p0, which now holds: retention › Retention
    the cited passage is not what is stored there any more — it may have been edited, or shifted to another passage of the same note. Open the note and re-check; re-ingesting will not restore the pin.

1 belief(s) checked, 1 with no verified support left
```

That is the signal worth scheduling for: a conclusion you recorded months ago,
resting on a note you have since edited, surfaced without you remembering it
existed.

If you have not configured any ingest roots yet, the first run reports exactly
this and still verifies:

```
=== chamber 2026-08-03T08:30:00+0400 ===
ingest: no path given and no roots configured
  add roots to the config file, or pass a path
  run `chamber config show` to find the config file
!! ingest FAILED (exit 1) - verifying against the corpus as it stands, which may be stale

0 belief(s) checked, 0 with no verified support left
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
