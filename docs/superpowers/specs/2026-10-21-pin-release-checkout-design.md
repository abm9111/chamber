# Pin the 08:30 job to a release checkout

**Date:** 2026-10-21
**Status:** approved
**Next step:** implementation plan, then code. Do not reopen the choices below.

## Goal

The 08:30 job runs a second git checkout pinned to a release tag. It does not run whatever branch is checked out in the development repo. `npm link` into the development repo stays the `chamber` on `PATH`.

## The checkout

`chamber pin <tag>` fetches that tag from the `origin` of the checkout that is running the command. It keeps a detached checkout at `~/.local/share/chamber-release`. The first run clones that directory. A later run moves the existing checkout to the named tag.

The checkout is not `~/.local/share/chamber`. That directory is Chamber's data directory: the default database is `~/.local/share/chamber/chamber.sqlite`. On this machine it already holds the database, so a checkout there would be refused as "not a git checkout" on every run, and on a new machine the database would end up inside the checkout. Changed with the owner on 2026-10-21 while the plan was being written.

A release checkout that contains `dist/` stops pin before `HEAD` moves. `dist/` is gitignored, so no tag provides it, and `bin/chamber.js` runs `dist/cli.js` instead of the tag's `src/` whenever it exists.

The 08:30 job never fetches and never checks anything out.

The job runs `~/.local/share/chamber-release/bin/chamber.js`. Inside the shell script each of the three commands is `node "$HOME/.local/share/chamber-release/bin/chamber.js"`, so the template in the repo does not contain this machine's home directory. The job calls `node` because `bin/chamber.js` is mode `100644` in every tag: a fresh checkout writes it without the executable bit, and running it directly fails with "Permission denied" (exit 126). Changed with the owner on 2026-10-21. A checkout with no `dist/` runs `src/cli.ts` through `bin/chamber.js`, which needs Node 23.6 or newer on the login shell's `PATH`. The shebang stays `#!/usr/bin/env node`.

## The installed job

The loaded agent is `~/Library/LaunchAgents/com.chamber.verify.plist`. Its script calls bare `chamber` for `config show`, `ingest`, and `verify`. `chamber pin` rewrites those three commands to the release bin and reloads the agent with `launchctl unload` and `launchctl load`, the pair `deploy/SCHEDULING.md` already documents.

The log banner, the failure line, and the notification text stay as they are. `CHAMBER_PYTHON` stays as it is. Pin does not run `npm link`.

The template `deploy/launchd/com.chamber.verify.plist` gets the same three-command replacement. The cron example in `deploy/SCHEDULING.md` gets the same path. Pin does not edit a crontab. Pin does not touch the systemd units. Those start the server, not this job.

A tag that is already checked out is a success, and the plist is still checked.

## What pin refuses

Pin stops before it moves the checkout or the job when any of these are true.

The argument is one tag name. An empty name, a name that starts with `-`, or a name that contains a space or a newline stops pin. After `git fetch`, that name is `refs/tags/<name>` on `origin`. A branch name or a raw commit stops pin.

The command is running from a checkout that has an `origin`. A published install with no `.git` stops pin. `~/.local/share/chamber-release` is left alone when it is not a git checkout, and when its `origin` URL is not the same as the checkout running the command.

A tracked change in the release checkout stops pin. Pin does not reset or clean that directory. When an untracked file would be overwritten, git's own refusal stands and the plist is not written.

The tag's tree contains `bin/chamber.js` before `HEAD` moves. A tag that does not is left unpinned.

When `~/Library/LaunchAgents/com.chamber.verify.plist` exists, its script contains the three commands as bare `chamber`, or already as `node "$HOME/.local/share/chamber-release/bin/chamber.js"`. Any other script stops pin before `HEAD` moves. When that file is absent, the checkout is still pinned, pin prints that no LaunchAgent was installed, and it exits 0.

`git fetch` or `git checkout` failing stops pin with git's message. A directory this run cloned, and then failed to pin, is removed. An older checkout is left where it was.

The plist is written only after the checkout is on the tag and `bin/chamber.js` is on disk. An agent that was not loaded is loaded. A reload that fails exits non-zero. The checkout and the plist file stay as written.

## Tests

Tests call the pin function with a temporary origin, a temporary release directory, and a temporary plist. They do not read the real home directory and they do not reload the real agent.

- A real tag is cloned, detached, and the three commands in the plist become the release bin.
- A second pin moves that checkout to another tag.
- Pinning the tag that is already checked out succeeds and still checks the plist.
- A missing tag, a branch name, and a raw commit stop pin.
- A dirty tracked tree stops pin.
- A plist whose script is not the shipped one stops pin before `HEAD` moves.
- A missing plist still pins the checkout, prints that no LaunchAgent was installed, and exits 0.
- A tag whose tree has no `bin/chamber.js` is left unpinned.
- A release checkout with `dist/` stops pin before `HEAD` moves.
- A directory created by this run and then failed is removed. An older checkout is left in place.

## Out of scope

- The 08:30 job fetching or checking out a tag.
- Changing what `npm link` points at.
- Editing a crontab or a systemd unit.
- Shipping `models/minilm` in the npm package.
- Building `dist/` in the release checkout.
- Rewriting `CHAMBER_PYTHON`.
