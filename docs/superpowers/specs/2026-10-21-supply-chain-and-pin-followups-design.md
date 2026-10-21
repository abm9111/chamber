# Supply chain, CI, pin follow-ups and docs (audit groups B and C)

**Date:** 2026-10-21
**Status:** approved by the owner in chat, 2026-10-21
**Source:**
- the whole-repo VIGIL audit of `main` at ccdf148 (2026-10-21): HIGH-1, HIGH-2, the brace-expansion Medium, the backup Medium, and the Lows on CI, pip, systemd, version sites, MiniLM, bwrap and stale docs
- the deferred minors from PR #9 (`chamber pin`)

**Next step:** an implementation plan, then code. The choices below are closed.

One PR: `feat/supply-chain-docs`. Implementation starts from `main` *after* the runtime-hardening PR (`feat/runtime-hardening`) has merged, because both PRs touch `src/sandbox.ts`, `docs/KNOWN_LIMITATIONS.md`, `CHANGELOG.md` and `tests/harness.ts`. The plan is written against `origin/main` at ccdf148. When implementation starts, check the anchors it names against the new `main`.

## B1. Dependency advisories

Run `npm audit fix`. Only `package-lock.json` may change. The expected result is `proxy-addr` 2.0.8 (through `@slack/bolt` → `express`) and `brace-expansion` 5.0.12 (through `eslint`/`typescript-eslint` → `minimatch`).

If the fix wants a major bump or a `package.json` change, stop and report rather than accept it.

Afterwards, `npm audit` reports 0 vulnerabilities.

## B2. Both images are clean and scanned

- **Root `Dockerfile`.** This is the stdio MCP image for directory checkers. It does the same cleanup `deploy/Dockerfile` already does:
  - `apt-get upgrade`
  - removes npm, npx and corepack from the final image
- **CI scan.** The `image` job in `.github/workflows/ci.yml` builds and trivy-scans both `Dockerfile` and `deploy/Dockerfile`, as a matrix or as two builds. It uses the same pinned `aquasecurity/trivy-action` SHA and the same gate: `HIGH,CRITICAL`, `ignore-unfixed: true`, `exit-code: '1'`.
- **Verification.** Build the root image locally and trivy-scan it: 0 fixable HIGH/CRITICAL. If docker or trivy is unavailable on this Mac, CI is the evidence, and the report must say so.

## B3. CI supply-chain steps

- **`npm audit`.** A new job, or a step in `lint`, runs `npm audit --audit-level=high` after `npm ci`.
- **Secret scan.** A new job runs gitleaks over the full history (`fetch-depth: 0`), using the official action pinned by full SHA with its version as a trailing comment, like every other action in this repo. It honours the existing `.gitleaksignore`.
  - If the action needs a licence for a personal account, use the pinned `gitleaks` release binary with its checksum verified instead.
- **Python dependencies.** The two `pip install ... numpy onnxruntime tokenizers` lines (`ci.yml:39`, `ci.yml:84`) become `python3 -m pip install --require-hashes -r scripts/requirements-embed.txt`.
  - The file pins exact versions with `--hash` lines covering the CI platform: Linux x86_64, the runner's Python.
  - Generate it reproducibly, and record the command at the top of the file.
- **Dependabot.** A new `.github/dependabot.yml` covers `npm`, `github-actions` and `docker` (directories `/` and `/deploy`), weekly.

## B4. MiniLM weights are checked before loading

`scripts/embed_minilm.py` `_load()` computes the SHA-256 of `model_quantized.onnx` (streamed) and compares it with the `SHA-256:` line in `models/minilm/VERSION`.

- **Mismatch.** A mismatch, a missing `VERSION`, or a missing `SHA-256:` line exits with code 3 and one stderr line naming both hashes or the missing item. The model is not loaded. The TypeScript side treats it like any other embedder failure: `embedLocal` degrades, and the batch path throws. This is unchanged behaviour, and the tests assert it.
- **Every entry point.** The check also covers `--serve` and the plain one-shot mode, before the first reply.
- **Test seam.** The model directory may be overridden by `CHAMBER_MINILM_DIR` for tests only. The default stays `models/minilm` next to the script.
- **Test.** A temp copy of `VERSION` with one hex digit changed makes the script exit 3. The real directory passes. The test needs no onnxruntime when the hash fails first.

## B5. Version sites agree

- `server.json` top-level `version` becomes `0.1.9`, matching `package.json` and `server.json` `packages[0].version`.
- `src/mcp_server.ts` `SERVER_VERSION` reads `package.json` the way `cli.ts --version` does, instead of hard-coding it. It must still resolve from both `src/` and `dist/`.
- A new harness test asserts that these all agree:
  - `package.json` version
  - both `server.json` fields
  - `SERVER_VERSION`
  - the first CHANGELOG heading that is not `Unreleased`

## B6. `chamber-jobs.service` hardening

- **Add the directives `chamber.service` has.** `deploy/systemd/chamber-jobs.service` gets the hardening directives from `chamber.service:30-41` that it lacks: `NoNewPrivileges=true`, `CapabilityBoundingSet=`, `AmbientCapabilities=`, `LockPersonality=true`, `RestrictRealtime=true`, `SystemCallFilter=@system-service`, `SystemCallErrorNumber=EPERM`.
- **Check the sandbox first.** Before adding `SystemCallFilter`, check whether `chamber jobs run` can reach `runInSandbox` or bwrap. If it can, leave `SystemCallFilter` out of this unit and add a comment saying why.
- **Verify.** Run `systemd-analyze verify` on Linux in docker if available; otherwise state that it was not run.

## B7. bwrap namespaces

- **New flags.** `src/sandbox.ts` `runBwrap` adds `--unshare-pid`, `--unshare-ipc`, `--unshare-uts` and `--new-session` to the bwrap argv. Mount-op ordering stays as it is, with `--proc /proc` after the pid unshare taking effect.
- **New probe check.** `probes/sandbox_confines.ts` gains a needle: a host process the payload must not see.
  - For example, the probe's own pid, or a sleeping child it starts: present in `/proc/<pid>` unconfined, absent confined.
  - The needle must be visible unconfined and hidden confined. This follows CLAUDE.md's rule on needles.
- **Verification on Linux.** Use the CLAUDE.md docker recipe (`--privileged`, bwrap installed) and record its output:
  - the probe passes with the new flags
  - the new needle fails with the old flags, which proves the probe can go red
- **If docker is unavailable on this Mac.** The CI `probes` job (`npm run probes:isolation` on a bwrap runner) is the evidence, and the report must say the local Linux check was not run.

## C1. Pin hardening (`src/release_pin.ts`)

- **Atomic plist write.** Write to `<plist>.tmp-<pid>` in the same directory with the original file's mode, then `renameSync` over the plist. On failure, remove the temp file.
- **git environment.** Every git spawn gets an env copied from `process.env` with:
  - `GIT_TERMINAL_PROMPT=0`
  - `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` and `GIT_COMMON_DIR` deleted
- **Timeouts.** `git fetch` has a 120 s spawn timeout. Other git calls get 30 s. A timeout is reported as a refusal naming the command.
- **`git remote add`.** It passes `--` before the remote name and URL.
- **Credentials in the origin URL.** For `http:`/`https:` origins, a URL with any userinfo (username or password) is refused before anything is created. The message is `the origin URL carries credentials; use a credential helper instead`. The URL itself never appears in any message; any URL printed elsewhere has its userinfo redacted. scp-like `user@host:path` and `ssh://user@host/...` are allowed.
- **Lookup errors.** An `lstat` error other than ENOENT on the release directory becomes a refusal, not a throw.

## C2. Pin proves the release runs before rewriting the job

After the checkout is on the tag, and before the plist is read for writing, pin runs `/bin/sh -lc 'node "$1" --version' sh <releaseDir>/bin/chamber.js`. This is the same login shell and `node` the job will use, with a 60 s timeout.

- **Pass.** The last non-empty line of stdout must equal the `version` in `<releaseDir>/package.json`, and the exit code must be 0. (A login profile may print before the command does.)
- **Fail.** On any failure, pin exits 1 with `the release at <tag> did not run: <reason>`. The plist and the loaded job are left untouched. The job's command is the release checkout's `bin/chamber.js`, so a checkout left on the failed tag would move a job that is already in the pinned form onto the release just proven not to run. Pin therefore puts an existing checkout back on the commit (and branch) it held, reads that back from git, and says which of three things happened: put back, could not be put back (with the `git checkout` that does it), or nothing to put back. A checkout this pin created has no earlier release and stays on the tag; a job still in its bare form does not use it. (An earlier version of this text said the job was untouched and the checkout stays on the tag in every case, which holds only for a job not yet pinned.)
- **Runs every time.** This happens even when there is no plist installed, so `chamber pin` alone proves the release runs.
- **Test fixture.** The fixture's tag trees gain a `package.json` and a `bin/chamber.js` that prints that version. Add tests for a release whose bin exits non-zero, and for one that prints the wrong version: each refuses, and the plist is unchanged.

## C3. Job plist parsing and messages

- **Strip comments first.** `readJobPlist` removes XML comments (`<!-- … -->`) before counting and matching. A `ProgramArguments` block inside a comment is ignored, and a real one is still required exactly once.
- **Refuse `<key>Program</key>`.** A plist containing `<key>Program</key>` outside comments is refused. That key overrides `ProgramArguments[0]`.
- **Missing hint.** The "launchctl load exited 0 but com.chamber.verify is not loaded" message gets the same `load it with: launchctl load <plist>` hint as the other failure branches. It also says the 08:30 job will not run.
- **Tests:** a commented-out block plus a real one is accepted, a commented-out block alone is refused, and a `Program` key is refused.

## C4. Daily snapshot

- **`rc` bug.** `scripts/daily-snapshot.sh` captures `rc=$?` straight after `chamber verify` and prints `verify exit code: $rc`.
- **Stale labels.** The stale `known-failing` labels at about lines 121-122 are removed.
- **Release command.** Its `chamber` calls (`verify`, `corpus`) use `node "$HOME/.local/share/chamber-release/bin/chamber.js"`. If that file is missing, the report says `release checkout missing: run chamber pin <tag>` instead of calling the dev `chamber`.
- **Gates section.** It keeps reporting on the dev checkout (`REPO`).
- **Plist template.** `deploy/launchd/com.chamber.daily-snapshot.plist` runs `$HOME/.local/share/chamber-release/scripts/daily-snapshot.sh` instead of the dev checkout's copy.
- **Effective date.** `deploy/SCHEDULING.md` notes that this takes effect for a release tag that contains this script, because v0.1.9's copy has the old behaviour.
- **Shellcheck.** Clean on the script.

## C5. Docs

- **`docs/BACKUP.md` (new).** It covers:
  - A live backup with `sqlite3 <db> ".backup '<dest>'"` or `VACUUM INTO '<dest>'`, and why a plain `cp` of a WAL database can miss committed data.
  - Where the database is (`chamber config show`).
  - Restore: stop the jobs, replace the file, remove stale `-wal`/`-shm`, and run `chamber verify`.
  - After restore, run `chamber checkpoint verify <receipt>`, since a restored older database is exactly what rollback detection reports.
  - Keep backups `0600`.
- **`deploy/PILOT.md:21`.** Its `cp` step points to `docs/BACKUP.md`.
- **`docs/KNOWN_LIMITATIONS.md`:**
  - Entry 1 is rewritten against the current `src/sandbox.ts`: the bwrap backend and its probe, what `CHAMBER_SANDBOX_REQUIRED` does after the runtime-hardening PR, no `runDocker`, and macOS has no isolation.
  - Entry 3's correction about the daily-snapshot plist "running the export" is fixed.
  - README's count of limitations matches the file.
- **Stale sandbox claims** are fixed to match entry 1: `README.md:350-355` and `benchmarks/BENCHMARK.md:82`.
- **`deploy/SCHEDULING.md`:**
  - The sample outputs match what `chamber verify` prints now, including `, N with some support lost`, the `database` line and `=== verify exit N ===`.
  - Add a note: run `chamber pin` from a desktop Terminal, not over SSH, because legacy `launchctl` works in the GUI session's domain.
  - Add a note that `unload` stops a running 08:30 job. Pin when it is not running.

## Out of scope

The other PR carries the runtime fixes (model timeout, Host check, body cap, 500 shape, `/approve` actor, OAuth URL parsing, DB permissions, curl secrets, `/turn` worker) and the behaviour changes (sandbox default, talk allowlists).

## Verification

- Every code fix comes with a test or probe that fails when the fix is removed, proved once.
- Run the full gate: `npm run typecheck`, `npm run lint`, `npm test`, `npm run probes`.
- B2, B6 and B7 need Linux or docker evidence. Where it could not be produced locally, say so plainly and rely on CI.
