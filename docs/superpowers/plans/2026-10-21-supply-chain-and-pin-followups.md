# Supply Chain, CI, Pin Follow-ups and Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close audit groups B (supply chain, CI, runtime packaging) and C (the `chamber pin` follow-ups, the daily snapshot, and the stale docs) in one PR on `feat/supply-chain-docs`.

**Architecture:** Nine tasks, done in order (6 before 7, and 5 and 8 before 9; the rest do not depend on each other), each ending in a commit. The pin tasks change `src/release_pin.ts` and the `release` suite in `tests/harness.ts`. The CI, image, systemd, MiniLM and version tasks add tests to the `config` suite that read the repository's own config files, so each fix is guarded by a test that goes red when the fix is removed. The bwrap task changes `probes/sandbox_confines.ts`, which can only be exercised on Linux, so it carries a docker recipe with a mutation run.

**Tech Stack:** TypeScript run directly by Node >= 23.6 (type stripping, no build step), the repo's own test harness (`tests/harness.ts`), GitHub Actions YAML, Dockerfiles, a Python 3 embedder script, POSIX shell, systemd units, launchd plists, Markdown.

**Spec:** `docs/superpowers/specs/2026-10-21-supply-chain-and-pin-followups-design.md` (binding; its choices are closed). Read it, and read `CLAUDE.md` in the repository root, before starting. Section letters in this plan (B1 to B7, C1 to C5) are the spec's.

## Global Constraints

Every task's requirements include everything in this section. Each task is implemented by an agent that sees only its own task text plus this section.

**Step 0, before any task: rebase and re-check the anchors.** This PR is implemented after a separate runtime-hardening PR merges. That PR touches `src/sandbox.ts` (`sandboxRequired` default), `docs/KNOWN_LIMITATIONS.md` entry 4, `CHANGELOG.md` (Unreleased) and `tests/harness.ts`. This plan was written against `origin/main` at `ccdf148`.

```bash
cd <repo>/.worktrees/supply-chain
git status --short                 # must print nothing
git fetch origin
git rebase origin/main
git log --oneline -5
```

Then check, in this order, and stop and report (quote the output verbatim) if any check fails:

```bash
# 1. Files this plan writes WHOLE must not have changed on main since ccdf148.
#    Empty output means safe. Any output means the plan is stale for that file: stop.
git diff ccdf148 origin/main --stat -- Dockerfile .github/workflows/ci.yml scripts/embed_minilm.py \
  deploy/systemd/chamber-jobs.service probes/sandbox_confines.ts src/release_pin.ts \
  scripts/daily-snapshot.sh deploy/launchd/com.chamber.daily-snapshot.plist server.json

# 2. Text anchors the edits use. Each must print exactly 1.
grep -c -F '    "--unshare-net",' src/sandbox.ts
grep -c -F '"--die-with-parent",' src/sandbox.ts
grep -c -F 'const SERVER_VERSION = "0.1.9";' src/mcp_server.ts
grep -c -F 'import { formatErrorChain } from "./error_chain.ts";' src/mcp_server.ts
grep -c -F '// ─── cli process smoke tests' tests/harness.ts
grep -c -F 'interface ReleaseFixture {' tests/harness.ts
grep -c -F 'function pinOpts(fx: ReleaseFixture' tests/harness.ts
grep -c -F '## 0.1.9 — 2026-10-03' CHANGELOG.md
grep -c -F '## 1. The sandbox does not isolate' docs/KNOWN_LIMITATIONS.md
grep -c -F '## 2. A citation can be genuine and still be wrong' docs/KNOWN_LIMITATIONS.md
grep -c -F '## 3. Checkpoints are manual, unsigned, and land in `/tmp`' docs/KNOWN_LIMITATIONS.md
grep -c -F 'than skimmed: the sandbox does not isolate' docs/KNOWN_LIMITATIONS.md
grep -c -F 'Eighteen limitations are documented there' README.md
grep -c -F '| T1 (Chamber) | 2 | 1 | The sandbox does not isolate.' benchmarks/BENCHMARK.md
grep -c -F 'SQLite path backed up (`cp chamber.sqlite chamber.sqlite.bak`)' deploy/PILOT.md
```

If the runtime-hardening PR changed `sandboxRequired()` in `src/sandbox.ts`, Task 5 does not care (it edits the argv list, not that function), and Task 9 picks the right text for `KNOWN_LIMITATIONS.md` entry 1 by running a command. Do not edit `sandboxRequired`, entry 4, or anything else that PR owns.

**Working directory.** Work only in `<repo>/.worktrees/supply-chain` (a git worktree on `feat/supply-chain-docs`). Never `cd` to `<repo>`. Put scratch files (helper scripts, downloads) in a directory made with `mktemp -d`, outside the worktree, and delete it at the end of the task. Never commit a scratch file.

**Node.** `package.json` `engines` is `node >= 23.6`; run `node --version` first and stop if it is older. The worktree has no `node_modules`: run `npm ci` once before the first gate.

**The four gates, before and after.** Before the first change, and again at the end of every task, run all four from the worktree root and read each tool's own final line:

```bash
npm run typecheck
npm run lint
npm test            # about 2.5 minutes; its last line reads "N/N passed · 0 failed"
npm run probes      # its own exit status is the gate
```

Record the baseline once (test count, and the exit status of `npm run probes`). At `ccdf148`, on the plan author's Mac, `npm test` passed 535/535, and `npm run probes` exited 1 before any change because `probes/backtest_orphan_sweep.ts` printed `>>> BROKEN` (an existing macOS-only failure unrelated to this PR). Take your own baseline after the rebase and require that the set of failing probes after each task is exactly the baseline set. With all nine tasks applied to `ccdf148`, the plan author's run was `npm test` 560/560 (the 535 plus 25 new tests: 1 in Task 1, 1 in Task 2, 4 in Task 3, 1 in Task 4, 8 in Task 6, 6 in Task 7, 3 in Task 8, 1 in Task 9), `npm run typecheck` and `npm run lint` clean, and `npm run probes` failing only on the same `backtest_orphan_sweep.ts`. `npm test` is necessary and never sufficient: the probes, the Linux docker runs, and the mutation steps are the evidence that a fix works.

**Never read `tests/harness.ts` whole, and never `cat` it.** It is about 17,000 lines and contains a fixture that a secret scanner rejects. Use `grep -n` to find a line and a bounded `Read` (with `offset` and `limit`, 40 lines at most) to look at it. All edits to it in this plan are `Edit` calls whose `old_string` is a short unique anchor; if an `Edit` reports the anchor is missing or not unique, stop and report it.

**The harness runs only tests declared before its drain loop.** Every new harness test goes immediately before the line containing `// ─── cli process smoke tests` (use `Edit` with `old_string` = `// ─── cli process smoke tests` and `new_string` = the new block followed by that same text). Never append to the end of the file: a test declared after the loop is never run, and the suite still prints `N/N passed` (`probes/harness_declaration_guards.ts` exists because of that). New tests use suite `release` (pin tests) or `config` (everything else). The harness maps an unknown `--suite=` to `all`, so these two names are the only ones that give a quick run: `node --experimental-strip-types tests/harness.ts --suite=release` and `... --suite=config`. Use the existing `release` suite for pin tests; do not invent a suite.

**Mutation proofs.** Every task with code or config has a mutation step. The pattern is: commit the fix, break exactly the thing it watches, run the named command, confirm it fails in the named way, restore with `git checkout -- <file>`, and confirm with `git diff --stat` that nothing is left. A test that cannot go red is not a gate. If a mutation does not turn the named test red, stop and report; do not weaken the test to make it fail and do not skip the step.

**Isolation can only be verified on Linux.** Task 5 (bwrap) needs Linux, and Tasks 2 (pip hashes) and 4 (`systemd-analyze`) use a Linux container for part of their evidence; the recipe is in each task. `docker` exists on the plan author's Mac. If `docker` is not available to you, or a docker command fails for a reason other than the code under test, write `NOT RUN` for that step in your report together with the verbatim error, and never describe it as passed.

**Commits.** One commit per task, format `type: description` (`fix:`, `feat:`, `ci:`, `docs:`, `test:`, `chore:`), ending with this trailer on its own line after a blank line:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Name every file in `git add`; never `git add <directory>`, `git add -A` or `git add .`. Run `git status --short` before committing and confirm it lists only the files the task names. Never push. Never bypass a hook (`--no-verify`, `-c core.hooksPath=...`, editing anything under `.git/hooks`). If a commit is blocked by a hook, stop and report the hook's output verbatim and wait.

**Honesty.** If a command is blocked or fails, quote it verbatim and stop. Never report a passing, zero, or empty result for a command you did not run. An empty grep is not a clean scan: print the tool's own final line. Say which steps you skipped and why.

**Never run `chamber pin` or `launchctl` against the real HOME.** Not as a check, not "just to see". `~/.local/share/chamber-release` and `~/Library/LaunchAgents` belong to the owner's live 08:30 job. Every test and manual run uses a throwaway HOME made with `mktemp -d`. Never read `~/.secrets`, `~/.ssh`, `~/.aws` or any `*.local.md`.

**No credential-shaped literals.** Do not write a password, token or key into any file, test or message, not even a fake one that looks real. The tests in this plan build such strings at run time (`["hunter", "2"].join("")`) for that reason. The global pre-commit hook runs two secret scanners; a block is a finding, not an obstacle.

**Code style.** Explicit types on every parameter and return, no `any`, no `@ts-ignore`. Validate against closed sets; do not escape strings. Comments explain why, in the repository's existing voice.

**What would make a task wrong in a way the tests would not catch** is written at the end of each task under "Not caught by the gates". Read it before reporting the task done.

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `package-lock.json` | 1 | `npm audit fix` result (only this file changes) |
| `src/version.ts` (new) | 1 | `readPackageVersion()`, the one reader of `package.json`'s version for the MCP server |
| `src/mcp_server.ts` | 1 | `SERVER_VERSION` comes from `readPackageVersion()` |
| `server.json` | 1 | top-level `version` agrees with `package.json` |
| `Dockerfile` | 2 | stdio image: `apt-get upgrade`, no npm/npx/corepack |
| `.github/workflows/ci.yml` | 2 | hashed pip install, `audit` and `secrets` jobs, `image` matrix over both Dockerfiles |
| `scripts/requirements-embed.in` (new), `scripts/requirements-embed.txt` (new) | 2 | input and hash-pinned lock for the embedder's Python packages |
| `.github/dependabot.yml` (new) | 2 | weekly npm, github-actions, docker `/` and `/deploy` |
| `scripts/embed_minilm.py` | 3 | SHA-256 check of `model_quantized.onnx` against `models/minilm/VERSION`, exit 3 |
| `deploy/systemd/chamber-jobs.service` | 4 | hardening directives from `chamber.service` |
| `src/sandbox.ts` | 5 | `runBwrap` adds `--unshare-pid --unshare-ipc --unshare-uts --new-session` |
| `probes/sandbox_confines.ts` | 5 | new needle: a host process the payload must not see, proven visible unconfined |
| `src/release_pin.ts` | 6, 7 | git env/timeouts/credentials/atomic write (6); proof run, plist comments, `Program` key, hint (7) |
| `scripts/daily-snapshot.sh`, `deploy/launchd/com.chamber.daily-snapshot.plist` | 8 | release-checkout commands, `rc` fix, labels, plist path |
| `docs/BACKUP.md` (new), `deploy/PILOT.md`, `docs/KNOWN_LIMITATIONS.md`, `README.md`, `benchmarks/BENCHMARK.md`, `deploy/SCHEDULING.md`, `CHANGELOG.md` | 9 | the C5 docs |
| `tests/harness.ts` | 1 to 4, 6 to 8 | new tests, the release-pin fixture |

---

### Task 1: Dependency advisories (B1) and version sites (B5)

**Files:**
- Modify: `package-lock.json` (only this file, from `npm audit fix`)
- Create: `src/version.ts`
- Modify: `src/mcp_server.ts` (one import, one constant)
- Modify: `server.json` (top-level `version`)
- Modify: `tests/harness.ts` (one new `config` test)

**Interfaces:**
- Produces: `readPackageVersion(): string` exported from `src/version.ts`. It reads `../package.json` relative to its own file, so it resolves from `src/` in a clone and from `dist/` in the published tarball.
- Consumes: nothing from earlier tasks.

Two commits: first B1 (lockfile), then B5 (version sites).

#### Part A: B1, the lockfile

- [ ] **Step 1: Install, then see the audit fail**

```bash
npm ci
npm audit; echo "audit exit: $?"
```

Expected: `2 vulnerabilities (1 high, 1 critical)`: `brace-expansion` (high, `4.0.0 - 5.0.11`, via `minimatch`) and `proxy-addr` (critical, `1.1.0 - 2.0.7`, via `express` under `@slack/bolt`), `audit exit: 1`. If it reports something else, stop and report it verbatim: the plan's premise has changed.

- [ ] **Step 2: Run the fix**

```bash
npm audit fix
git status --short
git diff --stat
```

Expected: `git status --short` lists `package-lock.json` and nothing else, and `git diff --stat` shows only `package-lock.json`. The diff moves `brace-expansion` to 5.0.12 (or a later patch) and `proxy-addr` to 2.0.8 (or a later patch). **If `package.json` changed, if npm says a fix needs `--force` or a semver-major bump, or if any other file changed: run `git checkout -- package.json package-lock.json`, stop, and report. Do not accept it.**

- [ ] **Step 3: Prove the audit is clean**

```bash
npm ci
npm audit; echo "audit exit: $?"
npm audit --audit-level=high; echo "audit-level=high exit: $?"
```

Expected: `found 0 vulnerabilities` and both exit codes 0.

- [ ] **Step 4: Run the four gates**

`npm run typecheck`, `npm run lint`, `npm test`, `npm run probes`, as in Global Constraints. Expected: same as the baseline.

- [ ] **Step 5: Commit**

```bash
git add package-lock.json
git commit -m "fix: update proxy-addr and brace-expansion for the npm advisories

npm audit reported brace-expansion (high) and proxy-addr (critical) in the
lockfile. npm audit fix moved both within their semver range; package.json is
unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Mutation proof for B1**

The CI `audit` job (Task 2) runs `npm audit --audit-level=high`. Put the pre-fix lockfile back (`npm audit` reads the lockfile, so no install is needed) and confirm that command fails:

```bash
git show HEAD~1:package-lock.json > package-lock.json
npm audit --audit-level=high; echo "audit exit with the old lockfile: $?"
git checkout -- package-lock.json
git diff --stat
npm audit --audit-level=high; echo "audit exit restored: $?"
```

Expected: `audit exit with the old lockfile: 1`, an empty `git diff --stat`, and `audit exit restored: 0`.

#### Part B: B5, version sites agree

- [ ] **Step 7: Write the failing test**

Use `Edit` on `tests/harness.ts`: `old_string` is `// ─── cli process smoke tests`, `new_string` is the block below followed by `// ─── cli process smoke tests`.

```ts
test("config", "package.json, server.json, the served MCP version and the changelog name one version", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const registry = JSON.parse(readFileSync(join(root, "server.json"), "utf8")) as {
    version: string;
    packages: { version: string }[];
  };
  const released = /^## (?!Unreleased\b)(\S+)/m.exec(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  assert(released !== null, "CHANGELOG.md has no released heading");

  // The version the running server reports, not a constant read out of its
  // source: a hand-typed copy and a reader of package.json look identical to a
  // grep and differ only here.
  const home = mkdtempSync(join(tmpdir(), "chamber-version-"));
  try {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "version-test", version: "0" } },
    };
    const run = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "src", "mcp_server.ts")], {
      encoding: "utf8",
      timeout: 30_000,
      input: `${JSON.stringify(initialize)}\n`,
      env: {
        ...process.env,
        HOME: home,
        CHAMBER_DB: join(home, "never.sqlite"),
        CHAMBER_CONFIG: join(home, "never.json"),
      },
    });
    assert(run.error === undefined, `launch failed: ${run.error}`);
    const line = (run.stdout ?? "").split("\n").find((l) => l.includes('"id":1'));
    assert(line !== undefined, `no initialize reply: ${run.stdout} ${run.stderr}`);
    const reply = JSON.parse(line) as { result?: { serverInfo?: { version?: string } } };
    const seen: Record<string, string | undefined> = {
      "package.json": pkg.version,
      "server.json version": registry.version,
      "server.json packages[0].version": registry.packages[0]?.version,
      "CHANGELOG.md first released heading": released[1],
      "mcp_server serverInfo.version": reply.result?.serverInfo?.version,
    };
    assert(new Set(Object.values(seen)).size === 1, `the version sites disagree: ${JSON.stringify(seen, null, 2)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

```

- [ ] **Step 8: Run it and see it fail for the right reason**

```bash
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -A8 "FAIL"
```

Expected: one `[FAIL] config/package.json, server.json, the served MCP version and the changelog name one version`, whose message lists `"server.json version": "0.1.10"` against `"0.1.9"` everywhere else (the served version is `0.1.9` because it is still hand-typed). Any other failure, or a pass, means stop and report.

- [ ] **Step 9: Create `src/version.ts`**

```ts
/**
 * The package version, read from package.json the way `chamber --version`
 * does. `../package.json` resolves from src/ in a clone and from dist/ in the
 * published tarball alike, so a second hand-typed copy of the number cannot
 * drift from the one npm publishes.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function readPackageVersion(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error(`${path} has no version`);
  }
  return pkg.version;
}
```

- [ ] **Step 10: Edit `src/mcp_server.ts`**

Two `Edit` calls.

`old_string`:

```ts
import { formatErrorChain } from "./error_chain.ts";
```

`new_string`:

```ts
import { formatErrorChain } from "./error_chain.ts";
import { readPackageVersion } from "./version.ts";
```

`old_string`:

```ts
const SERVER_VERSION = "0.1.9";
```

`new_string`:

```ts
const SERVER_VERSION = readPackageVersion();
```

- [ ] **Step 11: Edit `server.json`**

`old_string` (exactly this line, with its two leading spaces):

```json
  "version": "0.1.10",
```

`new_string`:

```json
  "version": "0.1.9",
```

`git diff server.json` must show exactly that one line changed. The other `"version": "0.1.9"` (inside `packages`) is already right.

- [ ] **Step 12: Run the test and see it pass**

```bash
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | tail -3
```

Expected: the new test `[PASS]`, and the last line `N/N passed · 0 failed`.

- [ ] **Step 13: Check `dist/` resolves too**

`SERVER_VERSION` must resolve from the published tarball layout, not only from `src/`:

```bash
D=$(mktemp -d)
node_modules/.bin/tsc -p tsconfig.build.json --outDir "$D/dist"
cp package.json "$D/"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  | HOME="$D" CHAMBER_DB="$D/never.sqlite" CHAMBER_CONFIG="$D/never.json" node "$D/dist/mcp_server.js" | head -c 220; echo
rm -rf "$D"
git status --short
```

Expected: the reply contains `"serverInfo":{"name":"chamber","version":"0.1.9"}`, and `git status --short` still lists only the files this task changed (the build went to the temp directory).

- [ ] **Step 14: Run the four gates, then commit**

```bash
git status --short     # server.json, src/mcp_server.ts, src/version.ts, tests/harness.ts only
git add server.json src/mcp_server.ts src/version.ts tests/harness.ts
git commit -m "fix: make the MCP server report package.json's version

server.json's top-level version said 0.1.10 while package.json and the npm
package said 0.1.9, and SERVER_VERSION was a third hand-typed copy. The server
now reads package.json the way chamber --version does, and a test fails when
package.json, both server.json versions, the served version and the first
released CHANGELOG heading disagree.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 15: Mutation proofs for B5**

```bash
# (a) the old server.json
git show HEAD~1:server.json > server.json
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -A7 "FAIL"
git checkout -- server.json
```

Expected: the test fails and lists `"server.json version": "0.1.10"`.

```bash
# (b) a hand-typed SERVER_VERSION again
```

Use `Edit` on `src/mcp_server.ts`: change `const SERVER_VERSION = readPackageVersion();` to `const SERVER_VERSION = "0.0.0";`, then:

```bash
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -A7 "FAIL"
git checkout -- src/mcp_server.ts
git diff --stat
```

Expected: the test fails and lists `"mcp_server serverInfo.version": "0.0.0"`, and the final `git diff --stat` prints nothing. (The CHANGELOG term of the test is guarded the same way by editing the first released heading; you do not need to prove it a third time.)

**Not caught by the gates:** the lockfile moves only what `npm audit fix` chose; confirm in review that no package other than `brace-expansion` and `proxy-addr` (and their own metadata, such as `funding`) changed major version. `npm audit` is a network call: if the registry is unreachable, Step 3 fails with a network error, which is not a clean audit.

---

### Task 2: Both images clean and scanned (B2), CI supply-chain steps (B3)

**Files:**
- Modify (whole file): `Dockerfile`
- Modify (whole file): `.github/workflows/ci.yml`
- Create: `scripts/requirements-embed.in`, `scripts/requirements-embed.txt`
- Create: `.github/dependabot.yml`
- Modify: `tests/harness.ts` (one new `config` test)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `scripts/requirements-embed.txt`, the file both CI Python installs read. No later task depends on it.

**What was decided offline, and how.** Four facts below were measured on 2026-10-21 with network access, and the commands are recorded so they can be re-run:

- *Pip hashes.* `scripts/requirements-embed.txt` was generated with `uv 0.12.22`, for Python 3.12 on `x86_64-manylinux_2_28`, with `--exclude-newer 2026-10-21T00:00:00Z`. `uv` lists every published file of each pinned version, so the hashes cover CPython 3.12 to 3.14 on Linux x86_64 (and every other platform). The same versions resolve for 3.12 and for 3.14, so the pin does not depend on which Python `ubuntu-latest` carries when the job runs. It was installed with `--require-hashes` in an `ubuntu:24.04` `linux/amd64` container (Python 3.12.3), `scripts/embed_minilm.py` then produced a 384-value vector, and a copy with every hash altered was refused with `THESE PACKAGES DO NOT MATCH THE HASHES`.
- *Gitleaks.* `gitleaks/gitleaks-action` v3.0.0 (commit `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e`) does not need a licence for a personal account such as `abm9111`. It is **not used**, for a different reason: its `Scan` runs `gitleaks detect --log-opts="--no-merges --first-parent <base>^..<head>"`, which is the commit range of the event and not the full history, and it downloads gitleaks 8.24.3 at run time with no checksum. The spec allows the release binary with a verified checksum, and that is what `ci.yml` below does: gitleaks 8.30.1, tarball SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`, read from the release's `gitleaks_8.30.1_checksums.txt`. Run locally over this repository's 270 reachable commits it ended with `no leaks found`.
- *Trivy action.* `aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0` is reused unchanged: `git/ref/tags/v0.36.0` is an annotated tag whose commit is that SHA, and v0.36.0 was still the latest release.
- *Images.* The root image at `ccdf148` had 3 fixable HIGH findings, all listed under `Node.js (node-pkg)` (two `brace-expansion` CVEs and one `undici` CVE); they are gone once npm, npx and corepack are removed. With the Dockerfile below it has 0 fixable HIGH/CRITICAL, and it still answers an MCP `initialize` over stdio.

- [ ] **Step 1: Tool check**

```bash
docker info >/dev/null 2>&1 && echo "docker ok" || echo "docker NOT available"
command -v trivy gitleaks uv actionlint
```

Missing `docker` or `trivy` means Step 9 is `NOT RUN` and CI is the evidence for the image gate; say so in the report. Missing `uv` means Step 5's reproducibility check is `NOT RUN`. Missing `actionlint` means the lint in Step 8 is `NOT RUN`; the YAML parse still runs. Missing `gitleaks` means Step 10 is `NOT RUN`.

- [ ] **Step 2: Write the failing test**

`Edit` on `tests/harness.ts`: `old_string` `// ─── cli process smoke tests`, `new_string` the block below followed by `// ─── cli process smoke tests`.

```ts
test("config", "CI pins its actions by SHA, installs Python by hash, scans both images, audits and scans history", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");

  // Every action is a full commit SHA. A tag is a pointer its owner can move.
  const uses = [...ci.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1] ?? "");
  assert(uses.length >= 8, `expected the workflow's actions, found ${uses.length}`);
  for (const u of uses) {
    assert(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(u), `action not pinned by a full commit SHA: ${u}`);
  }

  // Both Python installs read the hash-pinned file and refuse anything else.
  const pips = ci.split("\n").filter((l) => /\bpip install\b/.test(l));
  assert(pips.length === 2, `expected two pip install lines, found ${pips.length}`);
  for (const l of pips) {
    assert(
      l.includes("--require-hashes") && l.includes("-r scripts/requirements-embed.txt"),
      `pip install without --require-hashes from the pinned file: ${l.trim()}`,
    );
  }

  // The lock itself: every requirement has a hash, and the command that made it
  // is recorded in its first lines.
  const lock = readFileSync(join(root, "scripts", "requirements-embed.txt"), "utf8");
  assert(lock.split("\n").slice(0, 3).join("\n").includes("uv pip compile"), "the lock does not record its command");
  let name: string | null = null;
  const hashes = new Map<string, number>();
  for (const line of lock.split("\n")) {
    const req = /^([A-Za-z0-9][A-Za-z0-9._-]*)==\S+/.exec(line);
    if (req !== null) {
      name = req[1] ?? null;
      hashes.set(name ?? "", 0);
    } else if (name !== null && /^\s+--hash=sha256:[0-9a-f]{64}\b/.test(line)) {
      hashes.set(name, (hashes.get(name) ?? 0) + 1);
    }
  }
  for (const want of ["numpy", "onnxruntime", "tokenizers"]) {
    assert(hashes.has(want), `${want} is not in the lock`);
  }
  for (const [pkg, n] of hashes) assert(n > 0, `${pkg} is pinned without a hash`);

  // Both images are built and scanned under the same gate.
  assert(/dockerfile:\s*Dockerfile\s*$/m.test(ci), "the image job does not build ./Dockerfile");
  assert(/dockerfile:\s*deploy\/Dockerfile\s*$/m.test(ci), "the image job does not build deploy/Dockerfile");
  assert((ci.match(/ignore-unfixed: true/g) ?? []).length === 1, "expected one fixable-only gate");
  assert(ci.includes("exit-code: '1'") && ci.includes("severity: HIGH,CRITICAL"), "the image gate lost its severity or exit code");

  // Dependency audit and a secret scan over the whole history.
  assert(ci.includes("npm audit --audit-level=high"), "no npm audit step");
  assert(/fetch-depth:\s*0/.test(ci), "the secret scan does not fetch the full history");
  assert(ci.includes("gitleaks git "), "no gitleaks history scan");
  assert(/GITLEAKS_SHA256:\s*[0-9a-f]{64}\b/.test(ci), "the gitleaks download is not checked against a SHA-256");

  const bot = readFileSync(join(root, ".github", "dependabot.yml"), "utf8");
  for (const [eco, dir] of [
    ["npm", "/"],
    ["github-actions", "/"],
    ["docker", "/"],
    ["docker", "/deploy"],
  ] as const) {
    const entry = new RegExp(`package-ecosystem:\\s*${eco}\\s*\\n\\s*directory:\\s*${dir.replace("/", "\\/")}\\s*\\n\\s*schedule:\\s*\\n\\s*interval:\\s*weekly`);
    assert(entry.test(bot), `dependabot.yml has no weekly ${eco} entry for ${dir}`);
  }
});

```

- [ ] **Step 3: Run it and see it fail**

```bash
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -A2 "FAIL"
```

Expected: `[FAIL] config/CI pins its actions by SHA, ...` with `pip install without --require-hashes from the pinned file: - run: python3 -m pip install --quiet --break-system-packages numpy onnxruntime tokenizers`.

- [ ] **Step 4: Create `scripts/requirements-embed.in`**

```
# The Python packages scripts/embed_minilm.py imports: numpy, onnxruntime,
# tokenizers. Unpinned on purpose -- this is the input, not the lock.
# scripts/requirements-embed.txt is the lock; CI installs only that file, with
# --require-hashes. Regenerate it with the command on its first lines.
numpy
onnxruntime
tokenizers
```

- [ ] **Step 5: Create `scripts/requirements-embed.txt`**

Write this file exactly (it is the output of the command on its second line; do not reorder or "tidy" it):

```
# This file was autogenerated by uv via the following command:
#    uv pip compile scripts/requirements-embed.in --generate-hashes --python-version 3.12 --python-platform x86_64-manylinux_2_28 --exclude-newer 2026-10-21T00:00:00Z -o scripts/requirements-embed.txt
anyio==4.15.1 \
    --hash=sha256:6152fdbbf9a77fdec97731721bebf7c4c44f7c29b424b0065826173efc7ed101 \
    --hash=sha256:9f28306018cbd6d329e64a36d58256edff76dd996fe423bc957326e578b82a94
    # via httpx2
click==8.5.0 \
    --hash=sha256:255bc9599cf7748b4b1a446ccc735421bd08a2ae529a8b88597d3de5664ee360 \
    --hash=sha256:ba0d2089de75ea0310e2dde03160e6ca10009947fb95a182f9b54021bb272e34
    # via huggingface-hub
filelock==4.2.4 \
    --hash=sha256:301241438c57936ef93f4243a94f2559022268bfcf9b375a9a72eb0f8db8358e \
    --hash=sha256:c6d8663535e1650ee430507b4ffbac7b464dd64b7647ea0112a9f406499d163d
    # via huggingface-hub
flatbuffers==25.12.19 \
    --hash=sha256:7634f50c427838bb021c2d66a3d1168e9d199b0607e6329399f04846d42e20b4
    # via onnxruntime
fsspec==2026.9.0 \
    --hash=sha256:0f08147951c8cb31d844c3547d631053b127863b60be04cf06e121333ee0e2fe \
    --hash=sha256:8dd6e646e99ea382bd85f97a45e6b526a442d79423a7dc673f1e2756d05fcb5f
    # via huggingface-hub
h11==0.16.0 \
    --hash=sha256:4e35b956cf45792e4caa5885e69fba00bdbc6ffafbfa020300e549b208ee5ff1 \
    --hash=sha256:63cf8bbe7522de3bf65932fda1d9c2772064ffb3dae62d55932da54b31cb6c86
    # via httpcore2
hf-xet==1.7.0 \
    --hash=sha256:0a9e802f33bf50c851abe45fc5380e61f959e2d369647d6742b79ad9d6c27cab \
    --hash=sha256:19c0e64f14175ccb6a1aff69e0d2ab9ec5269a560e6687abaf2b3fa4f73de7cd \
    --hash=sha256:2814a6e999d13464c4d679b788cc5d784eb5a4edfc638a31f10e9a11ab531ef8 \
    --hash=sha256:2b7bb5727889b0f2436dbaaad8fc4c3e66b8240d992716989e0c086b4278b1bc \
    --hash=sha256:4ee5e05a627f5ab5bad7a86582277d645556ea1e199903aae19e033a392aa13a \
    --hash=sha256:57bc157b8b7fe3bee9dcb9af7f3da8de41801c3b31a9ef68a77a33c6a6be382f \
    --hash=sha256:59fba37039233c7fcbe196817d6cdcf1b40dfb17b410f229d85b0cf0a1848da4 \
    --hash=sha256:757168feb5679647c0bb13ee5d0faebe799c4dff9051419885a566ebd79f949d \
    --hash=sha256:80f79dae613ce9e0ea1fd1ae15616ca9ac74aed4c770aabc199c4f03ebecc863 \
    --hash=sha256:87dab080f8f7d32781c2586904e3603f4e60d09bfc727706c3ae419e0829beeb \
    --hash=sha256:acc3851cf2576a8fb2ae926da863f4efabe21303cf292e9a44332802ab0dcc6a \
    --hash=sha256:b01fe18dbbd151a2403d2c64ed30dc6547b00d6babab9a617d77c7acdb81ee66 \
    --hash=sha256:b91569d5f1b61c34b043687da02c05dd3604f3d329e7868510bf3f7971599006 \
    --hash=sha256:d406ec79053c0871817f700c2ac8c36ba0d87f9c34b7458b0f0063bb218b0466 \
    --hash=sha256:e3e88a7a75d7d95cbee1f37dc31341d6201124cf21c6c4b1dfab8ccba9b09e0f \
    --hash=sha256:fa029678be1ba7f953c409b0b27bf15cc69cd1c9b3a674fbd78856ebefca1052 \
    --hash=sha256:fcfd6c22418e57dd5b3aea649e813b2e2cfb2aebf317b210d90f1fe4b3018b52
    # via huggingface-hub
httpcore2==2.15.1 \
    --hash=sha256:730f603058c260a3288378217b464713350c23e3b8fe8bba753701054032d98a \
    --hash=sha256:a94b6b3e6260e1a3f035915408d3dcd7dc8e844c2b544b642e227cf98a747af0
    # via httpx2
httpx2==2.15.1 \
    --hash=sha256:75841cd83d16b417f7d6da8f2089ce8120806efdbf96af37d46c5129c49015be \
    --hash=sha256:ff75485308fbe441e75b1218546e4e78d884df41e1a9741c1f79335ed8fcfef7
    # via huggingface-hub
huggingface-hub==2.2.0 \
    --hash=sha256:1667f145dc56dc210d60966069397df9ecfca9607a5d43db88b308c89dae56b3 \
    --hash=sha256:5d1b47537394e4215cb858aa12fd493d0f7ef7f58990f5dcd24bc173107b2871
    # via tokenizers
idna==3.20 \
    --hash=sha256:a7db850025b95ded1eae8a46181a1a6c56c92c96f0e2b005d9ff8dc0210cab44 \
    --hash=sha256:ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c
    # via
    #   anyio
    #   httpx2
numpy==2.5.4 \
    --hash=sha256:067374eb538c34c745436365cf7b0112595c1d326f21ce4ff340f61230239fbb \
    --hash=sha256:0b4724a19de67bea8cfc4970798efa78bcbbe2ac2613cfac16721a42d44de2a5 \
    --hash=sha256:0f02a46e49cfb6c73bdb7aea1c0d3461dbae9aba613542b65f657cd3d17b9fab \
    --hash=sha256:1c2e71b04c6cad90026e544501bbe0ab9290fa8a4d845e7e8c0d124fb429c988 \
    --hash=sha256:1ef3aa6d7e29bb13677323114280b05acc57607fa2300e66432d665d5418a162 \
    --hash=sha256:2132418bf8dd124a427ca9e6a1daf9ee1a87185344c95119ceae868b99466da1 \
    --hash=sha256:2199ed071f460487c8db2c0e5c0b564494190edb4772fe80f9aad88b2604def5 \
    --hash=sha256:2377da2dd3ba2c1200956acbab2a358c83b8e1f8531191672d1cd6ad83250d53 \
    --hash=sha256:298eca75243f2cbbfdb460560b9fb2a1792a33cf2ab4286efd43d92e8d3df508 \
    --hash=sha256:2c2c4afffdeb7920e445028dd71eb932cac3e704792e964bc2a232426d4f1255 \
    --hash=sha256:2ca144f15135b6212a5c47b1e2aeca6e412f102f95a2d5d88d8aec77eb255de3 \
    --hash=sha256:2fa3328f784fc8277fc48026f6cad516f5c561c5d8e2e39b3c9e0c8f23223b34 \
    --hash=sha256:325518d4245b9e331387702aa58c2ce1dc4cdcbb41dfb4ccd5dcbc7e08db1266 \
    --hash=sha256:332f3378fe077dd850e677ec01bdcc4f22368fb5d50ef10b2c79230b1bf5a592 \
    --hash=sha256:3573cd22564692a5b899ec344e5d5b9cc4576f2985b96f22af3564ed54f2710f \
    --hash=sha256:381a7a3d2e65e64c0ec302795ab9dc12bb1e73f150904699c153716177eebdaf \
    --hash=sha256:38f47be9f74ab870d2633b5456ae519c43758a8d1fd05342f0ce4ecc034396ee \
    --hash=sha256:4054173604cd8658796053f1f3bc0befb68ec1c0762c57fdad61e199256a8617 \
    --hash=sha256:468397ba3c64427474706e5c9123fe266395496714dc684294eac75cd4930d1e \
    --hash=sha256:4e263278bfb5ee6409db8aedbc4cc32973b1b82bc1e8d3c668551d04d83a7e37 \
    --hash=sha256:5258bc06526964be5face2fc6f756857a3f24f21ec3e72ca131337a75b165d6c \
    --hash=sha256:56733449d2544178beaa4545cee357370440cf056c197f9c7bfb19dbfdd0e86d \
    --hash=sha256:5ec3753760c1a6d8bb91200666e545c3a9728e6269dfb5d6ce02340996698aa3 \
    --hash=sha256:5fbf7141bbfd63aea22f435c9062a032b9ea0082fe9845dad7f021d3f1234e71 \
    --hash=sha256:64d1c8ac28a4077cf987e0a71a7a0ef7e2df70722f07f0baa42dbb7eb6938647 \
    --hash=sha256:64f9c9878c1938476365e11ccfb6b770f3b9e5f045ccddc514235041e6959365 \
    --hash=sha256:6c109eac9cd439193678f69d70733c1108487546ca8eafc107b510ae10c1aecd \
    --hash=sha256:6d6a71b9d9a97c03633aa12565ef2825ffa036cc1d99cfd50dacf0f128af4fe2 \
    --hash=sha256:6ffa07666f8da0eef81d149934a626d0d95fbd6838432a33e66245423a9062c0 \
    --hash=sha256:7415db95818b39ec475a5eea54d9e3b6bc83e3912158e46da3438cdce399804d \
    --hash=sha256:77045a4b175bbf5316ec08003880804336c78f92281a1b72222b274ea85ec5ac \
    --hash=sha256:7a14a461d9340f1b46b8648578aed9cdb8b3b018a8fac6c1dde2c9192a01a87f \
    --hash=sha256:80d6ef6e8620eb2c2b4c4caad50b5935d6db3cde2d51581b55dcc79e14016d1d \
    --hash=sha256:81e3420b27048b65eb14c3acf0c174a8cb0e023277716110347d2dcb26026dad \
    --hash=sha256:823874a507a84af050493b622affde94b6f7c3a0dc22cb2801381bc03b871c00 \
    --hash=sha256:8b4d2fd2d34e5f8c9235ee787de5631a37a28402b15cb80814df973d2be54129 \
    --hash=sha256:8dddfbee2e68d26d0d7d7d9cb247b1fd4409241cce32d815a11d97ec2cfde179 \
    --hash=sha256:950ea81d57ef070665581b6e1b5f6a029306423cd1739c5b95fe78aa30db6b9d \
    --hash=sha256:956555e0603a4d38019ae6925711cb9dc43195c076a928accf7ea5d50bddfe53 \
    --hash=sha256:98b053943e5a0474ec0da309d2cb9d3f18ea57f8a2067c2ab7b5f763d1068380 \
    --hash=sha256:9968ab7e49b93ac6e1c3b2239732183152c9150f16308d30b66a372cffe3483c \
    --hash=sha256:9a94cf751c9ad8ebaa835bcd3d40dacf8534ad086b88c38029b65123c7999d2a \
    --hash=sha256:9cb18a327b49c5c337f972b03682f6a49855525faaf3c0d3e9c96cd0fd8880a8 \
    --hash=sha256:a7b1b6353e36a7e50de2973a38d705c88ee93adcf120673cee7f45a4a3fa223a \
    --hash=sha256:a813ed7719bf45463c51779e6a98d0385fe905e48447526938a4b8337333d551 \
    --hash=sha256:aa1cce2ff3f8d953de38b76bf44602caeb69f101430208f64a10067f7cb4b1d3 \
    --hash=sha256:ad62a416ddcf863bf44bba76fbf6b53366ab0692e294f51cae4b5fbe0d246788 \
    --hash=sha256:aec3fc4b32ff82421274f5d205c559c51c840c8df66a78efd7f3612dd005a26a \
    --hash=sha256:b1185012870173de7ae33d370bd45b1cf5baee747ea4b97036b65f4e93016877 \
    --hash=sha256:b11e8fda06a7d69f15ebf542660b74466c2e51094800c1fb794f47ad4faeef17 \
    --hash=sha256:b64a85f40e154983960a4167d4c1d57a50c7f109b3d3264a3a984154e90a8454 \
    --hash=sha256:b86966fbe4ad7de710422175572bcdc75fdedadfb54bc6fab7deabccddd7780b \
    --hash=sha256:b89d0aaae2fe498c648f4c4795c084db535af5bd98ef942b2a3681fb74ce8645 \
    --hash=sha256:bc39ac66a7a9a3fbd6134fda43136b60ffde99c8f4501e64e0d2b24da137babf \
    --hash=sha256:c05ede731b03fb1b7591faca9389ade3267d2bddf1ad8882bb3f2cc5e101694f \
    --hash=sha256:c6342f54c67093cae5c0227eb0eb772fdb79f2a2c37a6eb278b9909ee06aa356 \
    --hash=sha256:c668b2f0d651605b58892644b0e302c7157f7159544227758c896982ef384b18 \
    --hash=sha256:c9b80cdf5cedba0e90d93fa5f9a333c4d65bd545cd669b71bb97ce2b703c9d73 \
    --hash=sha256:cfd73180400042a7c532d30c5e287bdd03c59ff9ee1b4c0316af0539e29dfe23 \
    --hash=sha256:d4cccbbc78717966f764cd3af4fb70276fa01fc7a2688af11c78901fa5c04f05 \
    --hash=sha256:d549420b8858885cea8838a727842249218b9c1da24dd517e25c9c7a948310a3 \
    --hash=sha256:d8200f16437b289a5bb927c6e184eccc3e8389bc0070fea4cd5b9e13c1757959 \
    --hash=sha256:e94aef2c639da4a960ad0db8e06471208d8589974953d78b61d345b4eb99e394 \
    --hash=sha256:fbde6962867ee75b48b0ee29b2b9372ec5d617799dbaf38e82dc0596f2f7738a \
    --hash=sha256:fe4d21ab149f15e4e6043dfb0de87e6e5f34ac176cde83060e9802981fca2ac2 \
    --hash=sha256:ffa6ce09a1c6a08e9667dd9c97aa0b14184e8d18f2a14b78b2a2328c9147f076
    # via
    #   -r scripts/requirements-embed.in
    #   onnxruntime
onnxruntime==1.31.0 \
    --hash=sha256:09d56445c1753e66e0912de69d3f0184016ad9a191dcd6925bf5dd570d2bfbe5 \
    --hash=sha256:0ba02a44acb6203040354d9a1f160e3f37a43feac7bb05caa3e0ea545efed505 \
    --hash=sha256:1ecc1450af28d2cf362990e188ccc81b51388f317f641ad973ab4301473200f2 \
    --hash=sha256:278e0dc922ec69b05a28f59110d5421e2ec8b1d0dd46c6b10c063069a4051e72 \
    --hash=sha256:317608967b03807ed4661113b08293fac02a1db6496a6863a07d9f19232936ad \
    --hash=sha256:35758d7606d578ec5b9d65f6e8a1f488013194c3f6097038a3223cb26d35ef9a \
    --hash=sha256:37c7dfe398550afdf9670a29315dbb88e49d8afc473ffaf1f410376efbb9c80a \
    --hash=sha256:37fd78cee5160c7a43a1730ccb3682ffd880af9c9e80385d625c0c2f8b125809 \
    --hash=sha256:5c54a0eb7b2b4eef3eb9dcfaf82f5ce880db07288dc309574f6657e9da5cc754 \
    --hash=sha256:5e129d6c56abd53e659cb70f00a108d6824086470ff99c2e47a82e5786563db3 \
    --hash=sha256:73e0165d58ece068c2a8a1c477c90b38e5a8adbbd399fdfdfd4bd79cbc28ff8d \
    --hash=sha256:83e3dbcf6abc6189c4bdf7d329c07ba1133c88172134c266d84b4409aa3b9dbf \
    --hash=sha256:984c0a2c1ad6a41fbc101dc3949abe4a72254892d01a5e70d9b792711e0bfa54 \
    --hash=sha256:aaab9b3af536b06ca27ab5e35e3d429c97457ce76cf298af103f687e8b9975c0 \
    --hash=sha256:ad663106f6eeff3d454f24a786450459d07f30e74863851104fc1b8b3f368127 \
    --hash=sha256:cbf1a7f6470ddfe9dbc781966af8ce4a10e1858d75a93f93cc6b9367c9587870 \
    --hash=sha256:d25cd65874b75fdf16149120a04d0cd4551f860a3c8e2ecec785a1903e41d8aa \
    --hash=sha256:d2d5ac22f896c810be2b2b171392bb908f80b6c9a7e2d592ddb7435c928044e1 \
    --hash=sha256:d4092b78fc5bab77ce6522393098cdb2535423045ecdcff15cc0d022162d6b66 \
    --hash=sha256:e0e050bf9ec754950a6ba9830e4032f4004d972c6f38c5642fef26d44d894965 \
    --hash=sha256:e4efa4a1a0bb0b5173c6a3292c181d518b8323f9d56e978635d0c09d38c94d1a \
    --hash=sha256:e51d10d2e2e1e5bbf9b126a0cd9853d3e6c4e21424518dd50160b91471be33dc \
    --hash=sha256:e85c1632c0a8cf488bd8f1039f5320877b864c8f9ebd4122fb8bb909f83b7096 \
    --hash=sha256:e93d7c5fad20afa697ac16f376fd0306ed180f9a376e86106cc0b7d84f53ef87
    # via -r scripts/requirements-embed.in
packaging==26.3 \
    --hash=sha256:94edc256424af38762eb31306eed28beb9f0efc50a8837492c9d6fd6004aed79 \
    --hash=sha256:d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c
    # via
    #   huggingface-hub
    #   onnxruntime
protobuf==7.36.2 \
    --hash=sha256:497d0463ff3316681da6c0b9e8d06cb465d61abce00b613ab42226175644d1bb \
    --hash=sha256:89f23aa53c24553a2416fd4fd1ec06f74fa42b14b546d8883128813f775bbfd2 \
    --hash=sha256:912c1221170e16c08d1f086762f563dd61ff83c18b5fa6652952dfaded66f728 \
    --hash=sha256:a300819d441e078a5608c0d3c709796bb548136058fda017ae51d425b44fd353 \
    --hash=sha256:bdb3a345d48db958e6ce1f18e508beb0cc981d64f24088427549c866cd039f1e \
    --hash=sha256:cbc70b17ee27e28894c7fee8bb04be1abead49e936bc70eb60052531eee2079e \
    --hash=sha256:e11e1f0180583a2af89db6a2ecd9e8dc40aa6d2988ca175bfd0e6d12ea72d74e \
    --hash=sha256:f4fee11ec330d238b34a05c9b675f693c20415d1c5bd7d5320cc2f8a798eb9cf
    # via onnxruntime
pyyaml==6.0.3 \
    --hash=sha256:00c4bdeba853cc34e7dd471f16b4114f4162dc03e6b7afcc2128711f0eca823c \
    --hash=sha256:0150219816b6a1fa26fb4699fb7daa9caf09eb1999f3b70fb6e786805e80375a \
    --hash=sha256:02893d100e99e03eda1c8fd5c441d8c60103fd175728e23e431db1b589cf5ab3 \
    --hash=sha256:02ea2dfa234451bbb8772601d7b8e426c2bfa197136796224e50e35a78777956 \
    --hash=sha256:0f29edc409a6392443abf94b9cf89ce99889a1dd5376d94316ae5145dfedd5d6 \
    --hash=sha256:10892704fc220243f5305762e276552a0395f7beb4dbf9b14ec8fd43b57f126c \
    --hash=sha256:16249ee61e95f858e83976573de0f5b2893b3677ba71c9dd36b9cf8be9ac6d65 \
    --hash=sha256:1d37d57ad971609cf3c53ba6a7e365e40660e3be0e5175fa9f2365a379d6095a \
    --hash=sha256:1ebe39cb5fc479422b83de611d14e2c0d3bb2a18bbcb01f229ab3cfbd8fee7a0 \
    --hash=sha256:214ed4befebe12df36bcc8bc2b64b396ca31be9304b8f59e25c11cf94a4c033b \
    --hash=sha256:2283a07e2c21a2aa78d9c4442724ec1eb15f5e42a723b99cb3d822d48f5f7ad1 \
    --hash=sha256:22ba7cfcad58ef3ecddc7ed1db3409af68d023b7f940da23c6c2a1890976eda6 \
    --hash=sha256:27c0abcb4a5dac13684a37f76e701e054692a9b2d3064b70f5e4eb54810553d7 \
    --hash=sha256:28c8d926f98f432f88adc23edf2e6d4921ac26fb084b028c733d01868d19007e \
    --hash=sha256:2e71d11abed7344e42a8849600193d15b6def118602c4c176f748e4583246007 \
    --hash=sha256:34d5fcd24b8445fadc33f9cf348c1047101756fd760b4dacb5c3e99755703310 \
    --hash=sha256:37503bfbfc9d2c40b344d06b2199cf0e96e97957ab1c1b546fd4f87e53e5d3e4 \
    --hash=sha256:3c5677e12444c15717b902a5798264fa7909e41153cdf9ef7ad571b704a63dd9 \
    --hash=sha256:3ff07ec89bae51176c0549bc4c63aa6202991da2d9a6129d7aef7f1407d3f295 \
    --hash=sha256:41715c910c881bc081f1e8872880d3c650acf13dfa8214bad49ed4cede7c34ea \
    --hash=sha256:418cf3f2111bc80e0933b2cd8cd04f286338bb88bdc7bc8e6dd775ebde60b5e0 \
    --hash=sha256:44edc647873928551a01e7a563d7452ccdebee747728c1080d881d68af7b997e \
    --hash=sha256:4a2e8cebe2ff6ab7d1050ecd59c25d4c8bd7e6f400f5f82b96557ac0abafd0ac \
    --hash=sha256:4ad1906908f2f5ae4e5a8ddfce73c320c2a1429ec52eafd27138b7f1cbe341c9 \
    --hash=sha256:501a031947e3a9025ed4405a168e6ef5ae3126c59f90ce0cd6f2bfc477be31b7 \
    --hash=sha256:5190d403f121660ce8d1d2c1bb2ef1bd05b5f68533fc5c2ea899bd15f4399b35 \
    --hash=sha256:5498cd1645aa724a7c71c8f378eb29ebe23da2fc0d7a08071d89469bf1d2defb \
    --hash=sha256:5cf4e27da7e3fbed4d6c3d8e797387aaad68102272f8f9752883bc32d61cb87b \
    --hash=sha256:5e0b74767e5f8c593e8c9b5912019159ed0533c70051e9cce3e8b6aa699fcd69 \
    --hash=sha256:5ed875a24292240029e4483f9d4a4b8a1ae08843b9c54f43fcc11e404532a8a5 \
    --hash=sha256:5fcd34e47f6e0b794d17de1b4ff496c00986e1c83f7ab2fb8fcfe9616ff7477b \
    --hash=sha256:5fdec68f91a0c6739b380c83b951e2c72ac0197ace422360e6d5a959d8d97b2c \
    --hash=sha256:6344df0d5755a2c9a276d4473ae6b90647e216ab4757f8426893b5dd2ac3f369 \
    --hash=sha256:64386e5e707d03a7e172c0701abfb7e10f0fb753ee1d773128192742712a98fd \
    --hash=sha256:652cb6edd41e718550aad172851962662ff2681490a8a711af6a4d288dd96824 \
    --hash=sha256:66291b10affd76d76f54fad28e22e51719ef9ba22b29e1d7d03d6777a9174198 \
    --hash=sha256:66e1674c3ef6f541c35191caae2d429b967b99e02040f5ba928632d9a7f0f065 \
    --hash=sha256:6adc77889b628398debc7b65c073bcb99c4a0237b248cacaf3fe8a557563ef6c \
    --hash=sha256:79005a0d97d5ddabfeeea4cf676af11e647e41d81c9a7722a193022accdb6b7c \
    --hash=sha256:7c6610def4f163542a622a73fb39f534f8c101d690126992300bf3207eab9764 \
    --hash=sha256:7f047e29dcae44602496db43be01ad42fc6f1cc0d8cd6c83d342306c32270196 \
    --hash=sha256:8098f252adfa6c80ab48096053f512f2321f0b998f98150cea9bd23d83e1467b \
    --hash=sha256:850774a7879607d3a6f50d36d04f00ee69e7fc816450e5f7e58d7f17f1ae5c00 \
    --hash=sha256:8d1fab6bb153a416f9aeb4b8763bc0f22a5586065f86f7664fc23339fc1c1fac \
    --hash=sha256:8da9669d359f02c0b91ccc01cac4a67f16afec0dac22c2ad09f46bee0697eba8 \
    --hash=sha256:8dc52c23056b9ddd46818a57b78404882310fb473d63f17b07d5c40421e47f8e \
    --hash=sha256:9149cad251584d5fb4981be1ecde53a1ca46c891a79788c0df828d2f166bda28 \
    --hash=sha256:93dda82c9c22deb0a405ea4dc5f2d0cda384168e466364dec6255b293923b2f3 \
    --hash=sha256:96b533f0e99f6579b3d4d4995707cf36df9100d67e0c8303a0c55b27b5f99bc5 \
    --hash=sha256:9c57bb8c96f6d1808c030b1687b9b5fb476abaa47f0db9c0101f5e9f394e97f4 \
    --hash=sha256:9c7708761fccb9397fe64bbc0395abcae8c4bf7b0eac081e12b809bf47700d0b \
    --hash=sha256:9f3bfb4965eb874431221a3ff3fdcddc7e74e3b07799e0e84ca4a0f867d449bf \
    --hash=sha256:a33284e20b78bd4a18c8c2282d549d10bc8408a2a7ff57653c0cf0b9be0afce5 \
    --hash=sha256:a80cb027f6b349846a3bf6d73b5e95e782175e52f22108cfa17876aaeff93702 \
    --hash=sha256:b30236e45cf30d2b8e7b3e85881719e98507abed1011bf463a8fa23e9c3e98a8 \
    --hash=sha256:b3bc83488de33889877a0f2543ade9f70c67d66d9ebb4ac959502e12de895788 \
    --hash=sha256:b865addae83924361678b652338317d1bd7e79b1f4596f96b96c77a5a34b34da \
    --hash=sha256:b8bb0864c5a28024fac8a632c443c87c5aa6f215c0b126c449ae1a150412f31d \
    --hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc \
    --hash=sha256:bdb2c67c6c1390b63c6ff89f210c8fd09d9a1217a465701eac7316313c915e4c \
    --hash=sha256:c1ff362665ae507275af2853520967820d9124984e0f7466736aea23d8611fba \
    --hash=sha256:c2514fceb77bc5e7a2f7adfaa1feb2fb311607c9cb518dbc378688ec73d8292f \
    --hash=sha256:c3355370a2c156cffb25e876646f149d5d68f5e0a3ce86a5084dd0b64a994917 \
    --hash=sha256:c458b6d084f9b935061bc36216e8a69a7e293a2f1e68bf956dcd9e6cbcd143f5 \
    --hash=sha256:d0eae10f8159e8fdad514efdc92d74fd8d682c933a6dd088030f3834bc8e6b26 \
    --hash=sha256:d76623373421df22fb4cf8817020cbb7ef15c725b9d5e45f17e189bfc384190f \
    --hash=sha256:ebc55a14a21cb14062aa4162f906cd962b28e2e9ea38f9b4391244cd8de4ae0b \
    --hash=sha256:eda16858a3cab07b80edaf74336ece1f986ba330fdb8ee0d6c0d68fe82bc96be \
    --hash=sha256:ee2922902c45ae8ccada2c5b501ab86c36525b883eff4255313a253a3160861c \
    --hash=sha256:efd7b85f94a6f21e4932043973a7ba2613b059c4a000551892ac9f1d11f5baf3 \
    --hash=sha256:f7057c9a337546edc7973c0d3ba84ddcdf0daa14533c2065749c9075001090e6 \
    --hash=sha256:fa160448684b4e94d80416c0fa4aac48967a969efe22931448d853ada8baf926 \
    --hash=sha256:fc09d0aa354569bc501d4e787133afc08552722d3ab34836a80547331bb5d4a0
    # via huggingface-hub
tokenizers==0.23.3 \
    --hash=sha256:114e2b55ed177179d59f4ab98200a4471e11e78f9e4b5a922d146740f96fcf52 \
    --hash=sha256:1554a6eed34d9d6a78d23360f4e06df8dffab1ae08c7e8488e0b3e3b36cc266f \
    --hash=sha256:1ebf28794e7e4954e20a7f70fbea410b2d1f0418f7dbbca97ca384fcfef38c25 \
    --hash=sha256:1f0823bb00c5fdc98e487354d54dd55a03848d61a1a0bf29a68c77f24f3b26c3 \
    --hash=sha256:2a89614730d7b80940a5d2ed9320e1ec8add5a745c6151d8d05071b7215505b6 \
    --hash=sha256:376851d22bcf9d650a5c3090bb83e6cf9e895fbf0595369fa4cd43c1f69b5f87 \
    --hash=sha256:5cc24bb457dd4a8af89c8fcb40074d570129ec473df2a866c276ee55db4749d7 \
    --hash=sha256:68649e97d5b43c44c031d8d848874a6eecae8f8fe40ea989aa777a5a83aca716 \
    --hash=sha256:7e48734d2de9260d86f03ab056d2cfeeff3869f61dbd49aaa15a2793b5f3458b \
    --hash=sha256:82eb480f6f1c21cea3349dec32cf1a6384c6c1e775f00f83b0d51197bc013687 \
    --hash=sha256:84513ef0aeb8bf8f4ea11a2e8a7ac163ec5288aa115e649a59b470ac5c3107df \
    --hash=sha256:9d2b5c97daf61688c2ad1803ca851800feaba50fb68d5821779e9ea5880d968c \
    --hash=sha256:a4fbb3662f9f59d199d61338e54b4bcc11d07ebbb1aeb3540dacb2be9c521cb7 \
    --hash=sha256:acd5c57b4bd3e56e246e2731a3a3a6825a7a7d89b7e3b761ba80bc521710f04b \
    --hash=sha256:bf501c40b72d2d5c8623620210430e9cac1ce47a46e45b34107b70a1557d46b0 \
    --hash=sha256:c64a0713180ff16829d4e7f39a658b77ea11443af4e1aa46523692943c9b1414 \
    --hash=sha256:cded33237c77caeef62944d32aa9a7ef42bdce2b3497e18d137e072a8c4be438 \
    --hash=sha256:d3407fb7b9c4d75dd68850ffd7180bc0a5d2dbaf0762d888e612f31fec3f9c6b \
    --hash=sha256:ddedfd4b3b4be6be24ff6ca645c4a37fddfd305f6f3e354c54cf10b715c48215 \
    --hash=sha256:de536665495cb4b409d25bade41963f801aff4225c19a6b804b048f7d14e34c7 \
    --hash=sha256:e05ab7baf7f47b406a95fea6f3b0a484b2ddcd9e1d14b68844c457eb755085a3 \
    --hash=sha256:e88646b8580c5ad7f4361477f1298e9cc01771a1ee9aecfe32c47b8ff614cc38 \
    --hash=sha256:ec82e80e65a862275b97c3d90b7a523df8d9519ee48aeb4e9625b2cc909274e0 \
    --hash=sha256:efa3d7318406b4d115dce61ad5061953f1f44b128e79c020ce4615d763e23b6e
    # via -r scripts/requirements-embed.in
tqdm==4.70.1 \
    --hash=sha256:c293e525e6fef9c20e8728fd4612df02a0aa31bb5fe91ecd93e123b1b7bffa73 \
    --hash=sha256:cefd0eca11b2a37a3aee776544d4f4ae913f02688135b5556b8788dfa474afc4
    # via huggingface-hub
truststore==0.10.5 \
    --hash=sha256:30d36967ccaded5cbb38d602c433f53600036c79d502f4533a49b60a03bbefcd \
    --hash=sha256:9aaaedaefaf06d8b206278cf8b5012bc897f485a874503501e12d776df78951c
    # via
    #   httpcore2
    #   httpx2
typing-extensions==4.16.0 \
    --hash=sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8 \
    --hash=sha256:dc983d19a509c94dba722ee6abd33940f7c05a89e243c47e907eb4db6f1a43e5
    # via
    #   anyio
    #   httpx2
    #   huggingface-hub
```

Then check it is reproducible. This uses the network (PyPI):

```bash
D=$(mktemp -d)
uv pip compile scripts/requirements-embed.in --generate-hashes --python-version 3.12 \
  --python-platform x86_64-manylinux_2_28 --exclude-newer 2026-10-21T00:00:00Z -o "$D/lock.txt" >/dev/null 2>&1
sed "s#$D/lock.txt#scripts/requirements-embed.txt#" "$D/lock.txt" | diff - scripts/requirements-embed.txt && echo REPRODUCIBLE
rm -rf "$D"
```

Expected: `REPRODUCIBLE` and no diff. If it differs, stop and report the diff: do not replace the file with the new output, because a different lock is a different, unreviewed set of hashes.

- [ ] **Step 6: Replace `.github/workflows/ci.yml` and create `.github/dependabot.yml`**

Write `.github/workflows/ci.yml` with exactly this content (every other job is unchanged from `ccdf148` except the two pip lines; `audit`, `secrets` and the `image` matrix are new):

````yaml
name: ci

# Nothing ran the suite except a human remembering to. A 300-test suite that
# only executes when someone types `npm run test` is a suite whose green is an
# anecdote. Every job here gates: none carries continue-on-error, because a
# gate that cannot fail is worse than no gate -- it reports safety it never
# checked.
on:
  push:
    branches: [main]
  pull_request:

# Declared rather than inherited. The repository's default is already `read`,
# so this changes nothing today -- which is the point: that default is a
# settings-page toggle, changeable outside this file and outside review, and
# every job here only ever reads the checkout. Stating it makes the grant a
# property of the workflow rather than of the account's current configuration.
permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          # Must satisfy package.json engines (>=23.6). Node's native type
          # stripping is what lets src/*.ts run without a build step.
          node-version: '24'
      # `npm ci` needs a lockfile; runtime dependencies are deliberately empty,
      # so this only installs the typecheck toolchain.
      - run: npm ci
      # The suite is not pure: `gates/an open blocking debt follows the claim
      # across a rewording` asserts semantic behaviour, so it needs a real
      # embedder. Without numpy/onnxruntime the gate degrades, the rewording
      # commits, and the test fails for a missing interpreter rather than a
      # broken gate. The model is committed; only the runtime is not.
      #
      # Installed from a hash-pinned file, not by name: three unpinned packages
      # (and everything they pull in) were being fetched fresh on every run, and
      # these are the packages that execute inside the embedder the gates call.
      # --require-hashes makes pip refuse any file whose SHA-256 is not listed in
      # scripts/requirements-embed.txt, and refuse an unpinned dependency.
      - run: python3 -m pip install --quiet --break-system-packages --require-hashes -r scripts/requirements-embed.txt
      - run: npm run test

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: '24'
      - run: npm ci
      # Catches the class tsc does not: unused bindings, unreachable code,
      # dropped promises. Gating, like every other job here.
      - run: npm run lint

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npm run typecheck

  probes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: '24'
      - run: npm ci
      # Without bubblewrap the runner has no isolating backend, so the sandbox
      # probe refuses and passes for the same reason it passes on a Mac -- the
      # real bwrap path is never exercised. A probe that cannot fail is not a
      # gate, and this one guards executing untrusted code.
      - run: sudo apt-get update && sudo apt-get install -y bubblewrap
      - run: bwrap --version
      # The paraphrase debt gate needs a working embedder. Without one,
      # embedLocalBatch degrades, the gate reports "could not run", the
      # paraphrase commits, and probes/debt_paraphrase.ts correctly calls that
      # an escape — so a runner missing these packages fails the build for a
      # missing dependency while looking like a security regression. The model
      # itself is committed under models/minilm/; only the runtime is absent.
      # Hash-pinned for the same reason as in the `test` job.
      - run: python3 -m pip install --quiet --break-system-packages --require-hashes -r scripts/requirements-embed.txt
      - run: python3 scripts/embed_minilm.py "smoke" > /dev/null && echo "embedder OK"
      # Runs every probe and fails if any of them fails. This chained with `;`
      # until 2026-08-05, so the suite's exit status was only the last probe's
      # and a failing gate_audit was invisible.
      # Ubuntu 24.04 blocks unprivileged user namespaces via AppArmor, which is
      # what stops bubblewrap confining anything on a stock runner. This ran
      # AFTER `npm run probes` until 2026-08-08, so the whole suite still
      # executed against a bwrap that could not start — sandbox_escape.ts saw a
      # refusal and printed "no escape detected", a pass. Reintroducing
      # `--ro-bind / /` would not have turned it red. It has to come first, or
      # the probes it enables are the only ones it helps.
      - run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
      - run: npm run probes
      # Demands the other half: the payload must RUN and be contained. A refusal
      # fails this step. `npm run probes` deliberately excludes it, because on a
      # machine with no isolating backend it could only ever fail.
      - run: npm run probes:isolation
      # The demos are the narrative the README quotes, so they run here rather
      # than in `test`: this is the only job with a bubblewrap that confines, so
      # demos/04 exercises the branch where the payload RUNS and is contained.
      # Everywhere else it can only show the refusal. A demo that drifts from
      # what the tool does is worse than no demo, so a failure is a red build.
      - run: npm run demos

  # `npm audit` reads package-lock.json, so it covers the toolchain that
  # `npm ci` installs (eslint, typescript, the Slack and Discord gateways).
  # Runtime dependencies are deliberately empty, which is why this is a
  # separate job from the image scan below: the two see different things.
  # A new advisory published against an unchanged lockfile turns this red by
  # itself. That is the job working, not flaking: fix it with `npm audit fix`.
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npm audit --audit-level=high

  # Secret scan over the whole history, not the diff. A credential removed in a
  # later commit is still in every clone, so the scan has to read what a clone
  # reads. gitleaks reads .gitleaksignore from the repository root.
  #
  # The gitleaks binary is downloaded and checked against a SHA-256 that is
  # written here, instead of using gitleaks/gitleaks-action. As of v3.0.0 that
  # action scans only the commit range of the event (`--no-merges --first-parent
  # base^..head`), not the history, and fetches gitleaks 8.24.3 at run time with
  # no checksum. Neither is a scan of what a clone contains.
  #
  # To move to a newer gitleaks: download gitleaks_<version>_linux_x64.tar.gz and
  # gitleaks_<version>_checksums.txt from the release, confirm the tarball's hash
  # against that file, then update both values below together.
  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          fetch-depth: 0
      - name: Install gitleaks 8.30.1
        env:
          GITLEAKS_VERSION: '8.30.1'
          GITLEAKS_SHA256: 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
        run: |
          set -euo pipefail
          curl -fsSL -o "$RUNNER_TEMP/gitleaks.tar.gz" \
            "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
          echo "${GITLEAKS_SHA256}  $RUNNER_TEMP/gitleaks.tar.gz" | sha256sum --check --strict -
          mkdir -p "$RUNNER_TEMP/gitleaks-bin"
          tar -xzf "$RUNNER_TEMP/gitleaks.tar.gz" -C "$RUNNER_TEMP/gitleaks-bin" gitleaks
          echo "$RUNNER_TEMP/gitleaks-bin" >> "$GITHUB_PATH"
      - run: gitleaks version
      # --exit-code 2 is gitleaks' own "leaks found"; 1 is "the tool failed".
      # Both fail the job. Output is redacted: a CI log is not a safe place for
      # the value that was just found.
      - run: gitleaks git --redact --no-banner --verbose --exit-code 2 .

  # The image was the one part of this project nothing scanned. npm audit and
  # Dependabot read package.json, and runtime dependencies here are
  # deliberately empty -- so both reported a clean project while the base
  # carried 62 HIGH/CRITICAL CVEs. A dependency gate that cannot see the
  # operating system is not an image gate.
  image:
    name: image (${{ matrix.name }})
    runs-on: ubuntu-latest
    strategy:
      # Both images are always scanned: a red first image must not hide what is
      # in the second.
      fail-fast: false
      matrix:
        include:
          # The stdio MCP image that directory checkers build and start.
          - name: stdio
            dockerfile: Dockerfile
          # The HTTP runtime image.
          - name: deploy
            dockerfile: deploy/Dockerfile
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      # Built locally and never pushed: the point is to scan what each
      # Dockerfile produces, not what a registry happens to hold.
      - run: docker build -f "${{ matrix.dockerfile }}" -t "chamber:ci-${{ matrix.name }}" .
      # --ignore-unfixed is the whole policy, and it is a tradeoff worth naming.
      # The base carries 56 HIGH/CRITICAL with NO fix available upstream,
      # including 4 CRITICAL (zlib's is marked will_not_fix). Failing on those
      # would make this job red on the day it was added and red every day
      # after, which is the failure this repo keeps fixing elsewhere: an alarm
      # that always fires is one its reader learns to wave through. So the gate
      # blocks on what an operator can actually act on -- a CVE with a fix --
      # and the unfixable remainder is printed below and recorded in
      # docs/KNOWN_LIMITATIONS.md rather than silently dropped.
      #
      # Measured 2026-09-13: 6 fixable HIGH before the Dockerfile's apt upgrade
      # and npm removal, 0 after. This job going red therefore means something
      # newly actionable appeared, not that the baseline drifted.
      - uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: chamber:ci-${{ matrix.name }}
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: '1'
          format: table
      # Runs even when the gate above passes, so the unfixable set stays
      # visible instead of becoming folklore. `if: always()` is deliberate: on
      # a red build this is the context needed to read the failure.
      - if: always()
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: chamber:ci-${{ matrix.name }}
          severity: HIGH,CRITICAL
          # The inverse of the gate above: everything, fix or no fix. exit-code
          # 0 because this step reports, it does not judge.
          ignore-unfixed: false
          exit-code: '0'
          format: table
          output: unfixed-${{ matrix.name }}.txt
      - if: always()
        run: |
          # A report step that publishes nothing still exits 0: `cat` of an
          # empty file succeeds, and the summary is not something a build
          # failure would ever point at. So the step asserts its own output
          # exists and is non-empty -- without this, "the unfixable set stays
          # visible" is a claim the workflow never checks.
          if [ ! -s unfixed-${{ matrix.name }}.txt ]; then
            echo "trivy wrote no report to unfixed-${{ matrix.name }}.txt -- the image summary would have been empty" >&2
            exit 1
          fi
          {
            echo "### Image CVEs (${{ matrix.name }}), including those with no fix available"
            echo
            echo 'The `image` job blocks only on CVEs with a fix. This is the'
            echo 'full HIGH/CRITICAL set, unfixable included.'
            echo
            echo '```'
            cat unfixed-${{ matrix.name }}.txt
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"
````

Write `.github/dependabot.yml`:

```yaml
# Weekly update PRs for the three things that were pinned by hand and then left
# to age: the npm lockfile, the GitHub Actions (pinned by SHA, which Dependabot
# keeps updating together with the trailing version comment), and the two
# Dockerfile bases. Each Dockerfile lives in its own directory, so each gets its
# own entry.
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
  - package-ecosystem: docker
    directory: /
    schedule:
      interval: weekly
  - package-ecosystem: docker
    directory: /deploy
    schedule:
      interval: weekly
```

Note for the report: the `image` job is now named `image (stdio)` and `image (deploy)`. If branch protection requires a check literally named `image`, the owner must update it; say so.

- [ ] **Step 7: Replace the root `Dockerfile`**

Write `Dockerfile` with exactly this content (the only changes from `ccdf148` are the two `RUN` blocks and their comments, copied from `deploy/Dockerfile`'s approach):

```dockerfile
# Runs the Chamber MCP server over stdio. Exists so directory checkers
# (Glama and similar) can start the server and introspect it; local installs
# don't need Docker at all.
#
#   docker build -t chamber .
#   docker run -i --rm chamber
#
# Node 24 satisfies the 23.6+ floor (built-in TypeScript type stripping).
# There are zero runtime dependencies, so there is no npm install step.
FROM node:24-slim

# The base's own packages carry security fixes the published tag predates, so
# upgrade them here rather than waiting for a new tag. This is the same step
# deploy/Dockerfile has, for the same reason: the ci `image` job scans this
# image too and gates on any HIGH/CRITICAL that has a fix.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# npm is never used at runtime: there are zero runtime dependencies, nothing in
# this image runs an install step, and CMD is plain node. Shipping npm meant
# carrying its bundled brace-expansion and other node packages for no runtime
# benefit. Deleting the surface beats patching it. If a future change needs npm
# INSIDE the container, restore it in a builder stage and keep it out of the
# final one, rather than reinstating it here.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

WORKDIR /app
COPY bin/ bin/
COPY src/ src/
COPY sql/ sql/
COPY scripts/ scripts/
COPY package.json ./
# initialize and tools/list respond before any config exists; tool calls
# resolve config on first use (CHAMBER_* env vars or a mounted config file).

# node:24-slim ships an unprivileged `node` user (uid 1000) with its own
# $HOME, which is where the database lands on first tool call — the copied
# sources are only ever read, so no ownership change is needed. Root bought
# nothing here and cost a container-escape precondition (trivy DS-0002).
USER node

CMD ["node", "--experimental-strip-types", "src/mcp_server.ts"]
```

- [ ] **Step 8: Run the test, lint the workflow, parse the YAML**

```bash
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep "CI pins\|passed"
actionlint -ignore 'SC2016' .github/workflows/ci.yml; echo "actionlint exit: $?"
python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(list(d['jobs'])); yaml.safe_load(open('.github/dependabot.yml')); print('yaml ok')"
```

Expected: the test `[PASS]`; `actionlint exit: 0`; the job list `['test', 'lint', 'typecheck', 'probes', 'audit', 'secrets', 'image']` and `yaml ok`. (`SC2016` is ignored because `ccdf148`'s own `image` job already trips that info-level shellcheck rule on a backtick inside single quotes; it is not new.)

- [ ] **Step 9: Verify the images (B2)**

Skip with `NOT RUN` if `docker` or `trivy` is missing. This builds locally and pushes nothing.

```bash
D=$(mktemp -d)
git show HEAD:Dockerfile > "$D/Dockerfile.before"

# before: the Dockerfile at HEAD
docker build -q -f "$D/Dockerfile.before" -t chamber-stdio:before .
trivy image --quiet --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --format table chamber-stdio:before > "$D/before.txt"
echo "before: trivy exit $?"; tail -12 "$D/before.txt"

# after: the new Dockerfile
docker build -q -f Dockerfile -t chamber-stdio:after .
trivy image --quiet --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --format table chamber-stdio:after > "$D/after.txt"
echo "after: trivy exit $?"; tail -12 "$D/after.txt"

# the deploy image is unchanged and must stay clean
docker build -q -f deploy/Dockerfile -t chamber-deploy:after .
trivy image --quiet --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --format table chamber-deploy:after > "$D/deploy.txt"
echo "deploy: trivy exit $?"; tail -6 "$D/deploy.txt"

# the stdio server still starts and answers
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  | timeout 30 docker run -i --rm chamber-stdio:after | head -c 200; echo

docker rmi chamber-stdio:before chamber-stdio:after chamber-deploy:after >/dev/null
rm -rf "$D"
```

Expected: `before: trivy exit 1` with fixable HIGH findings in `Node.js (node-pkg)` (on 2026-10-21 these were `brace-expansion` twice and `undici`; the exact CVEs drift with the vulnerability database, and `before` could in principle come back clean on a later day, in which case say so and rely on the guard test as the evidence for the Dockerfile); `after: trivy exit 0` and `deploy: trivy exit 0` with every row `0`; and the `initialize` reply naming `"serverInfo":{"name":"chamber","version":"0.1.9"}`. If `after` is not 0, stop and report the findings verbatim.

`timeout` may not exist on macOS; if `command -v timeout` is empty, drop it from that one line.

- [ ] **Step 10: Check the secret scanner and its detector**

```bash
GL=$(mktemp)
gitleaks git --redact --no-banner --exit-code=2 . > "$GL" 2>&1; echo "gitleaks git exit: $?"; tail -2 "$GL"; rm -f "$GL"
```

Expected: the final line `no leaks found`, exit 0. Then prove the detector can find something, using an uncommitted file in a scratch directory (a committed plant would be blocked by the global pre-commit hook, which is the right behaviour and not something to route around):

```bash
P=$(mktemp -d)
printf 'token = "ghp_%s"\n' "$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 36)" > "$P/plant.txt"
gitleaks dir --redact --no-banner --exit-code=2 "$P" > "$P/out.txt" 2>&1; echo "gitleaks dir exit on the plant: $?"; tail -1 "$P/out.txt"
rm -rf "$P"
```

Expected: `leaks found: 1` and exit 2. If the plant is not found, the scan above proves nothing: stop and report.

- [ ] **Step 11: Run the four gates**

As in Global Constraints. Expected: same as the baseline, plus the new `config` test passing.

- [ ] **Step 12: Commit**

```bash
git status --short     # Dockerfile, .github/dependabot.yml, .github/workflows/ci.yml, scripts/requirements-embed.in, scripts/requirements-embed.txt, tests/harness.ts only
git add Dockerfile .github/dependabot.yml .github/workflows/ci.yml scripts/requirements-embed.in scripts/requirements-embed.txt tests/harness.ts
git commit -m "ci: hash-pin the embedder's Python, audit and scan history, scan both images

- scripts/requirements-embed.txt pins numpy, onnxruntime, tokenizers and their
  dependencies with hashes; both CI installs use --require-hashes.
- New audit job (npm audit --audit-level=high) and secrets job (gitleaks 8.30.1
  over the full history, tarball checked against a SHA-256).
- The image job is a matrix over Dockerfile and deploy/Dockerfile with the same
  trivy gate. The root Dockerfile gets deploy/Dockerfile's apt-get upgrade and
  npm/npx/corepack removal.
- Dependabot: npm, github-actions and docker (/ and /deploy), weekly.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 13: Mutation proofs**

The guard test, five ways (each: edit, run, expect the named message, then restore):

```bash
run() { node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -A1 "FAIL.*CI pins"; }

# (a) the old workflow
git show HEAD~1:.github/workflows/ci.yml > .github/workflows/ci.yml; run; git checkout -- .github/workflows/ci.yml
# expect: pip install without --require-hashes from the pinned file

# (b) drop deploy/Dockerfile from the matrix
sed -i.bak 's#dockerfile: deploy/Dockerfile#dockerfile: Dockerfile#' .github/workflows/ci.yml; rm .github/workflows/ci.yml.bak; run; git checkout -- .github/workflows/ci.yml
# expect: the image job does not build deploy/Dockerfile

# (c) pin an action by tag
sed -i.bak '0,/actions\/checkout@[0-9a-f]\{40\} # v4/s//actions\/checkout@v4/' .github/workflows/ci.yml; rm .github/workflows/ci.yml.bak; run; git checkout -- .github/workflows/ci.yml
# expect: action not pinned by a full commit SHA: actions/checkout@v4

# (d) drop the /deploy docker entry
sed -i.bak 's#directory: /deploy#directory: /nope#' .github/dependabot.yml; rm .github/dependabot.yml.bak; run; git checkout -- .github/dependabot.yml
# expect: dependabot.yml has no weekly docker entry for /deploy

# (e) strip the hashes of one package
python3 - <<'EOF'
out, skip = [], False
for line in open("scripts/requirements-embed.txt").read().split("\n"):
    if line.startswith("tqdm=="): skip = True; out.append(line); continue
    if skip and line.strip().startswith("--hash"): continue
    skip = False
    out.append(line)
open("scripts/requirements-embed.txt", "w").write("\n".join(out))
EOF
run; git checkout -- scripts/requirements-embed.txt
# expect: tqdm is pinned without a hash
git diff --stat
```

If your `sed` rejects the `0,/re/` address (BSD sed on macOS does), do (c) with `python3 -c` and `re.sub(..., count=1)` instead; the effect to produce is one `actions/checkout@v4` in place of its SHA. Expected at the end: five different failure messages as annotated, and an empty `git diff --stat`.

The Dockerfile fix is proved by Step 9's `before` run (red) against its `after` run (green). The pip hashes are proved by the container run below; skip with `NOT RUN` if `docker` is missing:

```bash
docker run --rm --platform linux/amd64 -v "$PWD/scripts:/req:ro" ubuntu:24.04 bash -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq python3 python3-pip >/dev/null 2>&1
  python3 --version
  python3 -m pip install --quiet --break-system-packages --require-hashes -r /req/requirements-embed.txt 2>&1 | grep -v WARNING
  echo "good lock: pip exit ${PIPESTATUS[0]}"
  sed "s/--hash=sha256:/--hash=sha256:0/" /req/requirements-embed.txt > /tmp/bad.txt
  python3 -m pip install --quiet --break-system-packages --require-hashes -r /tmp/bad.txt 2>&1 | grep -v WARNING | head -3
  echo "altered hashes: pip exit ${PIPESTATUS[0]}"'
```

Expected: `Python 3.12.3`; `good lock: pip exit 0`; then `ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE` and `altered hashes: pip exit 1`.

**Not caught by the gates:**
- The `audit`, `secrets` and `image` jobs and the `--require-hashes` install on the real runner can only be exercised by CI. Nothing here proves `ubuntu-latest` still has a Python for which the pinned wheels exist; the lock covers CPython 3.12 to 3.14 on x86_64, and a runner outside that range fails loudly (no matching distribution), not silently.
- `audit` can turn red on an unchanged lockfile when a new advisory is published. That is intended; say so in the PR description.
- The local trivy run is on this machine's architecture (arm64 on the plan author's Mac), CI is x86_64. The package set is the same; the evidence for CI is the CI run.
- `gitleaks git` on `ccdf148`'s history ends `no leaks found` without needing `.gitleaksignore`; the file is still honoured by gitleaks when a fingerprint appears.

---

### Task 3: MiniLM weights are checked before loading (B4)

**Files:**
- Modify (whole file): `scripts/embed_minilm.py`
- Modify: `tests/harness.ts` (four new `config` tests)

**Interfaces:**
- Consumes: `models/minilm/VERSION`, whose `SHA-256:` line (64 hex digits) is the expected hash of `model_quantized.onnx`. Do not edit that file.
- Produces: exit code `3` and one stderr line from `scripts/embed_minilm.py` in every mode when the weights are refused; the env var `CHAMBER_MINILM_DIR` (a test seam: the directory holding `model_quantized.onnx`, `tokenizer.json` and `VERSION`; default `models/minilm` next to the script). `src/embedder.ts` is **not** changed: `embedLocal` already degrades to hash vectors on a failed probe, and `embedLocalBatch` / `embedMinilmBatch` already throw `embed_minilm failed (3): ...`. The tests assert both.

**Behaviour to implement.** `_load()` and both entry points compute the SHA-256 of `model_quantized.onnx` in 1 MiB blocks and compare it with `models/minilm/VERSION`'s `SHA-256:` line. A mismatch, an unreadable or missing `VERSION`, or a `VERSION` with no 64-hex-digit `SHA-256:` line exits `3` with one stderr line, before the model is loaded. The check runs in `--serve` and in the one-shot and `--json` modes before the first reply, and before `numpy`, `onnxruntime` or `tokenizers` is imported (so the refusal needs none of them). The argv-length refusal (exit 2) still comes first.

- [ ] **Step 1: Write the failing tests**

`Edit` on `tests/harness.ts`: `old_string` `// ─── cli process smoke tests`, `new_string` the block below followed by `// ─── cli process smoke tests`. (`symlinkSync`, `spawnSync`, `minilmAvailable`, `embedLocal`, `embedLocalBatch` and `resetMinilmProbe` are already imported by the harness.)

```ts
// ─── MiniLM weights are checked before they are loaded ──────────────────────

/**
 * A model directory the embedder can be pointed at with CHAMBER_MINILM_DIR.
 * The weights and tokenizer are symlinks to the real files, so nothing is
 * copied; VERSION is a real file. `version` is the text to write there, or
 * null for no VERSION file at all.
 */
function minilmDirWithVersion(version: string | null): string {
  const real = fileURLToPath(new URL("../models/minilm", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "chamber-minilm-dir-"));
  symlinkSync(join(real, "model_quantized.onnx"), join(dir, "model_quantized.onnx"));
  symlinkSync(join(real, "tokenizer.json"), join(dir, "tokenizer.json"));
  if (version !== null) writeFileSync(join(dir, "VERSION"), version);
  return dir;
}

/** The real VERSION text with the first hex digit of its SHA-256 changed. */
function tamperedVersion(): { text: string; expected: string; actualDigest: string } {
  const real = readFileSync(fileURLToPath(new URL("../models/minilm/VERSION", import.meta.url)), "utf8");
  const m = /^SHA-256:\s*([0-9a-f]{64})\s*$/m.exec(real);
  assert(m !== null, "models/minilm/VERSION has no SHA-256 line");
  const digest = m[1]!;
  const wrong = (digest[0] === "0" ? "1" : "0") + digest.slice(1);
  return { text: real.replace(digest, wrong), expected: wrong, actualDigest: digest };
}

const EMBED_SCRIPT = fileURLToPath(new URL("../scripts/embed_minilm.py", import.meta.url));

function runEmbedScript(
  dir: string,
  args: readonly string[],
  input?: string,
  pythonFlags: readonly string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("python3", [...pythonFlags, EMBED_SCRIPT, ...args], {
    encoding: "utf8",
    input,
    timeout: 120_000,
    env: { ...process.env, CHAMBER_MINILM_DIR: dir },
  });
  assert(r.error === undefined, `python3 did not run: ${r.error}`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("config", "weights that do not match VERSION exit 3 in every mode, naming both hashes", () => {
  const bad = tamperedVersion();
  const dir = minilmDirWithVersion(bad.text);
  try {
    for (const [label, args, input] of [
      ["one-shot", ["a sentence"], undefined],
      ["--json -", ["--json", "-"], '["a sentence"]'],
      ["--serve", ["--serve"], '["a sentence"]\n'],
    ] as const) {
      const r = runEmbedScript(dir, args, input);
      assert(r.status === 3, `${label}: exit ${r.status}, stderr ${r.stderr}`);
      assert(r.stdout === "", `${label}: wrote a reply before refusing: ${r.stdout}`);
      const lines = r.stderr.trim().split("\n");
      assert(lines.length === 1, `${label}: expected one stderr line, got ${lines.length}: ${r.stderr}`);
      assert(
        lines[0]!.includes(bad.actualDigest) && lines[0]!.includes(bad.expected),
        `${label}: the line must name both hashes: ${lines[0]}`,
      );
    }
    // The hash is checked before numpy and onnxruntime are imported, so the
    // refusal needs neither installed.
    const traced = runEmbedScript(dir, ["a sentence"], undefined, ["-X", "importtime"]);
    assert(traced.status === 3, `importtime run: exit ${traced.status}`);
    assert(
      !traced.stderr.includes("numpy") && !traced.stderr.includes("onnxruntime"),
      "the script imported numpy or onnxruntime before checking the weights",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config", "a missing VERSION or a VERSION without a SHA-256 line also exits 3", () => {
  for (const [label, version, want] of [
    ["missing VERSION", null, "cannot read"],
    ["no SHA-256 line", "File: model_quantized.onnx\nSize: 22972370 bytes\n", "no SHA-256 line"],
    ["short digest", "SHA-256:  afdb6f1a0e45b715d0bb9b11772f032c\n", "no SHA-256 line"],
  ] as const) {
    const dir = minilmDirWithVersion(version);
    try {
      const r = runEmbedScript(dir, ["a sentence"]);
      assert(r.status === 3, `${label}: exit ${r.status}, stderr ${r.stderr}`);
      assert(r.stderr.includes(want) && r.stderr.includes("VERSION"), `${label}: ${r.stderr}`);
      assert(r.stdout === "", `${label}: wrote a reply before refusing`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("config", "the real model directory passes the weights check", () => {
  // Same files, VERSION untouched: the check lets it through. Where an
  // embedder runs here it must also answer; where numpy or onnxruntime is
  // missing the script fails later and differently, which is not exit 3.
  const dir = minilmDirWithVersion(
    readFileSync(fileURLToPath(new URL("../models/minilm/VERSION", import.meta.url)), "utf8"),
  );
  try {
    const r = runEmbedScript(dir, ["a sentence"]);
    assert(r.status !== 3 && !r.stderr.includes("SHA-256"), `refused the real weights: ${r.stderr}`);
    if (minilmAvailable()) {
      assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
      assert((JSON.parse(r.stdout) as number[]).length === 384, "expected a 384-dimension vector");
    }
    const plain = spawnSync("python3", [EMBED_SCRIPT, "a sentence"], { encoding: "utf8", timeout: 120_000 });
    assert(plain.status !== 3, `the default model directory was refused: ${plain.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config", "failed weights degrade embedLocal and make the batch path throw", () => {
  const dir = minilmDirWithVersion(tamperedVersion().text);
  const saved = process.env.CHAMBER_MINILM_DIR;
  const savedKind = process.env.CHAMBER_EMBEDDER;
  const savedWrite = process.stderr.write;
  process.env.CHAMBER_MINILM_DIR = dir;
  delete process.env.CHAMBER_EMBEDDER;
  // The one-time fallback warning is the point of the behaviour, not noise to
  // print into the test log.
  let warned = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    warned += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  resetMinilmProbe();
  try {
    const single = embedLocal("a sentence", "auto");
    assert(single.kind === "hash", `embedLocal did not degrade: ${single.kind}`);
    assert(warned.includes("SHA-256"), `the degradation did not say why: ${warned}`);
    let batch = "";
    try {
      embedLocalBatch(["a sentence"], "minilm");
    } catch (e) {
      batch = e instanceof Error ? e.message : String(e);
    }
    assert(batch.includes("embed_minilm failed (3)"), `the batch path did not throw the exit 3: ${batch}`);
  } finally {
    process.stderr.write = savedWrite;
    if (saved === undefined) delete process.env.CHAMBER_MINILM_DIR;
    else process.env.CHAMBER_MINILM_DIR = saved;
    if (savedKind !== undefined) process.env.CHAMBER_EMBEDDER = savedKind;
    resetMinilmProbe();
    rmSync(dir, { recursive: true, force: true });
  }
});

```

- [ ] **Step 2: Run them and see them fail**

```bash
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -A2 "FAIL"
```

Expected three failures: `weights that do not match VERSION exit 3 in every mode, naming both hashes` (`one-shot: exit 0`), `a missing VERSION or a VERSION without a SHA-256 line also exits 3` (`missing VERSION: exit 0`), and `failed weights degrade embedLocal and make the batch path throw` (`embedLocal did not degrade: minilm`). `the real model directory passes the weights check` passes already. (The script does not know `CHAMBER_MINILM_DIR` yet, so it ignores it and loads the good weights; that is why the exit is 0.) This needs a `python3` on `PATH`. If it has no `onnxruntime`, the first two fail with `exit 1` instead of `exit 0`; that is still red.

- [ ] **Step 3: Replace `scripts/embed_minilm.py`**

Write the whole file with exactly this content. Relative to `ccdf148` it adds the module docstring paragraph on exit 3, the imports `hashlib`, `os`, `re` and `NoReturn`, `MODEL_DIR` reading `CHAMBER_MINILM_DIR`, `verify_weights()` with its helpers, and the three `verify_weights()` calls (in `_load`, `serve` and `main`); nothing else moves.

```python
#!/usr/bin/env python3
"""Local MiniLM embeddings via ONNX Runtime (all-MiniLM-L6-v2 quantized).

Usage:
  python3 embed_minilm.py "single text"
  python3 embed_minilm.py --json '["a","b"]'     # JSON array of strings → JSON array of vectors
  python3 embed_minilm.py --json -                # same, JSON array on stdin
  python3 embed_minilm.py --serve                 # one JSON array per stdin line

Arguments longer than 2048 characters are refused before the model is imported.
Page text must not sit on the process command line, where `pgrep -f` copies it
into a model transcript.

Stdout: JSON float arrays. Stderr: logs.

Exit status 3: the model weights were not loaded because they are not the ones
models/minilm/VERSION records -- the SHA-256 differs, VERSION is missing, or it
has no SHA-256 line. The check runs in every mode, before the first reply and
before numpy or onnxruntime is imported.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import NoReturn

# Imported in _import_stack(), after the argv length check, so a long argument
# is refused on a machine with no model installed.
np = None
ort = None
Tokenizer = None

ROOT = Path(__file__).resolve().parents[1]
# CHAMBER_MINILM_DIR exists so a test can point this script at a copy of the
# model directory with a doctored VERSION. It is not a configuration surface:
# whatever directory it names is held to the same rule, that the weights must
# match the SHA-256 in that directory's own VERSION file.
MODEL_DIR = Path(os.environ.get("CHAMBER_MINILM_DIR") or ROOT / "models" / "minilm")
ONNX_PATH = MODEL_DIR / "model_quantized.onnx"
TOK_PATH = MODEL_DIR / "tokenizer.json"

# all-MiniLM-L6-v2's trained sequence length. Inputs longer than this lose
# their tail; see report_truncation below, which makes that loss visible
# instead of leaving it to be discovered by a query that finds nothing.
MAX_TOKENS = 256

_session: ort.InferenceSession | None = None
_tokenizer: Tokenizer | None = None
_measurer: Tokenizer | None = None


EXIT_WEIGHTS_REFUSED = 3
VERSION_PATH = MODEL_DIR / "VERSION"
# models/minilm/VERSION records the hash as `SHA-256:  <64 hex digits>`.
_SHA256_LINE = re.compile(r"^SHA-256:\s*([0-9a-fA-F]{64})\s*$", re.MULTILINE)
_weights_verified = False


def _refuse_weights(reason: str) -> NoReturn:
    print(f"embed_minilm: {reason}; not loading {ONNX_PATH.name}", file=sys.stderr)
    sys.exit(EXIT_WEIGHTS_REFUSED)


def verify_weights() -> None:
    """Refuse to load model_quantized.onnx unless it matches VERSION's SHA-256.

    These weights feed retrieval, which feeds the citation-pin path, and they
    are a 23 MB binary that onnxruntime parses. VERSION has always recorded the
    hash; nothing ever compared it. Streamed, so the file is not held in memory,
    and done once per process.

    Exit 3, one stderr line, and no model loaded when the hash differs, VERSION
    is missing, or VERSION has no SHA-256 line. This runs before numpy and
    onnxruntime are imported, so it needs neither.
    """
    global _weights_verified
    if _weights_verified:
        return
    if not ONNX_PATH.is_file():
        raise SystemExit(f"missing model: {ONNX_PATH}")
    try:
        version_text = VERSION_PATH.read_text(encoding="utf-8")
    except OSError as e:
        _refuse_weights(f"cannot read {VERSION_PATH} ({e.strerror or e})")
    match = _SHA256_LINE.search(version_text)
    if match is None:
        _refuse_weights(f"{VERSION_PATH} has no SHA-256 line with 64 hex digits")
    expected = match.group(1).lower()
    digest = hashlib.sha256()
    with ONNX_PATH.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    actual = digest.hexdigest()
    if actual != expected:
        _refuse_weights(
            f"{ONNX_PATH} has SHA-256 {actual}, but {VERSION_PATH} records {expected}"
        )
    _weights_verified = True


def _load() -> tuple[ort.InferenceSession, Tokenizer]:
    global _session, _tokenizer
    verify_weights()
    if _session is None:
        if not ONNX_PATH.is_file():
            raise SystemExit(f"missing model: {ONNX_PATH}")
        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 2
        _session = ort.InferenceSession(
            str(ONNX_PATH), sess_options=so, providers=["CPUExecutionProvider"]
        )
    if _tokenizer is None:
        if not TOK_PATH.is_file():
            raise SystemExit(f"missing tokenizer: {TOK_PATH}")
        _tokenizer = Tokenizer.from_file(str(TOK_PATH))
        # 256 is all-MiniLM-L6-v2's own trained max_seq_length, not a number
        # picked here -- so this is the model's limit, not a cap worth raising.
        # It is set explicitly because tokenizer.json ships truncation at 128:
        # without these two lines every passage would silently lose everything
        # past 128 tokens, which is half of what the model can actually read.
        _tokenizer.enable_truncation(max_length=MAX_TOKENS)
        _tokenizer.enable_padding(length=MAX_TOKENS)
    return _session, _tokenizer


def _measuring_tokenizer() -> Tokenizer:
    """A second tokenizer with no truncation, used only to measure overflow.

    The embedding tokenizer cannot answer "how long was this really": it has
    already truncated, so every oversized input reports exactly MAX_TOKENS and
    a passage losing 4 tokens is indistinguishable from one losing 370.
    """
    global _measurer
    if _measurer is None:
        _measurer = Tokenizer.from_file(str(TOK_PATH))
        _measurer.no_truncation()
        _measurer.no_padding()
    return _measurer


def mean_pool(last_hidden: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    """Mean pool over tokens with attention mask, then L2-normalize."""
    # last_hidden: (batch, seq, hidden)
    mask = attention_mask.astype(np.float32)[:, :, None]  # (b, s, 1)
    summed = (last_hidden * mask).sum(axis=1)
    counts = np.clip(mask.sum(axis=1), a_min=1e-9, a_max=None)
    emb = summed / counts
    norms = np.linalg.norm(emb, axis=1, keepdims=True)
    norms = np.clip(norms, a_min=1e-9, a_max=None)
    return emb / norms


def report_truncation(texts: list[str], enc: list) -> None:
    """Announce, on stderr, any input whose tail was dropped.

    Truncation at MAX_TOKENS is correct -- it is what the model was trained
    for -- but doing it silently is not. A passage that loses its second half
    still embeds to a perfectly valid vector, still verifies (pins hash the
    stored body, not the vector), and still counts toward the passage total.
    The only symptom is a query that cannot find something the corpus
    visibly contains, which reads as the retrieval being bad rather than as
    the text never having been indexed.

    Measured over one real 43,541-passage corpus on 2026-09-13: 541 passages
    (1.24%) exceeded the limit and 80,989 tokens were dropped in total, the
    worst single passage losing 370 of its 626. Narrow, but not nothing, and
    invisible until counted.

    Stderr because stdout is the vector protocol. One summary line per
    embed_texts call, not one per passage: an ingest of 43k passages must not emit
    43k lines, and the count is what an operator acts on.
    """
    filled = [i for i, e in enumerate(enc) if sum(e.attention_mask) >= MAX_TOKENS]
    if not filled:
        return
    measurer = _measuring_tokenizer()
    over = []
    for i in filled:
        true_len = len(measurer.encode(texts[i]).ids)
        if true_len > MAX_TOKENS:
            over.append(true_len)
    if not over:
        return
    print(
        json.dumps(
            {
                "chamber_truncation": {
                    "limit": MAX_TOKENS,
                    "passages": len(over),
                    "of": len(texts),
                    "tokens_dropped": sum(n - MAX_TOKENS for n in over),
                    "longest": max(over),
                }
            }
        ),
        file=sys.stderr,
    )
    sys.stderr.flush()


def embed_texts(texts: list[str]) -> list[list[float]]:
    session, tokenizer = _load()
    enc = tokenizer.encode_batch(texts)
    report_truncation(texts, enc)
    input_ids = np.array([e.ids for e in enc], dtype=np.int64)
    attention_mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
    token_type_ids = np.zeros_like(input_ids, dtype=np.int64)

    inputs = {}
    for inp in session.get_inputs():
        name = inp.name
        if "input_ids" in name:
            inputs[name] = input_ids
        elif "attention_mask" in name:
            inputs[name] = attention_mask
        elif "token_type" in name:
            inputs[name] = token_type_ids

    outs = session.run(None, inputs)
    # first output is last_hidden_state
    last_hidden = outs[0]
    pooled = mean_pool(last_hidden, attention_mask)
    return pooled.astype(np.float32).tolist()


ARGV_LIMIT = 2048
ARGV_REFUSAL = (
    "refusing an argument longer than "
    f"{ARGV_LIMIT} characters; pass the JSON array on stdin: --json -"
)


def _import_stack() -> None:
    global np, ort, Tokenizer
    import numpy as np  # noqa: PLC0415
    import onnxruntime as ort  # noqa: PLC0415
    from tokenizers import Tokenizer as _Tokenizer  # noqa: PLC0415

    Tokenizer = _Tokenizer


def serve() -> None:
    """One model load, then one JSON reply per stdin line."""
    verify_weights()
    _import_stack()
    while True:
        raw = sys.stdin.buffer.readline()
        if raw == b"":
            return
        if raw.endswith(b"\n"):
            raw = raw[:-1]
        try:
            texts = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise SystemExit("expected JSON array")
        if not isinstance(texts, list):
            raise SystemExit("expected JSON array")
        vecs = embed_texts([str(t) for t in texts])
        sys.stderr.flush()
        json.dump(vecs, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()


def main() -> None:
    if len(sys.argv) < 2:
        print(
            "usage: embed_minilm.py <text> | --json '[\"a\",\"b\"]' | --json - | --serve",
            file=sys.stderr,
        )
        sys.exit(2)
    if any(len(a) > ARGV_LIMIT for a in sys.argv[1:]):
        print(ARGV_REFUSAL, file=sys.stderr)
        sys.exit(2)
    if sys.argv[1] == "--serve":
        serve()
        return
    verify_weights()
    _import_stack()
    if sys.argv[1] == "--json":
        if len(sys.argv) < 3:
            raise SystemExit("usage: --json '<array>' | --json -")
        raw = sys.stdin.read() if sys.argv[2] == "-" else sys.argv[2]
        texts = json.loads(raw)
        if not isinstance(texts, list):
            raise SystemExit("expected JSON array")
        vecs = embed_texts([str(t) for t in texts])
        json.dump(vecs, sys.stdout)
        sys.stdout.write("\n")
        return
    text = " ".join(sys.argv[1:])
    vecs = embed_texts([text])
    json.dump(vecs[0], sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests and see them pass**

```bash
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -c "\[PASS\]"
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep "FAIL\|passed"
python3 scripts/embed_minilm.py "smoke" | head -c 60; echo
```

Expected: no `FAIL`, a last line `N/N passed · 0 failed`, and the last command prints the start of a JSON float array (the real directory loads). Also try the three entry points by hand against a doctored copy, and read the one line each prints:

```bash
D=$(mktemp -d)
ln -s "$PWD/models/minilm/model_quantized.onnx" "$D/model_quantized.onnx"
ln -s "$PWD/models/minilm/tokenizer.json" "$D/tokenizer.json"
sed 's/^SHA-256:  a/SHA-256:  b/' models/minilm/VERSION > "$D/VERSION"
CHAMBER_MINILM_DIR="$D" python3 scripts/embed_minilm.py "x";                    echo "one-shot exit $?"
echo '["x"]' | CHAMBER_MINILM_DIR="$D" python3 scripts/embed_minilm.py --json -; echo "--json exit $?"
echo '["x"]' | CHAMBER_MINILM_DIR="$D" python3 scripts/embed_minilm.py --serve;   echo "--serve exit $?"
rm -rf "$D"
```

Expected: each prints one line naming both hashes (`... has SHA-256 afdb6f1a... but ...VERSION records bfdb6f1a...; not loading model_quantized.onnx`) and exits 3, and nothing is written to stdout.

- [ ] **Step 5: Run the four gates, then commit**

```bash
git status --short     # scripts/embed_minilm.py and tests/harness.ts only
git add scripts/embed_minilm.py tests/harness.ts
git commit -m "fix: refuse MiniLM weights that do not match models/minilm/VERSION

VERSION has always recorded the SHA-256 of model_quantized.onnx and nothing
compared it. embed_minilm.py now streams the hash and exits 3 with one stderr
line when it differs, when VERSION is missing, or when it has no SHA-256 line,
in every mode and before numpy/onnxruntime are imported. embedLocal degrades
and the batch path throws exactly as for any other embedder failure.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Mutation proofs**

```bash
run() { node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -A1 "FAIL"; }

# (a) no check at all: the script as it was
git show HEAD~1:scripts/embed_minilm.py > scripts/embed_minilm.py; run; git checkout -- scripts/embed_minilm.py

# (b) the seam stays, the three calls go
python3 - <<'EOF'
p = "scripts/embed_minilm.py"
s = open(p).read()
assert s.count("    verify_weights()\n") == 3, s.count("    verify_weights()\n")
open(p, "w").write(s.replace("    verify_weights()\n", ""))
EOF
run; git checkout -- scripts/embed_minilm.py

# (c) the check runs but compares nothing
python3 - <<'EOF'
p = "scripts/embed_minilm.py"
s = open(p).read()
old = "    if actual != expected:\n"
assert s.count(old) == 1
open(p, "w").write(s.replace(old, "    if False:\n"))
EOF
run; git checkout -- scripts/embed_minilm.py
git diff --stat
```

Expected: (a) and (b) fail `weights that do not match VERSION exit 3 ...` with `one-shot: exit 0`, `a missing VERSION ...` and `failed weights degrade ...`; (c) fails the first test (`one-shot: exit 0`) and the degrade test but **not** the missing-`VERSION` test, which shows the tests distinguish the three refusals. The final `git diff --stat` prints nothing.

**Not caught by the gates:**
- The hash is checked, then `onnxruntime` opens the path again. Someone who can rewrite the weights between the two can also rewrite `VERSION`, so this guards against a damaged or substituted file at rest, not against a local attacker with write access.
- `CHAMBER_MINILM_DIR` points the script at any directory, and that directory is held to its own `VERSION`. It is a test seam and no more; do not document it as a setting.
- `models/minilm/VERSION` itself says `Revision: UNIDENTIFIED`. This check proves the file is the one that was committed, not that it is the upstream export.

---

### Task 4: `chamber-jobs.service` hardening (B6)

**Files:**
- Modify (whole file): `deploy/systemd/chamber-jobs.service`
- Modify: `tests/harness.ts` (one new `config` test)

**Interfaces:** none consumed or produced.

**The sandbox check the spec asks for, already done.** Before adding `SystemCallFilter=@system-service`, the spec requires checking whether `chamber jobs run` can reach `runInSandbox` or bwrap. It cannot. `chamber jobs run` calls `processJobQueue` in `src/job_queue.ts`, whose transitive imports are exactly `src/approvals.ts`, `src/audit.ts`, `src/cron.ts`, `src/expiry.ts`, `src/hash.ts`, `src/job_queue.ts`, `src/memory.ts`, `src/merkle.ts`, `src/merkle_inc.ts` and `src/spend.ts`. None imports `src/sandbox.ts`, `src/tools.ts` or `src/mcp_bridge.ts`, and none imports `node:child_process`. So the filter goes in, and the unit gets a comment saying why it is safe. The new test walks those imports on every run, so the day that stops being true the test fails and the filter has to be revisited (the spec's alternative: leave `SystemCallFilter` out of this unit and say why).

- [ ] **Step 1: Write the failing test**

`Edit` on `tests/harness.ts`: `old_string` `// ─── cli process smoke tests`, `new_string` the block below followed by `// ─── cli process smoke tests`. (`resolve`, `relative`, `dirname`, `join` are already imported from `node:path`.)

```ts
test("config", "chamber-jobs.service keeps the hardening chamber.service has, and the jobs path cannot reach a sandbox", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const unit = readFileSync(join(root, "deploy", "systemd", "chamber-jobs.service"), "utf8");
  const have = new Set(unit.split("\n").map((l) => l.trim()));
  for (const want of [
    "NoNewPrivileges=true",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "LockPersonality=true",
    "RestrictRealtime=true",
    "SystemCallFilter=@system-service",
    "SystemCallErrorNumber=EPERM",
  ]) {
    assert(have.has(want), `chamber-jobs.service lacks ${want}`);
  }

  // SystemCallFilter=@system-service would stop bubblewrap (it needs unshare
  // and mount), so it is only safe on this unit while `chamber jobs run` cannot
  // reach the sandbox or start any child process. Walk the imports of the job
  // queue, the module `jobs run` calls, and fail if that stops being true: the
  // answer is then to revisit the filter, not to delete this test.
  const seen = new Set<string>();
  const stack = [join(root, "src", "job_queue.ts")];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+\.ts)["']/g)) {
      stack.push(resolve(dirname(file), m[1]!));
    }
  }
  const reached = [...seen].map((f) => relative(root, f)).sort();
  for (const forbidden of ["src/sandbox.ts", "src/tools.ts", "src/mcp_bridge.ts"]) {
    assert(!reached.includes(forbidden), `chamber jobs run now reaches ${forbidden}: ${reached.join(", ")}`);
  }
  for (const f of reached) {
    assert(
      !readFileSync(join(root, f), "utf8").includes("node:child_process"),
      `${f} starts child processes and is reachable from chamber jobs run`,
    );
  }
});

```

- [ ] **Step 2: Run it and see it fail**

```bash
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -A1 "FAIL"
```

Expected: `[FAIL] config/chamber-jobs.service keeps the hardening ...` with `chamber-jobs.service lacks NoNewPrivileges=true`.

- [ ] **Step 3: Replace `deploy/systemd/chamber-jobs.service`**

The seven directives are copied from `deploy/systemd/chamber.service` lines 30 to 41 (`NoNewPrivileges=true`, `CapabilityBoundingSet=`, `AmbientCapabilities=`, `LockPersonality=true`, `RestrictRealtime=true`, `SystemCallFilter=@system-service`, `SystemCallErrorNumber=EPERM`); `MemoryDenyWriteExecute=false` is not copied because false is the default. Write the whole file:

```ini
[Unit]
Description=Chamber job queue worker (one-shot)
Documentation=file:///opt/chamber/deploy/PILOT.md
After=network.target chamber.service

[Service]
Type=oneshot
User=chamber
Group=chamber
WorkingDirectory=/opt/chamber
Environment=NODE_ENV=production
Environment=CHAMBER_DB=/var/lib/chamber/chamber.sqlite
EnvironmentFile=-/etc/chamber/env
ExecStart=/usr/bin/node --experimental-strip-types /opt/chamber/src/cli.ts jobs run
Nice=10
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/chamber /tmp
# The rest matches chamber.service. SystemCallFilter=@system-service would stop
# bubblewrap, so it is safe on this unit only because `chamber jobs run` never
# reaches the sandbox or starts a child process; tests/harness.ts checks that by
# walking the imports of src/job_queue.ts. If jobs ever need either, drop the
# filter from this unit rather than widening it.
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
LockPersonality=true
RestrictRealtime=true
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

# Activated by chamber-jobs.timer; can also: systemctl start chamber-jobs.service
```

- [ ] **Step 4: Run the test and see it pass**

```bash
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep "chamber-jobs\|passed"
```

Expected: `[PASS]` for the new test and a last line `N/N passed · 0 failed`.

- [ ] **Step 5: Verify the unit with systemd (Linux, in docker)**

`systemd-analyze` is not on macOS. In docker, with the unit's binaries stubbed so the verifier finds them:

```bash
docker run --rm \
  -v "$PWD/deploy/systemd/chamber-jobs.service:/units/chamber-jobs.service:ro" \
  -v "$PWD/deploy/systemd/chamber-jobs.timer:/units/chamber-jobs.timer:ro" \
  ubuntu:24.04 bash -c '
    apt-get update -qq >/dev/null && apt-get install -y -qq systemd >/dev/null 2>&1
    systemd-analyze --version | head -1
    mkdir -p /opt/chamber/src /etc/chamber && touch /usr/bin/node /opt/chamber/src/cli.ts && chmod +x /usr/bin/node
    useradd -r chamber
    cp /units/* /etc/systemd/system/
    out=$(systemd-analyze verify /etc/systemd/system/chamber-jobs.service 2>&1)
    echo "verify exit $? output=[$out]"
    sed -i "s/^SystemCallFilter=.*/SystemCallFilter=@no-such-group/" /etc/systemd/system/chamber-jobs.service
    out=$(systemd-analyze verify /etc/systemd/system/chamber-jobs.service 2>&1)
    echo "doctored unit output=[$out]"'
```

Expected: `systemd 255 ...`, then `verify exit 0 output=[]` (a clean unit prints nothing), then a non-empty `doctored unit output=[... Unknown system call group, ignoring: @no-such-group]`. The doctored run shows the verifier can report a problem in this exact line, so the empty output above means something. (`systemd-analyze verify` exits 0 even on that warning; the output being empty is the criterion.) If `docker` is unavailable write `NOT RUN` and the reason. Also note that the unit has not been started under a real systemd here: the evidence for the filter not breaking `jobs run` is the import walk, plus `chamber.service` already running node under the same filter.

- [ ] **Step 6: Run the four gates, then commit**

```bash
git status --short     # deploy/systemd/chamber-jobs.service and tests/harness.ts only
git add deploy/systemd/chamber-jobs.service tests/harness.ts
git commit -m "fix: give chamber-jobs.service the hardening chamber.service has

NoNewPrivileges, empty capability sets, LockPersonality, RestrictRealtime and a
@system-service syscall filter. The filter is safe here only because
chamber jobs run cannot reach the sandbox or start a child process, so a test
walks the job queue's imports and fails if that changes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Mutation proofs**

```bash
run() { node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -A1 "FAIL.*chamber-jobs"; }

# (a) a directive goes missing
git show HEAD~1:deploy/systemd/chamber-jobs.service > deploy/systemd/chamber-jobs.service; run; git checkout -- deploy/systemd/chamber-jobs.service

# (b) the jobs path gains a route to the sandbox
python3 - <<'EOF'
p = "src/job_queue.ts"
s = open(p).read()
old = 'import { runExpiryJob } from "./expiry.ts";\n'
assert s.count(old) == 1
open(p, "w").write(s.replace(old, old + 'import { sandboxSelfTest } from "./sandbox.ts";\nvoid sandboxSelfTest;\n'))
EOF
run; git checkout -- src/job_queue.ts
git diff --stat
```

Expected: (a) `chamber-jobs.service lacks NoNewPrivileges=true`; (b) `chamber jobs run now reaches src/sandbox.ts: ...`; and an empty final `git diff --stat`.

**Not caught by the gates:**
- `SystemCallFilter=@system-service` was not exercised by running `chamber jobs run` under real systemd. If a future job kind needs a syscall outside `@system-service`, the job fails under systemd with `EPERM` (that is what `SystemCallErrorNumber=EPERM` is for) and works everywhere else.
- `chamber.service` is unchanged and `chamber-slack.service` / `chamber-discord.service` have their own directive sets; this task does not audit them.

---

### Task 5: bwrap pid, ipc, uts namespaces and a new session (B7)

**Files:**
- Modify (whole file): `probes/sandbox_confines.ts`
- Modify: `src/sandbox.ts` (the bwrap argv in `runBwrap`, one `Edit`)

**Interfaces:**
- Consumes: `runInSandbox`, `detectSandboxBackend` from `src/sandbox.ts` (unchanged signatures).
- Produces: nothing for later tasks. Task 9 documents the result in `docs/KNOWN_LIMITATIONS.md` entry 1.

**Do not touch `sandboxRequired()` or any other part of `src/sandbox.ts`.** The runtime-hardening PR changed that function; this task adds four strings to the list of bwrap arguments and nothing else. bwrap applies **mount** operations left to right (CLAUDE.md), so do not move `--proc`, `--tmpfs` or `--bind`. The four new arguments are namespace and session options, which bwrap applies before any mount, so `--proc /proc` (already earlier in the list) mounts the new pid namespace's view.

**This task needs Linux.** The recipe below is CLAUDE.md's, with `--privileged` for bwrap's namespaces, adapted to run `probes/sandbox_confines.ts`. Define it once in your shell:

```bash
probe_linux() {
  docker run --rm --privileged -e CHAMBER_SANDBOX_REQUIRED=1 -v "$PWD:/app:ro" node:24-slim \
    bash -c 'apt-get update -qq >/dev/null && apt-get install -y -qq bubblewrap >/dev/null 2>&1 \
      && bwrap --version && cd /app \
      && node --experimental-strip-types probes/sandbox_confines.ts; echo "probe exit: $?"'
}
```

If `docker` is unavailable, or the container cannot start, write `NOT RUN` for every `probe_linux` step with the verbatim error, finish the rest, and say in the report that the local Linux check was not run and the CI `probes` job (`npm run probes:isolation` on a bwrap runner) is the only evidence. Never call a `probe_linux` step passed without running it.

- [ ] **Step 1: Replace `probes/sandbox_confines.ts`**

The probe gains a fourth thing to check: a host process the payload must not see. It starts a sleeping child whose argv carries a random marker, scans `/proc/*/cmdline` for it **outside** the sandbox first (a control: if the needle is not visible unconfined, its absence inside proves nothing, so the probe exits 1 with `NOT PROVEN`), then has the payload run the same scan inside. A pid would be a worse marker, because the sandbox's pid namespace numbers from 1 and a small host pid could collide with one of its processes. Write the whole file:

```ts
/**
 * PROBE: the sandbox actually confines — not merely that it refuses.
 *
 * `probes/sandbox_escape.ts` passes in two very different worlds: one where the
 * sandbox contained the payload, and one where no isolating backend existed so
 * nothing ran at all. Both report "no escape detected", and CI has been living
 * in the second. A gate that is only ever observed saying no has not been
 * observed working.
 *
 * This probe demands the other half. It requires the payload to RUN and to be
 * contained:
 *
 *   - the run must succeed (a refusal fails this probe)
 *   - the payload must not read /etc/passwd  (present + world-readable outside
 *     the allowlist, so a failure here means confinement, not permissions)
 *   - the payload must not reach the network
 *   - the payload must not see a host process: this probe starts a sleeping
 *     child with a random marker in its argv, and the payload scans /proc for
 *     it. That is the pid namespace (`--unshare-pid`). The needle is proven
 *     visible UNCONFINED first, by running the same scan outside the sandbox,
 *     so its absence inside means confinement and not a scan that finds nothing.
 *
 * Linux + bubblewrap only, and deliberately not part of `npm run probes`: on a
 * machine with no isolating backend it can only fail, and a probe that always
 * fails teaches people to ignore it. CI runs it explicitly, which is the whole
 * point — that is the machine where confinement is claimed.
 *
 *   CHAMBER_SANDBOX_REQUIRED=1 node --experimental-strip-types probes/sandbox_confines.ts
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInSandbox, detectSandboxBackend } from "../src/sandbox.ts";

const backend = detectSandboxBackend();
console.log("detectSandboxBackend() =", backend);
console.log("CHAMBER_SANDBOX_REQUIRED =", process.env.CHAMBER_SANDBOX_REQUIRED ?? "(unset)");

// The process needle: a host process the payload must not be able to see. A
// pid would be a poor marker, because the sandbox's own pid namespace numbers
// from 1 and a small host pid could collide with a sandbox process; a random
// string in a process's argv cannot.
const marker = `chamber-needle-${randomBytes(8).toString("hex")}`;
const needle = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", "--", marker], {
  stdio: "ignore",
});
const controlDir = mkdtempSync(join(tmpdir(), "chamber-needle-"));

/** Stop the needle and remove the scratch directory, then exit. */
function finish(code: number): never {
  needle.kill("SIGKILL");
  rmSync(controlDir, { recursive: true, force: true });
  process.exit(code);
}

// Reads every /proc/<pid>/cmdline and reports whether any contains the marker.
// `import * as` so it can sit beside the payload's own imports without
// redeclaring a name. The scanning process's own argv is a file path, never the
// marker, so it cannot find itself.
const PROC_SCAN = `
  import * as procfs from "node:fs";
  const MARKER = ${JSON.stringify(marker)};
  let sawHostProcess = false;
  try {
    for (const name of procfs.readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(name)) continue;
      try {
        if (procfs.readFileSync("/proc/" + name + "/cmdline", "utf8").includes(MARKER)) sawHostProcess = true;
      } catch {}
    }
  } catch {}
`;

// The control. The needle must be visible with no sandbox at all, or its
// absence inside the sandbox proves nothing. The child may not have exec'd yet,
// so poll briefly before concluding it is invisible.
writeFileSync(
  join(controlDir, "scan.mjs"),
  `${PROC_SCAN}\nconsole.log(JSON.stringify({ sawHostProcess }));\n`,
);
let visibleUnconfined = false;
for (let i = 0; i < 50 && !visibleUnconfined; i++) {
  const scan = spawnSync(process.execPath, [join(controlDir, "scan.mjs")], { encoding: "utf8" });
  visibleUnconfined = (scan.stdout ?? "").includes('"sawHostProcess":true');
  if (!visibleUnconfined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
console.log("process needle visible unconfined:", visibleUnconfined);
if (!visibleUnconfined) {
  console.log(
    "\n>>> NOT PROVEN — the process needle is not visible outside the sandbox either\n" +
      "    (no /proc, or the needle did not start), so its absence inside proves nothing.",
  );
  finish(1);
}

const r = runInSandbox({
  runtime: "node",
  source: `
    import { readFileSync } from "node:fs";
    import net from "node:net";
    ${PROC_SCAN}
    let readOutside = false, reachedNet = false;
    try { readFileSync("/etc/passwd"); readOutside = true; } catch {}
    // Raw IP, not a hostname: /etc is not bound, so DNS fails regardless of
    // whether the sandbox has a network, and a name-resolution needle reports
    // "no network" for a fully network-open sandbox.
    reachedNet = await new Promise((resolve) => {
      const socket = net.connect({ host: "1.1.1.1", port: 443 });
      const done = (v) => { try { socket.destroy(); } catch {} resolve(v); };
      socket.setTimeout(3000);
      socket.on("connect", () => done(true));
      socket.on("timeout", () => done(false));
      socket.on("error", () => done(false));
    });
    console.log(JSON.stringify({ ran: true, readOutside, reachedNet, sawHostProcess }));
  `,
  timeoutMs: 15_000,
});

console.log("backend reported:", r.backend, " ok:", r.ok);
console.log(r.stdout.trim() || r.stderr.trim() || r.error);

// A refusal is ambiguous, and the ambiguity matters. `isolationHolds` runs its
// own read needle before any payload, so a sandbox that genuinely leaks makes
// `runInSandbox` refuse — which lands here looking exactly like "no namespace
// available". Reporting that as a configuration problem points an operator at a
// sysctl when the real condition is a live escape, so the two are separated by
// what the refusal actually says.
if (!r.ok) {
  const unproven = (r.error ?? "").includes("did not confine a probe");
  console.log(
    unproven
      ? "\n>>> NOT PROVEN — bwrap was selected but could not confine its own probe.\n" +
          "    That is either a missing namespace capability OR a real escape;\n" +
          "    this probe cannot tell them apart, and neither can CI.\n" +
          "    Check `unshare --user --map-root-user true` before assuming config."
      : "\n>>> NOT PROVEN — the sandbox refused, so confinement was never exercised.\n" +
      "    On Linux this usually means bubblewrap cannot create a user namespace.\n" +
      "    Ubuntu 24.04 restricts that by default:\n" +
      "      sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n" +
      "    Refusing is the correct fail-closed behaviour — but it is not evidence\n" +
      "    that anything is confined, which is what this probe exists to obtain.",
  );
  finish(1);
}

// Parse rather than substring-match, and require positive evidence the payload
// ran. `leaked` inferred from the absence of two substrings meant that empty or
// truncated stdout — an output cap, a runtime that starts and writes nothing —
// read as confinement, certifying a run whose assertions may never have
// executed.
let report: { ran?: boolean; readOutside?: boolean; reachedNet?: boolean; sawHostProcess?: boolean } = {};
try {
  report = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).pop() ?? "{}");
} catch {
  /* leave empty — handled below */
}
if (report.ran !== true || typeof report.sawHostProcess !== "boolean") {
  console.log(
    "\n>>> NOT PROVEN — the payload did not report running. Absence of a leak in\n" +
      "    empty output is not evidence of confinement.",
  );
  finish(1);
}
const leaked =
  report.readOutside === true || report.reachedNet === true || report.sawHostProcess === true;
console.log(
  leaked
    ? "\n>>> NOT CONFINED — the payload ran and reached outside the sandbox:\n" +
        `    read /etc/passwd: ${report.readOutside}, reached the network: ${report.reachedNet}, ` +
        `saw a host process: ${report.sawHostProcess}`
    : "\n>>> CONFINED — the payload ran, could not read /etc/passwd, had no network,\n" +
        "    and could not see a host process",
);
finish(leaked ? 1 : 0);
```

- [ ] **Step 2: Typecheck and lint the probe, and run it where it cannot work**

```bash
npx tsc --noEmit && npx eslint probes/sandbox_confines.ts; echo "exit: $?"
node --experimental-strip-types probes/sandbox_confines.ts; echo "probe exit: $?"
```

Expected: `exit: 0`. On macOS (no `/proc`) the probe prints `process needle visible unconfined: false`, then `>>> NOT PROVEN — the process needle is not visible outside the sandbox either`, and `probe exit: 1`. That is the fail-closed answer, and the reason the probe stays out of `npm run probes`.

- [ ] **Step 3: Run it on Linux with the OLD flags and see it fail (this is the red)**

`src/sandbox.ts` still has the old argv, so:

```bash
probe_linux
```

Expected output ends with:

```
process needle visible unconfined: true
backend reported: bwrap  ok: true
{"ran":true,"readOutside":false,"reachedNet":false,"sawHostProcess":true}

>>> NOT CONFINED — the payload ran and reached outside the sandbox:
    read /etc/passwd: false, reached the network: false, saw a host process: true
probe exit: 1
```

(The `bubblewrap 0.8.0` line above it is the version the container installed.) If `sawHostProcess` is `false` here, the needle cannot go red: stop and report.

- [ ] **Step 4: Add the four flags in `src/sandbox.ts`**

`Edit` on `src/sandbox.ts`. `old_string`, exactly (4-space indent):

```ts
    "--unshare-net",
    "--die-with-parent",
```

`new_string`:

```ts
    "--unshare-net",
    // The rest of the namespaces the payload does not need to share. Without
    // --unshare-pid the payload's /proc listed every process on the host, with
    // each one's command line, and could signal any process of the same user.
    // --unshare-ipc and --unshare-uts hide SysV/POSIX IPC objects and the host
    // name. --new-session starts a new terminal session, so a payload cannot
    // push keystrokes into the controlling terminal (TIOCSTI). Namespace flags
    // are not mount operations: they take effect before any of the mounts
    // above, so `--proc /proc` already mounts the new pid namespace's view.
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    "--die-with-parent",
```

`git diff src/sandbox.ts` must show only those added lines.

- [ ] **Step 5: Run it on Linux with the NEW flags and see it pass**

```bash
probe_linux
```

Expected output ends with:

```
process needle visible unconfined: true
backend reported: bwrap  ok: true
{"ran":true,"readOutside":false,"reachedNet":false,"sawHostProcess":false}

>>> CONFINED — the payload ran, could not read /etc/passwd, had no network,
    and could not see a host process
probe exit: 0
```

- [ ] **Step 6: Check nothing else that runs under bwrap regressed**

```bash
docker run --rm --privileged -e CHAMBER_SANDBOX_REQUIRED=1 -v "$PWD:/app:ro" node:24-slim bash -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq bubblewrap >/dev/null 2>&1; cd /app
  node --experimental-strip-types probes/sandbox_escape.ts; echo "escape probe exit: $?"
  node --experimental-strip-types demos/04_nothing_runs_unisolated.ts | tail -4; echo "demo 04 exit: ${PIPESTATUS[0]}"'
```

Expected: `>>> no escape detected` with `escape probe exit: 0`; the demo's last lines say `the payload RAN, and the isolation probe confirmed confinement` with `demo 04 exit: 0`.

- [ ] **Step 7: Run the four gates, then commit**

Run them on the host as in Global Constraints. `npm run probes` does not include `sandbox_confines.ts`; its Linux run is Steps 3 and 5.

```bash
git status --short     # probes/sandbox_confines.ts and src/sandbox.ts only
git add probes/sandbox_confines.ts src/sandbox.ts
git commit -m "fix: unshare pid, ipc and uts and start a new session in the bwrap sandbox

runBwrap only unshared the network, so a payload's /proc listed every host
process with its command line. sandbox_confines.ts gains a process needle: a
sleeping child with a random marker in its argv, proven visible without the
sandbox and required to be invisible inside it. Verified on Linux with
bubblewrap 0.8.0 in docker: exit 1 with the old flags, exit 0 with the new.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Mutation proofs (Linux)**

```bash
# (a) the old flags again: the new needle must go red
python3 - <<'EOF'
p = "src/sandbox.ts"
s = open(p).read()
for flag in ("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session"):
    line = f'    "{flag}",\n'
    assert s.count(line) == 1, flag
    s = s.replace(line, "")
open(p, "w").write(s)
EOF
git diff --stat
probe_linux | tail -5
git checkout -- src/sandbox.ts

# (b) only --unshare-pid removed: the needle is the pid namespace, so it must still go red
python3 - <<'EOF'
p = "src/sandbox.ts"
s = open(p).read()
line = '    "--unshare-pid",\n'
assert s.count(line) == 1
open(p, "w").write(s.replace(line, ""))
EOF
probe_linux | tail -4
git checkout -- src/sandbox.ts

# (c) a blind scan: the control must refuse to certify
python3 - <<'EOF'
p = "probes/sandbox_confines.ts"
s = open(p).read()
old = "const MARKER = ${JSON.stringify(marker)};"
assert s.count(old) == 1
open(p, "w").write(s.replace(old, "const MARKER = ${JSON.stringify(marker + \"x\")};"))
EOF
probe_linux | tail -5
git checkout -- probes/sandbox_confines.ts
git diff --stat
```

Expected: (a) four deletions in `git diff --stat`, then `saw a host process: true` and `probe exit: 1`; (b) the same `saw a host process: true`, `probe exit: 1`; (c) `process needle visible unconfined: false`, `>>> NOT PROVEN — the process needle is not visible outside the sandbox either`, `probe exit: 1`; and an empty final `git diff --stat`. If (a) or (b) exits 0 the probe cannot go red: stop and report. If docker is unavailable all three are `NOT RUN`.

**Not caught by the gates:**
- Only `--unshare-pid` has a needle. `--unshare-ipc`, `--unshare-uts` and `--new-session` are present in the argv and verified by nothing; removing just one of them leaves every probe green. Say so in the report; do not claim the probe proves them.
- The probe cannot run on macOS and is not part of `npm run probes`. CI's `probes` job runs `npm run probes:isolation` on a bwrap runner after lifting AppArmor's user-namespace restriction; that job, not this Mac, is the standing evidence.

---

### Task 6: Pin hardening: git environment, timeouts, URLs, atomic write (C1)

**Files:**
- Modify: `src/release_pin.ts` (ten `Edit` calls, listed below)
- Modify: `tests/harness.ts` (one `Edit` to the import list, one `Edit` inserting eight `release` tests)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all exported from `src/release_pin.ts` and used by this task's tests:
  - `interface GitTimeouts { fetchMs: number; otherMs: number }` and `setGitTimeouts(next: GitTimeouts): GitTimeouts`, which replaces the module's git timeouts and returns the previous ones (test seam, like `resetIsolationProbe` in `src/sandbox.ts`). Defaults: `fetchMs` 120000, `otherMs` 30000.
  - `redactUserinfo(text: string): string`: `scheme://user:pw@host` becomes `scheme://<redacted>@host`, in any text.
  - `originCredentialRefusal(url: string): string | null`: for `http:` and `https:` URLs with any username or password, returns the message `the origin URL carries credentials; use a credential helper instead`; otherwise `null`. scp-like `user@host:path`, `ssh://user@host/...`, paths and non-URLs return `null`.
  - `writeFileAtomic(path: string, text: string, rename?: (from: string, to: string) => void): void`: temp file `<target>.tmp-<pid>` beside the real file (a symlinked `path` is followed, so the link survives), created exclusively with the original's mode, then `rename` over the target; on any failure the temp file is removed and the error rethrown.
- Task 7 adds to the same file and relies on all of the above staying put.

**What each C1 item becomes.** Every git spawn (`git()` and the `check-ref-format` spawn) gets `GIT_TERMINAL_PROMPT=0` and loses `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` and `GIT_COMMON_DIR`; `git fetch` times out at 120 s and every other git call at 30 s, reported as a refusal like `git fetch timed out after 120s`; `git remote add` passes `--` before the name and URL; an `http:`/`https:` origin with userinfo is refused before anything is created, without printing the URL, and every URL printed anywhere else (git's stderr, the "fetches from X, not Y" refusal) has its userinfo redacted; an `lstat` error other than `ENOENT` on the release directory is a refusal naming the code, not a throw; the plist is written atomically.

- [ ] **Step 1: Add the imports to the harness**

`Edit` on `tests/harness.ts` (this list is the `from "../src/release_pin.ts"` import near the top; use a bounded `Read` with `grep -n 'pinCheckout,' tests/harness.ts` to see it):

**Edit 1 of 1** in `tests/harness.ts`. `old_string`:

```ts
  pinCheckout,
  pinJobPlist,
  pinRelease,
  readJobPlist,
```

`new_string`:

```ts
  originCredentialRefusal,
  pinCheckout,
  pinJobPlist,
  pinRelease,
  readJobPlist,
  redactUserinfo,
  setGitTimeouts,
  writeFileAtomic,
```

- [ ] **Step 2: Add the eight tests**

`Edit` on `tests/harness.ts`: `old_string` `// ─── cli process smoke tests`, `new_string` the block below followed by `// ─── cli process smoke tests`. The helpers it defines (`gitShim`, `withProcessEnv`) are new top-level functions; if `tsc` later reports a duplicate name, another change took it, so rename yours.

```ts
// ─── pin hardening: git environment, timeouts, URLs, atomic write ───────────

/**
 * A `git` that goes first on PATH, records how it was called (the prompt
 * setting, GIT_DIR and GIT_INDEX_FILE it saw, and its arguments) and runs the
 * real git. With SHIM_HANG=fetch it hangs on `fetch` instead, and with
 * SHIM_FAIL=fetch it fails `fetch` with a message that quotes a URL carrying
 * the userinfo in SHIM_USERINFO, the way git's own errors do.
 */
function gitShim(root: string): { dir: string; log: string; real: string } {
  const dir = join(root, "shim");
  mkdirSync(dir, { recursive: true });
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const log = join(root, "git-calls.log");
  writeFileSync(
    join(dir, "git"),
    [
      "#!/bin/sh",
      'echo "${GIT_TERMINAL_PROMPT-unset}|${GIT_DIR-unset}|${GIT_INDEX_FILE-unset}|$*" >> "$SHIM_LOG"',
      'if [ "$SHIM_HANG" = fetch ]; then for a in "$@"; do [ "$a" = fetch ] && exec sleep 30; done; fi',
      `if [ "$SHIM_FAIL" = fetch ]; then for a in "$@"; do [ "$a" = fetch ] && { echo "fatal: unable to access 'https://$SHIM_USERINFO@example.invalid/x.git/': 401" >&2; exit 128; }; done; fi`,
      'exec "$SHIM_REAL_GIT" "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "git"), 0o755);
  return { dir, log, real };
}

/** Run `fn` with these variables set in this process, then put every one back. */
function withProcessEnv(vars: Record<string, string>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("release", "every git call pin makes has prompts off and none of the variables that redirect git", () => {
  withReleaseFixture((fx) => {
    const shim = gitShim(fx.root);
    withProcessEnv(
      {
        PATH: `${shim.dir}:${process.env.PATH ?? ""}`,
        SHIM_LOG: shim.log,
        SHIM_REAL_GIT: shim.real,
        GIT_DIR: join(fx.root, "not-a-repo"),
        GIT_WORK_TREE: join(fx.root, "not-a-tree"),
        GIT_INDEX_FILE: join(fx.root, "not-an-index"),
        GIT_TERMINAL_PROMPT: "1",
      },
      () => {
        const r = pinCheckout({ tag: "v1", sourceRoot: fx.source, releaseDir: fx.releaseDir });
        assert(r.ok, `pin refused with GIT_DIR and friends set: ${JSON.stringify(r)}`);
      },
    );
    const calls = readFileSync(shim.log, "utf8").trim().split("\n");
    assert(calls.length >= 6, `expected pin's git calls to be logged, got ${calls.length}`);
    for (const c of calls) {
      assert(c.startsWith("0|unset|unset|"), `a git call inherited the environment: ${c}`);
    }
  });
});

test("release", "a git fetch that hangs is a refusal naming the command, and a first pin cleans up", () => {
  withReleaseFixture((fx) => {
    const shim = gitShim(fx.root);
    const previous = setGitTimeouts({ fetchMs: 400, otherMs: 10_000 });
    try {
      withProcessEnv(
        { PATH: `${shim.dir}:${process.env.PATH ?? ""}`, SHIM_LOG: shim.log, SHIM_REAL_GIT: shim.real, SHIM_HANG: "fetch" },
        () => {
          const started = Date.now();
          const r = pinCheckout({ tag: "v1", sourceRoot: fx.source, releaseDir: fx.releaseDir });
          assert(!r.ok && r.reason.includes("git fetch timed out after 0.4s"), JSON.stringify(r));
          assert(Date.now() - started < 10_000, "the timeout did not stop the fetch");
        },
      );
    } finally {
      setGitTimeouts(previous);
    }
    assert(!existsSync(fx.releaseDir), "a first pin that timed out left its clone behind");
    assert(
      previous.fetchMs === 120_000 && previous.otherMs === 30_000,
      `the default timeouts are 120 s for fetch and 30 s for the rest, got ${JSON.stringify(previous)}`,
    );
  });
});

test("release", "a URL in git's own error message has its userinfo redacted in the refusal", () => {
  withReleaseFixture((fx) => {
    const shim = gitShim(fx.root);
    const userinfo = ["bob", "pw"].join(":");
    withProcessEnv(
      {
        PATH: `${shim.dir}:${process.env.PATH ?? ""}`,
        SHIM_LOG: shim.log,
        SHIM_REAL_GIT: shim.real,
        SHIM_FAIL: "fetch",
        SHIM_USERINFO: userinfo,
      },
      () => {
        const r = pinCheckout({ tag: "v1", sourceRoot: fx.source, releaseDir: fx.releaseDir });
        assert(!r.ok && r.reason.includes("https://<redacted>@example.invalid/x.git/"), JSON.stringify(r));
        assert(!r.reason.includes("bob") && !r.reason.includes("pw@"), `the refusal printed the userinfo: ${r.reason}`);
      },
    );
  });
});

test("release", "an origin URL that starts with a dash is added as a URL, not read as an option", () => {
  withReleaseFixture((fx) => {
    fixtureGit(fx.source, ["config", "remote.origin.url", "-not-an-option"]);
    const r = pinCheckout({ tag: "v1", sourceRoot: fx.source, releaseDir: fx.releaseDir });
    assert(!r.ok, "a pin from a dash-named origin succeeded");
    assert(
      r.reason.startsWith("git fetch:"),
      `the failure must come from the fetch, not from option parsing in remote add: ${r.reason}`,
    );
    assert(!existsSync(fx.releaseDir), "a failed first pin left its clone behind");
  });
});

test("release", "an http(s) origin with credentials is refused before anything is created, and never echoed", () => {
  withReleaseFixture((fx) => {
    // Assembled here so no literal credential sits in this file.
    const secret = ["hunter", "2"].join("");
    for (const url of [
      `https://alice:${secret}@example.invalid/chamber.git`,
      `http://alice@example.invalid/chamber.git`,
      `https://:${secret}@example.invalid/chamber.git`,
    ]) {
      fixtureGit(fx.source, ["config", "remote.origin.url", url]);
      const r = pinCheckout({ tag: "v1", sourceRoot: fx.source, releaseDir: fx.releaseDir });
      assert(
        !r.ok && r.reason === "the origin URL carries credentials; use a credential helper instead",
        `${JSON.stringify(r)}`,
      );
      assert(!r.reason.includes(secret) && !r.reason.includes("alice"), "the refusal echoed the URL");
      assert(!existsSync(dirname(fx.releaseDir)), "a refused pin created a directory");
    }
  });
  for (const [url, refused] of [
    ["https://example.invalid/chamber.git", false],
    ["https://@example.invalid/chamber.git", false],
    ["http://example.invalid:8080/chamber.git", false],
    ["https://alice@example.invalid/chamber.git", true],
    ["http://alice:pw@example.invalid/chamber.git", true],
    ["https://:pw@example.invalid/chamber.git", true],
    ["ssh://git@example.invalid/chamber.git", false],
    ["git@example.invalid:org/chamber.git", false],
    ["user:pw@example.invalid:org/chamber.git", false],
    ["/srv/git/chamber.git", false],
    ["-not-an-option", false],
  ] as const) {
    assert((originCredentialRefusal(url) !== null) === refused, `${url}: expected ${refused ? "a refusal" : "no refusal"}`);
  }
});

test("release", "a URL printed in a message has its userinfo redacted", () => {
  const table: ReadonlyArray<readonly [string, string]> = [
    ["fatal: unable to access 'https://u:p@host/x.git/': 401", "fatal: unable to access 'https://<redacted>@host/x.git/': 401"],
    ["ssh://git@host/x.git", "ssh://<redacted>@host/x.git"],
    ["https://a:b@c@host/x", "https://<redacted>@host/x"],
    ["git@host:org/r.git", "git@host:org/r.git"],
    ["https://host/x.git", "https://host/x.git"],
    ["nothing to redact", "nothing to redact"],
  ];
  for (const [input, want] of table) assert(redactUserinfo(input) === want, `${input} -> ${redactUserinfo(input)}`);

  withReleaseFixture((fx) => {
    const secret = ["hunter", "2"].join("");
    const opts = { sourceRoot: fx.source, releaseDir: fx.releaseDir };
    assert(pinCheckout({ ...opts, tag: "v1" }).ok, "v1 refused");
    fixtureGit(fx.releaseDir, ["remote", "set-url", "origin", `https://bob:${secret}@example.invalid/other.git`]);
    const r = pinCheckout({ ...opts, tag: "v2" });
    assert(!r.ok && r.reason.includes("https://<redacted>@example.invalid/other.git"), JSON.stringify(r));
    assert(!r.reason.includes(secret) && !r.reason.includes("bob"), `the refusal printed the credentials: ${r.reason}`);
  });
});

test("release", "a release directory that cannot be looked at is a refusal, not a crash", () => {
  withReleaseFixture((fx) => {
    const file = join(fx.root, "a-file");
    writeFileSync(file, "not a directory\n");
    const r = pinCheckout({ tag: "v1", sourceRoot: fx.source, releaseDir: join(file, "release") });
    assert(!r.ok && r.reason.includes("cannot look at") && r.reason.includes("ENOTDIR"), JSON.stringify(r));
  });
});

test("release", "the job plist is replaced atomically with its mode kept, and a failed write leaves no temp file", () => {
  withReleaseFixture((fx) => {
    writePlistFile(fx.plistPath, jobPlistXml(BARE_SCRIPT));
    chmodSync(fx.plistPath, 0o640);
    const inodeBefore = lstatSync(fx.plistPath).ino;
    const r = pinRelease(pinOpts(fx, "v1", fakeLaunchctl({ loaded: false }).run));
    assert(r.code === 0, r.err.join("\n"));
    const after = lstatSync(fx.plistPath);
    assert(after.ino !== inodeBefore, "the plist was rewritten in place, not replaced by a rename");
    assert((after.mode & 0o777) === 0o640, `the plist's mode changed to ${(after.mode & 0o777).toString(8)}`);
    assert(!existsSync(`${fx.plistPath}.tmp-${process.pid}`), "a temp file was left beside the plist");
    assert(plistForm(fx.plistPath) === "pinned", plistForm(fx.plistPath));

    // A rename that fails: the original is intact and the temp file is gone.
    const original = readFileSync(fx.plistPath, "utf8");
    let threw = "";
    try {
      writeFileAtomic(fx.plistPath, "replacement\n", () => {
        throw new Error("rename failed");
      });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    assert(threw === "rename failed", `the failure was swallowed: "${threw}"`);
    assert(readFileSync(fx.plistPath, "utf8") === original, "a failed write changed the plist");
    assert(!existsSync(`${fx.plistPath}.tmp-${process.pid}`), "a failed write left its temp file");

    // A symlinked plist keeps its link; the target is what is replaced.
    const link = join(fx.root, "link.plist");
    symlinkSync(fx.plistPath, link);
    writeFileAtomic(link, "through the link\n");
    assert(lstatSync(link).isSymbolicLink(), "the symlink was replaced by a regular file");
    assert(readFileSync(fx.plistPath, "utf8") === "through the link\n", "the link's target was not written");
  });
});

```

- [ ] **Step 3: Run them and see them fail**

```bash
node --experimental-strip-types tests/harness.ts --suite=release 2>&1 | tail -6
```

Expected: the harness does not start: `SyntaxError: The requested module '../src/release_pin.ts' does not provide an export named 'originCredentialRefusal'`. That is the red for "the code does not exist yet". The behavioural proof that each test can go red is Step 8, because an import failure says nothing about a single test.

- [ ] **Step 4: Change `src/release_pin.ts`**

Apply these ten `Edit` calls to `src/release_pin.ts`, in this order (a later `old_string` can depend on an earlier edit). Each `old_string` is unique in the file at that point. Whether or not you include the final newline of a block, include it in both `old_string` and `new_string`.

**Edit 1 of 10** in `src/release_pin.ts`. `old_string`:

```ts
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
```

`new_string`:

```ts
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
```

**Edit 2 of 10** in `src/release_pin.ts`. `old_string`:

```ts
interface GitRun {
  ok: boolean;
  out: string;
  message: string;
}

function git(cwd: string, args: readonly string[]): GitRun {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const stderr = r.error !== undefined ? String(r.error) : (r.stderr ?? "").trim();
  return {
    ok: r.status === 0,
    out: (r.stdout ?? "").trim(),
    message: stderr !== "" ? stderr : `git ${args[0] ?? ""} exited ${r.status}`,
  };
}
```

`new_string`:

```ts
interface GitRun {
  ok: boolean;
  out: string;
  message: string;
}

export interface GitTimeouts {
  fetchMs: number;
  otherMs: number;
}

let gitTimeouts: GitTimeouts = { fetchMs: 120_000, otherMs: 30_000 };

/** Test seam: replace the git timeouts and return the ones that were set. */
export function setGitTimeouts(next: GitTimeouts): GitTimeouts {
  const previous = gitTimeouts;
  gitTimeouts = next;
  return previous;
}

/**
 * `scheme://user:password@host` becomes `scheme://<redacted>@host`, wherever a
 * URL appears in text. Git's own error messages quote the URL they failed on,
 * and an origin URL can carry credentials.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1<redacted>@");
}

// Variables that point git at some other repository than the one `-C` names.
// Pin runs from places that set them: a git hook exports GIT_DIR and
// GIT_INDEX_FILE, and with those inherited `git -C <release dir>` answers for
// the hook's repository instead.
const GIT_REDIRECTS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
] as const;

function gitEnv(): NodeJS.ProcessEnv {
  // A fetch that wants a password must fail, not wait on a terminal nobody is
  // watching.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of GIT_REDIRECTS) delete env[name];
  return env;
}

function git(cwd: string, args: readonly string[], timeoutMs: number = gitTimeouts.otherMs): GitRun {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv(), timeout: timeoutMs });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const stderr = r.error !== undefined ? String(r.error) : (r.stderr ?? "").trim();
  const message = timedOut
    ? `git ${args[0] ?? ""} timed out after ${timeoutMs / 1000}s`
    : stderr !== ""
      ? stderr
      : `git ${args[0] ?? ""} exited ${r.status}`;
  return {
    ok: r.status === 0 && r.error === undefined,
    out: (r.stdout ?? "").trim(),
    message: redactUserinfo(message),
  };
}
```

**Edit 3 of 10** in `src/release_pin.ts`. `old_string`:

```ts
  const format = spawnSync("git", ["check-ref-format", `refs/tags/${tag}`], { encoding: "utf8" });
```

`new_string`:

```ts
  const format = spawnSync("git", ["check-ref-format", `refs/tags/${tag}`], {
    encoding: "utf8",
    env: gitEnv(),
    timeout: gitTimeouts.otherMs,
  });
```

**Edit 4 of 10** in `src/release_pin.ts`. `old_string`:

```ts
    return `${dir} fetches from ${origin.ok ? origin.out : "no origin"}, not ${originUrl}; left alone`;
```

`new_string`:

```ts
    const found = origin.ok ? redactUserinfo(origin.out) : "no origin";
    return `${dir} fetches from ${found}, not ${redactUserinfo(originUrl)}; left alone`;
```

**Edit 5 of 10** in `src/release_pin.ts`. `old_string`:

```ts
    const remote = git(dir, ["remote", "add", "origin", originUrl]);
```

`new_string`:

```ts
    // `--`: the URL comes from another repository's config, and one that starts
    // with "-" must be a URL here, not an option.
    const remote = git(dir, ["remote", "add", "--", "origin", originUrl]);
```

**Edit 6 of 10** in `src/release_pin.ts`. `old_string`:

```ts
  const fetch = git(dir, ["fetch", "--quiet", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
```

`new_string`:

```ts
  const fetch = git(
    dir,
    ["fetch", "--quiet", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
    gitTimeouts.fetchMs,
  );
```

**Edit 7 of 10** in `src/release_pin.ts`. `old_string`:

```ts
/**
 * Fetch `tag` from the source checkout's origin and leave `releaseDir`
```

`new_string`:

```ts
/**
 * http(s) origins may not carry a username or a password: the URL is copied
 * into the release checkout's config and shows up in git's messages. scp-like
 * `user@host:path` and `ssh://user@host/...` are not URLs with secrets in them
 * and are allowed. The URL is never part of the message.
 */
export function originCredentialRefusal(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null; // not a URL: a path, or scp-like user@host:path
  }
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && (parsed.username !== "" || parsed.password !== "")) {
    return "the origin URL carries credentials; use a credential helper instead";
  }
  return null;
}

/**
 * Fetch `tag` from the source checkout's origin and leave `releaseDir`
```

**Edit 8 of 10** in `src/release_pin.ts`. `old_string`:

```ts
  // Decided once, before anything is written: only a directory this run
  // creates may be removed.
  const created = !pathExists(releaseDir);
```

`new_string`:

```ts
  const credentials = originCredentialRefusal(origin.out);
  if (credentials !== null) return { ok: false, reason: credentials };

  // Decided once, before anything is written: only a directory this run
  // creates may be removed. An lstat that fails for any reason but "not there"
  // (a parent that is a file, a permission error) is a refusal, not a crash.
  let created: boolean;
  try {
    created = !pathExists(releaseDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? String(e);
    return { ok: false, reason: `cannot look at ${releaseDir}: ${code}; left alone` };
  }
```

**Edit 9 of 10** in `src/release_pin.ts`. `old_string`:

```ts
export interface LaunchctlResult {
```

`new_string`:

```ts
/**
 * Write `text` to `path` so a reader sees the old file or the new one, never
 * half of it: a temp file in the same directory with the original's mode, then
 * a rename over it. A symlinked `path` is followed, so the link survives and
 * its target is what is replaced. A failure removes the temp file and rethrows.
 */
export function writeFileAtomic(
  path: string,
  text: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  const target = realpathSync(path);
  const mode = statSync(target).mode & 0o7777;
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { flag: "wx", mode });
    chmodSync(tmp, mode); // the umask may have narrowed the mode above
    rename(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export interface LaunchctlResult {
```

**Edit 10 of 10** in `src/release_pin.ts`. `old_string`:

```ts
  if (rewritten) {
    writeFileSync(plistPath, pinJobPlist(xml));
    out.push(
```

`new_string`:

```ts
  if (rewritten) {
    try {
      writeFileAtomic(plistPath, pinJobPlist(xml));
    } catch (e) {
      err.push(
        `chamber pin: could not write ${plistPath}: ${e instanceof Error ? e.message : String(e)}; ` +
          `the checkout is pinned and the job was not changed`,
      );
      return 1;
    }
    out.push(
```

- [ ] **Step 5: Typecheck, lint, run the release suite**

```bash
npx tsc --noEmit; echo "tsc exit: $?"
npx eslint src/release_pin.ts tests/harness.ts; echo "eslint exit: $?"
node --experimental-strip-types tests/harness.ts --suite=release 2>&1 | grep -v "^  \[PASS\]" | tail -5
```

Expected: both exit codes 0 and a last line `N/N passed · 0 failed`. Then confirm the eight new tests ran and passed:

```bash
node --experimental-strip-types tests/harness.ts --suite=release 2>&1 \
  | grep "\[PASS\]" | grep -cE "prompts off|hangs|userinfo|dash|credentials|cannot be looked at|atomically"
```

Expected: `8`.

- [ ] **Step 6: Run the four gates, then commit**

```bash
git status --short     # src/release_pin.ts and tests/harness.ts only
git add src/release_pin.ts tests/harness.ts
git commit -m "fix: harden chamber pin's git calls, origin URL handling and plist write

- Every git spawn gets GIT_TERMINAL_PROMPT=0 and loses GIT_DIR and the other
  variables that point git at a different repository.
- git fetch has a 120 s timeout, other git calls 30 s; a timeout is a refusal
  naming the command.
- git remote add passes -- before the name and URL.
- An http(s) origin with credentials is refused before anything is created;
  URLs printed anywhere else have their userinfo redacted.
- An lstat error other than ENOENT on the release directory is a refusal.
- The job plist is written to a temp file beside it with the original mode and
  renamed over it; a failure removes the temp file.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Create the mutation script (outside the repository)**

```bash
S=$(mktemp -d)      # scratch; keep the path for Task 7 or recreate the file there
echo "$S"
```

Write this to `$S/mutate_pin.py` (not under the worktree):

```python
"""Break src/release_pin.ts one way at a time and show which release tests go red.

usage (from the repository root): python3 <this file> 6      # the Task 6 mutations
                                  python3 <this file> 7      # the Task 7 mutations

Every mutation replaces one exact string, which must occur exactly once. The
original file is restored after each run, and again at the end.
"""
import os
import shutil
import subprocess
import sys
import tempfile

SRC = "src/release_pin.ts"

TABLES = {
    "6": {
        "M1 remote add without --": (
            '["remote", "add", "--", "origin", originUrl]',
            '["remote", "add", "origin", originUrl]',
        ),
        "M2 no fetch timeout": (
            "    gitTimeouts.fetchMs,\n  );",
            "    1e9,\n  );",
        ),
        "M3 git env not passed": (
            'spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv(), timeout: timeoutMs })',
            'spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: timeoutMs })',
        ),
        "M4 no credential refusal": (
            "  if (credentials !== null) return { ok: false, reason: credentials };\n",
            "",
        ),
        "M5 plist written in place": (
            "    rename(tmp, target);\n",
            "    writeFileSync(target, text);\n    rmSync(tmp, { force: true });\n",
        ),
        "M6 lstat error thrown": (
            "    const code = (e as NodeJS.ErrnoException).code ?? String(e);\n"
            "    return { ok: false, reason: `cannot look at ${releaseDir}: ${code}; left alone` };",
            "    throw e;",
        ),
        "M7 git messages not redacted": (
            "    message: redactUserinfo(message),",
            "    message,",
        ),
    },
    "7": {
        "M8 no proof run": (
            "  const proof = proveReleaseRuns(opts.releaseDir, opts.env ?? process.env);\n  if (!proof.ok) {",
            '  const proof: RunProof = { ok: true, version: "0" };\n  if (!proof.ok) {',
        ),
        "M9 version not compared": (
            "  if (printed !== version) {",
            "  if (false) {",
        ),
        "M10 exit status ignored": (
            "  if (r.status !== 0) {",
            "  if (false) {",
        ),
        "M11 Program key allowed": (
            "  if (/<key>\\s*Program\\s*<\\/key>/.test(live)) {",
            "  if (false) {",
        ),
        "M12 comments not stripped": (
            "  const live = stripXmlComments(xml);",
            "  const live = xml;",
        ),
        "M13 first match used, live or dead": (
            "    if (!comments.some(([from, to]) => m!.index >= from && m!.index < to)) return m;",
            "    return m;",
        ),
        "M14 no not-running hint": (
            "is not loaded, so the 08:30 job will not run; ",
            "is not loaded; ",
        ),
    },
}

table = TABLES[sys.argv[1]]
backup = tempfile.NamedTemporaryFile(delete=False).name
shutil.copy(SRC, backup)
try:
    for name, (old, new) in table.items():
        text = open(SRC, encoding="utf8").read()
        if text.count(old) != 1:
            print(f"{name}: ANCHOR COUNT {text.count(old)} (expected 1) -- stop and report")
            continue
        open(SRC, "w", encoding="utf8").write(text.replace(old, new))
        run = subprocess.run(
            ["node", "--experimental-strip-types", "tests/harness.ts", "--suite=release"],
            capture_output=True,
            text=True,
        )
        fails = [line.strip() for line in run.stdout.splitlines() if "[FAIL]" in line]
        shown = "; ".join(f[:100] for f in fails[:4]) or f"NO TEST FAILED (harness exit {run.returncode}) -- stop and report"
        print(f"{name} -> {len(fails)} failing: {shown}", flush=True)
        shutil.copy(backup, SRC)
finally:
    shutil.copy(backup, SRC)
    os.unlink(backup)
```

- [ ] **Step 8: Mutation proofs**

From the worktree root:

```bash
python3 "$S/mutate_pin.py" 6
git checkout -- src/release_pin.ts
git diff --stat
```

This takes several minutes (it runs the release suite seven times). Expected output, one line per mutation, each naming one failing test:

```
M1 remote add without -- -> 1 failing: [FAIL] release/an origin URL that starts with a dash is added as a URL, not read as an option
M2 no fetch timeout -> 1 failing: [FAIL] release/a git fetch that hangs is a refusal naming the command, and a first pin cleans up
M3 git env not passed -> 1 failing: [FAIL] release/every git call pin makes has prompts off and none of the variables that redirect git
M4 no credential refusal -> 1 failing: [FAIL] release/an http(s) origin with credentials is refused before anything is created, and never echoed
M5 plist written in place -> 1 failing: [FAIL] release/the job plist is replaced atomically with its mode kept, and a failed write leaves no temp file
M6 lstat error thrown -> 1 failing: [FAIL] release/a release directory that cannot be looked at is a refusal, not a crash
M7 git messages not redacted -> 1 failing: [FAIL] release/a URL in git's own error message has its userinfo redacted in the refusal
```

(Each test name is cut at 100 characters by the script.) The M2 run takes about 30 s longer than the others because without the timeout the stub `git fetch` sleeps its full 30 s. If any line says `NO TEST FAILED` or `ANCHOR COUNT`, stop and report. The final `git diff --stat` must print nothing.

**Not caught by the gates:**
- `git fetch` over the network, a real credential prompt, and a real hook-exported `GIT_DIR` are simulated by a `git` shim on `PATH` and by setting the variables in the test process. The shim proves the environment pin passes to git, not what a particular git version does with it.
- A symlinked plist is now followed instead of replaced. If the owner's `~/Library/LaunchAgents/com.chamber.verify.plist` is a symlink into a dotfiles repository, pin edits the repository file. That is the point of following it, but say so in the report.
- `redactUserinfo` handles `scheme://userinfo@host`. A credential in a query string or in a path is not userinfo and is not touched.
- The 120 s and 30 s timeouts are constants nobody has measured against a slow remote. They are the spec's numbers.

---

### Task 7: Pin proves the release runs (C2) and reads the job plist strictly (C3)

**Files:**
- Modify: `src/release_pin.ts` (eight `Edit` calls, listed below)
- Modify: `tests/harness.ts` (the release-pin fixture, `pinOpts`, and one `Edit` inserting six `release` tests)

**Interfaces:**
- Consumes (from Task 6, all exported by `src/release_pin.ts`): `setGitTimeouts`, `redactUserinfo`, `originCredentialRefusal`, `writeFileAtomic`. Task 6 must be committed first: this task's edits patch around its code.
- Produces:
  - `PinOptions.env?: NodeJS.ProcessEnv`: the environment of the proof run. Default `process.env`. The proof's login shell reads `$HOME/.profile` on Linux and macOS, so the tests give it a throwaway `HOME`.
  - In `src/release_pin.ts`, an internal `proveReleaseRuns(releaseDir, env)` returning `{ ok: true; version: string } | { ok: false; reason: string }`.
  - In the harness fixture: two more tags in the throwaway origin, `badexit` (a `bin/chamber.js` that writes `boom` to stderr and exits 1) and `wrongver` (prints `9.9.9` while its `package.json` says `1.0.4`); `v1` and `v2` gain a `package.json` (`1.0.1`, `1.0.2`) and a `bin/chamber.js` that prints that version; helpers `releaseTree`, `loginEnv`; `ReleaseFixture.badexit` and `.wrongver` (commit ids).

**Behaviour.**
- *C2.* After the checkout is on the tag and before the plist is read for writing, `pinRelease` runs `/bin/sh -lc 'node "$1" --version' sh <releaseDir>/bin/chamber.js` (the job's own login shell and `node`; 60 s timeout). It passes only if the exit code is 0 and the trimmed stdout equals the `version` in `<releaseDir>/package.json`. Otherwise `pinRelease` returns code 1 with `chamber pin: the release at <tag> did not run: <reason>`, the plist and launchd untouched and the checkout left on the tag. It runs every time, including when no job is installed. On success it adds the output line `the release runs: node bin/chamber.js --version printed <version>`.
- *C3.* `readJobPlist` removes XML comments (`<!-- ... -->`) before counting `<key>ProgramArguments</key>` and before looking for `<key>Program</key>`, so a commented-out block is ignored and a real one is still required exactly once; a `Program` key outside a comment is refused with a reason naming it (launchd runs `Program` instead of `ProgramArguments[0]`). `pinJobPlist` rewrites the live block, not the first textual match. The "launchctl load exited 0 but com.chamber.verify is not loaded" message now ends `, so the 08:30 job will not run; load it with: launchctl load <plist>`.

- [ ] **Step 1: Change the fixture and `pinOpts` in the harness**

Apply these nine `Edit` calls to `tests/harness.ts`, in this order. Each `old_string` is unique in the file. (`grep -n 'interface ReleaseFixture' tests/harness.ts` finds the area; use bounded reads only.)

**Edit 1 of 9** in `tests/harness.ts`. `old_string`:

```ts
interface ReleaseFixture {
  root: string;
  origin: string;
  source: string;
  releaseDir: string;
  plistPath: string;
  v1: string;
  v2: string;
  nobin: string;
}
```

`new_string`:

```ts
interface ReleaseFixture {
  root: string;
  origin: string;
  source: string;
  releaseDir: string;
  plistPath: string;
  v1: string;
  v2: string;
  nobin: string;
  badexit: string;
  wrongver: string;
}

/**
 * The two files pin runs: a package.json with `version`, and a bin/chamber.js
 * that prints `body`'s output for `--version` (by default, that same version).
 * `label` is a comment on the first line so every tag's bin differs.
 */
function releaseTree(
  label: string,
  version: string,
  body: string = `console.log(${JSON.stringify(version)});\n`,
): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ name: "chamber-fixture", version })}\n`,
    "bin/chamber.js": `// ${label}\n${body}`,
  };
}
```

**Edit 2 of 9** in `tests/harness.ts`. `old_string`:

```ts
  const v1 = fixtureCommit(origin, { "bin/chamber.js": "// v1\n", "README.md": "one\n" }, "v1");
```

`new_string`:

```ts
  const v1 = fixtureCommit(origin, { ...releaseTree("v1", "1.0.1"), "README.md": "one\n" }, "v1");
```

**Edit 3 of 9** in `tests/harness.ts`. `old_string`:

```ts
    { "bin/chamber.js": "// v2\n", "README.md": "two\n", "CHANGES.md": "two\n" },
```

`new_string`:

```ts
    { ...releaseTree("v2", "1.0.2"), "README.md": "two\n", "CHANGES.md": "two\n" },
```

**Edit 4 of 9** in `tests/harness.ts`. `old_string`:

```ts
  const nobin = fixtureCommit(origin, { "README.md": "three\n" }, "no bin", v2);
```

`new_string`:

```ts
  const nobin = fixtureCommit(origin, { "README.md": "three\n" }, "no bin", v2);
  // Both check out cleanly and have a bin/chamber.js, and neither runs right.
  const badexit = fixtureCommit(
    origin,
    { ...releaseTree("badexit", "1.0.3", 'process.stderr.write("boom\\n");\nprocess.exit(1);\n'), "README.md": "four\n" },
    "bin exits non-zero",
    v2,
  );
  const wrongver = fixtureCommit(
    origin,
    { ...releaseTree("wrongver", "1.0.4", 'console.log("9.9.9");\n'), "README.md": "five\n" },
    "bin prints another version",
    v2,
  );
```

**Edit 5 of 9** in `tests/harness.ts`. `old_string`:

```ts
  fixtureGit(origin, ["tag", "nobin", nobin]);
```

`new_string`:

```ts
  fixtureGit(origin, ["tag", "nobin", nobin]);
  fixtureGit(origin, ["tag", "badexit", badexit]);
  fixtureGit(origin, ["tag", "wrongver", wrongver]);
```

**Edit 6 of 9** in `tests/harness.ts`. `old_string`:

```ts
    v1,
    v2,
    nobin,
  };
}
```

`new_string`:

```ts
    v1,
    v2,
    nobin,
    badexit,
    wrongver,
  };
}
```

**Edit 7 of 9** in `tests/harness.ts`. `old_string`:

```ts
      readFileSync(join(fx.releaseDir, "bin", "chamber.js"), "utf8") === "// v1\n",
```

`new_string`:

```ts
      readFileSync(join(fx.releaseDir, "bin", "chamber.js"), "utf8") === releaseTree("v1", "1.0.1")["bin/chamber.js"],
```

**Edit 8 of 9** in `tests/harness.ts`. `old_string`:

```ts
      readFileSync(join(fx.releaseDir, "bin", "chamber.js"), "utf8") === "// v2\n",
```

`new_string`:

```ts
      readFileSync(join(fx.releaseDir, "bin", "chamber.js"), "utf8") === releaseTree("v2", "1.0.2")["bin/chamber.js"],
```

**Edit 9 of 9** in `tests/harness.ts`. `old_string`:

```ts
function pinOpts(fx: ReleaseFixture, tag: string, launchctl: Launchctl): PinOptions {
  return { tag, sourceRoot: fx.source, releaseDir: fx.releaseDir, plistPath: fx.plistPath, launchctl };
}
```

`new_string`:

```ts
/**
 * The environment pin's proof run gets. The job runs under `/bin/sh -lc`, and a
 * login shell on Linux resets PATH from /etc/profile, which drops the directory
 * `node` was found in on a CI runner. A throwaway HOME whose .profile puts this
 * process's node back stands in for the profile a real user has.
 */
function loginEnv(fx: ReleaseFixture): NodeJS.ProcessEnv {
  const home = join(fx.root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".profile"), `PATH="${dirname(process.execPath)}:$PATH"\nexport PATH\n`);
  return { ...process.env, HOME: home };
}

function pinOpts(fx: ReleaseFixture, tag: string, launchctl: Launchctl): PinOptions {
  return {
    tag,
    sourceRoot: fx.source,
    releaseDir: fx.releaseDir,
    plistPath: fx.plistPath,
    launchctl,
    env: loginEnv(fx),
  };
}
```

- [ ] **Step 2: Add the six tests**

`Edit` on `tests/harness.ts`: `old_string` `// ─── cli process smoke tests`, `new_string` the block below followed by `// ─── cli process smoke tests`.

```ts
// ─── pin proves the release runs before it rewrites the job ─────────────────

test("release", "a release whose bin exits non-zero is refused, and the plist and the job are untouched", () => {
  withReleaseFixture((fx) => {
    const bare = jobPlistXml(BARE_SCRIPT);
    writePlistFile(fx.plistPath, bare);
    const lc = fakeLaunchctl({ loaded: true });
    const r = pinRelease(pinOpts(fx, "badexit", lc.run));
    assert(r.code === 1, "a release that exits 1 was pinned");
    assert(
      r.err.some(
        (l) => l.startsWith("chamber pin: the release at badexit did not run: ") && l.includes("exited 1") && l.includes("boom"),
      ),
      r.err.join("\n"),
    );
    assert(readFileSync(fx.plistPath, "utf8") === bare, "the plist was rewritten for a release that does not run");
    assert(lc.calls.length === 0, `launchctl was called: ${lc.calls.join(" | ")}`);
    assert(headOf(fx.releaseDir) === fx.badexit, "the checkout must stay on the tag");
  });
});

test("release", "a release that prints another version is refused, and the plist and the job are untouched", () => {
  withReleaseFixture((fx) => {
    const bare = jobPlistXml(BARE_SCRIPT);
    writePlistFile(fx.plistPath, bare);
    const lc = fakeLaunchctl({ loaded: true });
    const r = pinRelease(pinOpts(fx, "wrongver", lc.run));
    assert(r.code === 1, "a release printing the wrong version was pinned");
    assert(
      r.err.some(
        (l) => l.startsWith("chamber pin: the release at wrongver did not run: ") && l.includes('"9.9.9"') && l.includes('"1.0.4"'),
      ),
      r.err.join("\n"),
    );
    assert(readFileSync(fx.plistPath, "utf8") === bare, "the plist was rewritten");
    assert(lc.calls.length === 0, `launchctl was called: ${lc.calls.join(" | ")}`);
    assert(headOf(fx.releaseDir) === fx.wrongver, "the checkout must stay on the tag");
  });
});

test("release", "the release is run even when no job is installed", () => {
  withReleaseFixture((fx) => {
    const bad = pinRelease(pinOpts(fx, "badexit", fakeLaunchctl({ loaded: false }).run));
    assert(bad.code === 1 && bad.err.some((l) => l.includes("did not run")), bad.err.join("\n"));
    assert(!existsSync(fx.plistPath), "pin created a plist");
    const good = pinRelease(pinOpts(fx, "v1", fakeLaunchctl({ loaded: false }).run));
    assert(good.code === 0, good.err.join("\n"));
    assert(good.out.some((l) => l.includes("the release runs")), good.out.join("\n"));
  });
});

// ─── job plist: comments, the Program key, and the not-loaded hint ──────────

/** The live job plist with `extra` placed above its <key>ProgramArguments</key>. */
function jobPlistWith(extra: string, script: string = BARE_SCRIPT): string {
  return jobPlistXml(script).replace("  <key>ProgramArguments</key>", `${extra}\n  <key>ProgramArguments</key>`);
}

const DEAD_BLOCK = [
  `<!--`,
  `  <key>ProgramArguments</key>`,
  `  <array>`,
  `    <string>/bin/sh</string>`,
  `    <string>-lc</string>`,
  `    <string>echo an older job</string>`,
  `  </array>`,
  `-->`,
].join("\n");

test("release", "a commented-out ProgramArguments block does not hide, or stand in for, the live one", () => {
  // A dead block above a live one: the live one is read, and the live one is rewritten.
  const both = jobPlistWith(DEAD_BLOCK);
  const read = readJobPlist(both);
  assert(read.ok && read.form === "bare", JSON.stringify(read));
  const pinned = pinJobPlist(both);
  const after = readJobPlist(pinned);
  assert(after.ok && after.form === "pinned", JSON.stringify(after));
  assert(pinned.includes(DEAD_BLOCK), "the commented-out block was changed");
  assert(pinned.includes("echo an older job"), "the commented-out block lost its text");

  // A dead block and nothing else is not a job.
  const onlyDead = jobPlistXml(BARE_SCRIPT).replace(
    /\s+<key>ProgramArguments<\/key>[\s\S]*?<\/array>/,
    DEAD_BLOCK,
  );
  const refused = readJobPlist(onlyDead);
  assert(!refused.ok && refused.reason.includes("exactly once"), JSON.stringify(refused));

  // A comment that merely mentions the key is not a second block either.
  const mention = readJobPlist(jobPlistWith("<!-- see <key>ProgramArguments</key> below -->"));
  assert(mention.ok && mention.form === "bare", JSON.stringify(mention));
});

test("release", "a Program key outside a comment is refused, because it overrides ProgramArguments[0]", () => {
  const withProgram = jobPlistWith("  <key>Program</key>\n  <string>/usr/bin/true</string>");
  const refused = readJobPlist(withProgram);
  assert(!refused.ok && refused.reason.includes("Program key"), JSON.stringify(refused));
  let threw = false;
  try {
    pinJobPlist(withProgram);
  } catch {
    threw = true;
  }
  assert(threw, "pinJobPlist rewrote a plist with a Program key");
  const commented = readJobPlist(jobPlistWith("<!-- <key>Program</key> was here -->"));
  assert(commented.ok, JSON.stringify(commented));
  // ProgramArguments itself is not the Program key.
  assert(readJobPlist(jobPlistXml(BARE_SCRIPT)).ok, "the plain job plist was refused");
});

test("release", "a load that exits 0 without loading the agent says the 08:30 job will not run and how to load it", () => {
  withReleaseFixture((fx) => {
    writePlistFile(fx.plistPath, jobPlistXml(BARE_SCRIPT));
    const r = pinRelease(pinOpts(fx, "v1", fakeLaunchctl({ loaded: false, load: "lies" }).run));
    assert(r.code === 1, "an agent that never loaded was reported loaded");
    assert(
      r.err.some(
        (l) =>
          l.includes(`launchctl load exited 0 but ${JOB_LABEL} is not loaded`) &&
          l.includes("the 08:30 job will not run") &&
          l.includes(`load it with: launchctl load ${fx.plistPath}`),
      ),
      r.err.join("\n"),
    );
  });
});

```

- [ ] **Step 3: Run the release suite and see the right six fail**

```bash
node --experimental-strip-types tests/harness.ts --suite=release 2>&1 | grep "FAIL\|passed"
```

Expected exactly these six failures, and every older release test still passing:

```
[FAIL] release/a release whose bin exits non-zero is refused, and the plist and the job are untouched
[FAIL] release/a release that prints another version is refused, and the plist and the job are untouched
[FAIL] release/the release is run even when no job is installed
[FAIL] release/a commented-out ProgramArguments block does not hide, or stand in for, the live one
[FAIL] release/a Program key outside a comment is refused, because it overrides ProgramArguments[0]
[FAIL] release/a load that exits 0 without loading the agent says the 08:30 job will not run and how to load it
── 40/46 passed · 6 failed ──
```

(The counts differ if another PR added release tests; the six names are what matter.) The fixture change is visible in the passing ones: `pinOpts` now passes `env`, which `PinOptions` does not declare yet, and type stripping does not mind.

- [ ] **Step 4: Change `src/release_pin.ts`**

Apply these eight `Edit` calls, in this order.

**Edit 1 of 8** in `src/release_pin.ts`. `old_string`:

```ts
// `&amp;` last, so `&amp;lt;` decodes once, to `&lt;`, and not on to `<`.
```

`new_string`:

```ts
const XML_COMMENT = /<!--[\s\S]*?-->/g;

function stripXmlComments(xml: string): string {
  return xml.replace(XML_COMMENT, "");
}

/**
 * The ProgramArguments block that is not inside an XML comment. The shipped
 * template explains itself in comments, and a user may keep an old block
 * commented out above the live one; the first match in the raw text is then the
 * dead one.
 */
function findProgramArguments(xml: string): RegExpExecArray | null {
  const comments = [...xml.matchAll(XML_COMMENT)].map((c) => [c.index, c.index + c[0].length] as const);
  const all = new RegExp(PROGRAM_ARGUMENTS.source, "g");
  for (let m = all.exec(xml); m !== null; m = all.exec(xml)) {
    if (!comments.some(([from, to]) => m!.index >= from && m!.index < to)) return m;
  }
  return null;
}

// `&amp;` last, so `&amp;lt;` decodes once, to `&lt;`, and not on to `<`.
```

**Edit 2 of 8** in `src/release_pin.ts`. `old_string`:

```ts
export function readJobPlist(xml: string): JobPlistRead {
  if (xml.split("<key>ProgramArguments</key>").length !== 2) {
    return { ok: false, reason: "ProgramArguments does not appear exactly once" };
  }
  const m = PROGRAM_ARGUMENTS.exec(xml);
```

`new_string`:

```ts
export function readJobPlist(xml: string): JobPlistRead {
  const live = stripXmlComments(xml);
  if (live.split("<key>ProgramArguments</key>").length !== 2) {
    return { ok: false, reason: "ProgramArguments does not appear exactly once" };
  }
  // launchd runs `Program` instead of ProgramArguments[0] when both exist, so a
  // plist with the key could run something other than the script checked below.
  if (/<key>\s*Program\s*<\/key>/.test(live)) {
    return { ok: false, reason: "it has a Program key, which overrides ProgramArguments[0]" };
  }
  const m = findProgramArguments(xml);
```

**Edit 3 of 8** in `src/release_pin.ts`. `old_string`:

```ts
  // A replacer function, not a replacement string: the script is full of `$`,
  // and String.prototype.replace reads `$'` and `$&` in a string as patterns.
  return xml.replace(
    PROGRAM_ARGUMENTS,
    (_all: string, head: string, _shell: string, _flag: string, _script: string, tail: string) =>
      `${head}${encodeXmlText(PINNED_SCRIPT)}${tail}`,
  );
```

`new_string`:

```ts
  const m = findProgramArguments(xml);
  if (m === null) throw new Error("ProgramArguments vanished between the read and the rewrite");
  // Spliced by position, not with String.prototype.replace: the script is full
  // of `$`, which replace reads as a pattern, and the match to rewrite is the
  // live block, which need not be the first one in the text.
  const head = m[1] ?? "";
  const tail = m[5] ?? "";
  return (
    xml.slice(0, m.index) + head + encodeXmlText(PINNED_SCRIPT) + tail + xml.slice(m.index + m[0].length)
  );
```

**Edit 4 of 8** in `src/release_pin.ts`. `old_string`:

```ts
export interface PinOptions extends CheckoutOptions {
  plistPath: string;
  launchctl: Launchctl;
}
```

`new_string`:

```ts
export interface PinOptions extends CheckoutOptions {
  plistPath: string;
  launchctl: Launchctl;
  /**
   * The environment the proof run gets (its HOME decides which login profile
   * the shell reads). Defaults to process.env.
   */
  env?: NodeJS.ProcessEnv;
}
```

**Edit 5 of 8** in `src/release_pin.ts`. `old_string`:

```ts
/**
 * `chamber pin <tag>`. The installed job is checked before the checkout
```

`new_string`:

```ts
const RUN_PROOF_TIMEOUT_MS = 60_000;

/**
 * Run the release the way the job will: the same `/bin/sh -lc`, the same
 * `node`. A tag that checks out cleanly can still fail to run (a Node too old,
 * a `node` the login shell cannot find, a bin that throws), and without this
 * pin would rewrite the job to a release that cannot start, and the next
 * morning's check would not happen.
 */
type RunProof = { ok: true; version: string } | { ok: false; reason: string };

function proveReleaseRuns(releaseDir: string, env: NodeJS.ProcessEnv): RunProof {
  const pkgPath = join(releaseDir, "package.json");
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown }).version;
  } catch (e) {
    return { ok: false, reason: `${pkgPath} cannot be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof version !== "string" || version === "") return { ok: false, reason: `${pkgPath} has no version` };

  const r = spawnSync("/bin/sh", ["-lc", 'node "$1" --version', "sh", join(releaseDir, "bin", "chamber.js")], {
    encoding: "utf8",
    env,
    timeout: RUN_PROOF_TIMEOUT_MS,
  });
  if (r.error !== undefined) {
    const timedOut = (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return { ok: false, reason: timedOut ? `it did not finish in ${RUN_PROOF_TIMEOUT_MS / 1000}s` : String(r.error) };
  }
  if (r.status !== 0) {
    const said = (r.stderr ?? "").trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    return { ok: false, reason: `it exited ${r.status ?? `from signal ${r.signal}`}${said !== "" ? `: ${said}` : ""}` };
  }
  const printed = (r.stdout ?? "").trim();
  if (printed !== version) {
    return {
      ok: false,
      reason: `--version printed ${JSON.stringify(printed.slice(0, 80))}, but its package.json says ${JSON.stringify(version)}`,
    };
  }
  return { ok: true, version };
}

/**
 * `chamber pin <tag>`. The installed job is checked before the checkout
```

**Edit 6 of 8** in `src/release_pin.ts`. `old_string`:

```ts
 * bin/chamber.js on disk. With no job installed, the checkout is still
 * pinned and the run exits 0.
 */
```

`new_string`:

```ts
 * bin/chamber.js on disk and after that release has run once, `--version`,
 * under the job's own login shell. With no job installed, the checkout is
 * still pinned and, if the release runs, the run exits 0.
 */
```

**Edit 7 of 8** in `src/release_pin.ts`. `old_string`:

```ts
  if (!existsSync(opts.plistPath)) {
    out.push(`no LaunchAgent was installed at ${opts.plistPath}; nothing else was changed`);
```

`new_string`:

```ts
  const proof = proveReleaseRuns(opts.releaseDir, opts.env ?? process.env);
  if (!proof.ok) {
    err.push(`chamber pin: the release at ${opts.tag} did not run: ${proof.reason}`);
    err.push(`${opts.releaseDir} stays on ${opts.tag}; the job and its plist were not changed`);
    return { code: 1, out, err };
  }
  out.push(`the release runs: node bin/chamber.js --version printed ${proof.version}`);
  if (!existsSync(opts.plistPath)) {
    out.push(`no LaunchAgent was installed at ${opts.plistPath}; nothing else was changed`);
```

**Edit 8 of 8** in `src/release_pin.ts`. `old_string`:

```ts
    err.push(`chamber pin: launchctl load exited 0 but ${JOB_LABEL} is not loaded`);
```

`new_string`:

```ts
    err.push(
      `chamber pin: launchctl load exited 0 but ${JOB_LABEL} is not loaded, so the 08:30 job will not run; ` +
        `load it with: launchctl load ${plistPath}`,
    );
```

- [ ] **Step 5: Typecheck, lint, run the release suite**

```bash
npx tsc --noEmit; echo "tsc exit: $?"
npx eslint src/release_pin.ts tests/harness.ts; echo "eslint exit: $?"
node --experimental-strip-types tests/harness.ts --suite=release 2>&1 | grep "FAIL\|passed"
```

Expected: both exit codes 0 and `N/N passed · 0 failed` with no `FAIL` line.

- [ ] **Step 6: Run the four gates, then commit**

```bash
git status --short     # src/release_pin.ts and tests/harness.ts only
git add src/release_pin.ts tests/harness.ts
git commit -m "fix: make chamber pin prove the release runs, and read the job plist strictly

- After the checkout is on the tag, pin runs the release's bin/chamber.js
  --version under /bin/sh -lc (the job's own shell and node). Anything but exit
  0 and a version equal to package.json's is a refusal that leaves the job and
  its plist alone. It runs even when no job is installed.
- readJobPlist ignores XML comments, so a commented-out ProgramArguments block
  neither counts nor hides the live one, and refuses a Program key, which
  overrides ProgramArguments[0]. pinJobPlist rewrites the live block.
- The not-loaded message says the 08:30 job will not run and how to load it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Run the real path, end to end, with a throwaway HOME**

The tests use a fixture origin and a login-shell profile they write themselves. Also run the real thing once, against the real `v0.1.9` tag, from a local clone, so that the proof run uses a real `bin/chamber.js` and a real `node`. **No plist exists in this HOME, so `launchctl` is never called; do not create one.**

```bash
C=$(mktemp -d); H=$(mktemp -d)
git clone -q --no-hardlinks . "$C/clone"
(cd "$C/clone" && HOME="$H" node --experimental-strip-types src/cli.ts pin v0.1.9; echo "pin exit: $?")
(cd "$C/clone" && HOME="$H" node --experimental-strip-types src/cli.ts pin v0.1.9; echo "second pin exit: $?")
rm -rf "$C" "$H"
```

The clone has the committed `HEAD`, which is why this step comes after the commit. Expected, both times: `... is on v0.1.9 (bf5e10289878)` (`already on` the second time), `the release runs: node bin/chamber.js --version printed 0.1.9`, `no LaunchAgent was installed at <H>/Library/LaunchAgents/com.chamber.verify.plist; nothing else was changed`, and exit 0. If `v0.1.9` is not in your clone's tags, stop and report; do not fetch from the network to get it.

- [ ] **Step 8: Mutation proofs**

Use the script from Task 6 Step 7 (recreate `$S/mutate_pin.py` from that step if your shell is new):

```bash
python3 "$S/mutate_pin.py" 7
git checkout -- src/release_pin.ts
git diff --stat
```

Expected, one line per mutation:

```
M8 no proof run -> 3 failing: [FAIL] release/a release whose bin exits non-zero is refused, ...; [FAIL] release/a release that prints another version is refused, ...; [FAIL] release/the release is run even when no job is installed
M9 version not compared -> 1 failing: [FAIL] release/a release that prints another version is refused, and the plist and the job are untouched
M10 exit status ignored -> 1 failing: [FAIL] release/a release whose bin exits non-zero is refused, and the plist and the job are untouched
M11 Program key allowed -> 1 failing: [FAIL] release/a Program key outside a comment is refused, because it overrides ProgramArguments[0]
M12 comments not stripped -> 2 failing: [FAIL] release/a commented-out ProgramArguments block does not hide, or stand in for, the live one; [FAIL] release/a Program key outside a comment is refused, ...
M13 first match used, live or dead -> 1 failing: [FAIL] release/a commented-out ProgramArguments block does not hide, or stand in for, the live one
M14 no not-running hint -> 1 failing: [FAIL] release/a load that exits 0 without loading the agent says the 08:30 job will not run and how to load it
```

M8's third failing test can be reported in a different order. If a line says `NO TEST FAILED` or `ANCHOR COUNT`, stop and report. The final `git diff --stat` prints nothing.

**Not caught by the gates:**
- The tests give the proof run a `HOME` whose `.profile` puts this process's `node` on `PATH`. That stands in for a user's real profile and is what makes the tests pass on a CI runner, where `/etc/profile` resets `PATH`. It proves pin runs `node` the way the job does, and says nothing about whether the owner's real login profile finds `node`. The first real `chamber pin` on the owner's Mac is the test of that, and it is the owner's to run (not an agent's; see Global Constraints).
- A `<key>Program</key>` spelled with entities or odd whitespace inside the tags is only partly covered (`<key>` then optional whitespace then `Program`). The plist script check (`script === BARE_SCRIPT || PINNED_SCRIPT`) is still the closed-set gate for what runs.
- A comment inside the `ProgramArguments` array itself splits the block, so the read reports that it is not `/bin/sh -lc` followed by one script. That is a refusal, not an acceptance.
- The 60 s timeout on the proof is the spec's number; a `--version` that takes longer on a cold disk is refused as "did not finish".

---

### Task 8: Daily snapshot: exit status, stale labels, release checkout, plist (C4)

**Files:**
- Modify (whole file, keep mode `100755`): `scripts/daily-snapshot.sh`
- Modify: `deploy/launchd/com.chamber.daily-snapshot.plist` (two `Edit` calls)
- Modify: `tests/harness.ts` (one `Edit` inserting three `release` tests)

**Interfaces:** none consumed or produced. The script reads `HOME`, `CHAMBER_REPO` (default `$HOME/Projects/chamber`) and `CHAMBER_REPORT_DIR` as before. It now also reads `$HOME/.local/share/chamber-release/bin/chamber.js`, the file `chamber pin` creates.

**Behaviour.**
- *`rc` bug.* The Drift section runs `chamber verify` once, captures its exit status on the very next line (`verify_rc=$?`), prints the output through `tail -30`, and prints `verify exit code: $verify_rc`. Before, `$?` was read after an `echo`, so it was always 0.
- *Release command.* `verify` and `corpus` run as `node "$HOME/.local/share/chamber-release/bin/chamber.js" <command>`. If that file is missing, the report says `release checkout missing: run chamber pin <tag>` in the Drift and Corpus sections (and `verify exit code: n/a`) and never calls the `chamber` on `PATH`.
- *Gates section* keeps reporting on the development checkout (`REPO`), as do the Ledger and Repository sections.
- *Stale labels.* The two `<- known-failing, KNOWN_LIMITATIONS ...` suffixes in the probe list are removed.
- *Shellcheck* is clean: besides the `rc` warning (SC2320) the old script had SC1083 on the unquoted `@{u}..HEAD`, now single-quoted.
- *Plist.* The template runs `$HOME/.local/share/chamber-release/scripts/daily-snapshot.sh`; the job's `/bin/sh -lc` expands `$HOME` (the log paths keep the `REPLACE_WITH_HOME` placeholder that `sed` fills in).

- [ ] **Step 1: See shellcheck fail on the current script**

```bash
command -v shellcheck || echo "shellcheck NOT available"
shellcheck scripts/daily-snapshot.sh; echo "shellcheck exit: $?"
```

Expected: `SC2320` (line 53, `echo "verify exit code: $?"`) and `SC1083` (line 130, `@{u}`), `shellcheck exit: 1`. If `shellcheck` is missing, the lint steps are `NOT RUN`; the harness tests below still run.

- [ ] **Step 2: Write the failing tests**

`Edit` on `tests/harness.ts`: `old_string` `// ─── cli process smoke tests`, `new_string` the block below followed by `// ─── cli process smoke tests`. The first two tests run the real script in a throwaway `HOME`, with a fake `chamber` on `PATH` that announces itself, so a report containing its output proves the dev command was called. `CHAMBER_REPO` names a directory that does not exist, which stops the script at the Gates section without running the test suite.

```ts
// ─── daily snapshot: release checkout, exit status, plist ───────────────────

/**
 * Run scripts/daily-snapshot.sh in a throwaway HOME and return the report it
 * wrote. CHAMBER_REPO names a directory that does not exist, so the script's
 * Gates section stops at its `cd` and the run needs no test suite and no
 * probes. A `chamber` that announces itself is first on PATH, so a report that
 * contains its output was produced by the development command.
 */
function runSnapshot(home: string, release: { verifyExit: number } | null): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "chamber"), '#!/bin/sh\necho "DEV CHAMBER CALLED: $*"\nexit 7\n');
  chmodSync(join(bin, "chamber"), 0o755);
  if (release !== null) {
    const dir = join(home, ".local", "share", "chamber-release", "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "chamber.js"),
      [
        "const cmd = process.argv[2];",
        'if (cmd === "verify") {',
        '  console.log("3 belief(s) checked, 1 with no verified support left, 0 with some support lost");',
        `  process.exit(${release.verifyExit});`,
        "}",
        'if (cmd === "corpus") console.log("corpus from the release checkout");',
        "",
      ].join("\n"),
    );
  }
  const r = spawnSync("sh", [join(root, "scripts", "daily-snapshot.sh")], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      CHAMBER_REPO: join(home, "no-dev-checkout"),
      CHAMBER_REPORT_DIR: join(home, "reports"),
    },
  });
  assert(r.error === undefined, `the script did not run: ${r.error}`);
  const day = spawnSync("date", ["+%Y-%m-%d"], { encoding: "utf8" }).stdout.trim();
  return readFileSync(join(home, "reports", `${day}.md`), "utf8");
}

test("release", "the daily snapshot records verify's own exit status from the release checkout", () => {
  const home = mkdtempSync(join(tmpdir(), "chamber-snapshot-"));
  try {
    const report = runSnapshot(home, { verifyExit: 1 });
    assert(report.includes("3 belief(s) checked, 1 with no verified support left"), report);
    assert(report.includes("corpus from the release checkout"), "the Corpus section did not run the release checkout");
    assert(/^verify exit code: 1$/m.test(report), `the report must carry verify's exit status (1):\n${report}`);
    assert(!report.includes("DEV CHAMBER CALLED"), "the report ran the chamber on PATH");
    assert(!report.includes("release checkout missing"), "the release checkout was there");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("release", "the daily snapshot says the release checkout is missing instead of calling the dev chamber", () => {
  const home = mkdtempSync(join(tmpdir(), "chamber-snapshot-"));
  try {
    const report = runSnapshot(home, null);
    const said = report.split("release checkout missing: run chamber pin <tag>").length - 1;
    assert(said === 2, `expected the message in the Drift and Corpus sections, found it ${said} times:\n${report}`);
    assert(/^verify exit code: n\/a$/m.test(report), `no exit status to report:\n${report}`);
    assert(!report.includes("DEV CHAMBER CALLED"), "the report ran the chamber on PATH");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("release", "the daily snapshot has no stale labels, and its plist runs the release checkout's copy", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const script = readFileSync(join(root, "scripts", "daily-snapshot.sh"), "utf8");
  assert(!script.includes("known-failing"), "a stale known-failing label is back");
  const plist = readFileSync(join(root, "deploy", "launchd", "com.chamber.daily-snapshot.plist"), "utf8");
  assert(
    plist.includes("<string>$HOME/.local/share/chamber-release/scripts/daily-snapshot.sh</string>"),
    "the plist does not run the release checkout's copy of the script",
  );
  assert(!plist.includes("Projects/chamber/scripts"), "the plist still names the development checkout");
});

```

- [ ] **Step 3: Run them and see all three fail**

```bash
node --experimental-strip-types tests/harness.ts --suite=release 2>&1 | grep "snapshot\|FAIL"
```

Expected three `[FAIL]` lines, for `the daily snapshot records verify's own exit status from the release checkout`, `... says the release checkout is missing instead of calling the dev chamber`, and `... has no stale labels, and its plist runs the release checkout's copy`.

- [ ] **Step 4: Replace `scripts/daily-snapshot.sh`**

Write the whole file with exactly this content. Relative to `ccdf148` the changes are: the header comment paragraph on the two checkouts, `RELEASE_BIN` and `RELEASE_MISSING`, the Drift and Corpus sections, the two probe lines without labels, and the quoted `'@{u}..HEAD'`.

````sh
#!/bin/sh
# Collect one day's Chamber facts into a dated file.
#
# The analysis half of the daily report is written by a person or an agent
# reading this file. This half only has to be *true* and to still exist
# tomorrow, which is why it is a shell script on a schedule rather than
# something that depends on any session being alive.
#
# Every number here comes from a command. Nothing is estimated, and a failing
# command prints its failure rather than being skipped — a missing line and a
# zero line mean very different things, and a report that cannot tell them
# apart is not worth reading.
#
# Exit code is deliberately 0 even when checks fail: this is a recorder, not a
# gate. `chamber verify` is the gate, and it runs separately at 08:30.
#
# Two checkouts are involved and they are not interchangeable. The Drift and
# Corpus sections run the release checkout that `chamber pin <tag>` keeps, the
# same code the 08:30 job ran, so the report describes what actually checked
# the evidence. The Ledger, Gates and Repository sections describe the
# development checkout (REPO) on purpose: they report on the work in progress.

set -u

REPO="${CHAMBER_REPO:-$HOME/Projects/chamber}"
RELEASE_BIN="$HOME/.local/share/chamber-release/bin/chamber.js"
RELEASE_MISSING="release checkout missing: run chamber pin <tag>"
# Exported because the inline node script below reads it from the environment.
# It is single-quoted there so the shell leaves it alone, which means an
# unexported REPO resolves to `undefined` and the import fails with
# ERR_MODULE_NOT_FOUND — the whole Ledger section replaced by a stack trace.
export REPO
OUT_DIR="${CHAMBER_REPORT_DIR:-$HOME/Library/Logs/chamber-daily}"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$(date '+%Y-%m-%d').md"

# Measured separately, never as `cmd | tail; echo $?` — that reports tail's
# exit status, not the command's. This mistake has been made twice in this
# project and both times inverted the result being recorded.
probe_exit() {
  # $1 = probe filename, $2… = leading env assignments
  _p="$1"
  shift
  env "$@" timeout 150 node --experimental-strip-types "$REPO/probes/$_p" >/dev/null 2>&1
  echo "$?"
}

{
  echo "# Chamber — $(date '+%A %d %B %Y')"
  echo
  echo "_Collected $(date '+%H:%M %Z') by scripts/daily-snapshot.sh_"
  echo

  echo "## Drift"
  echo
  echo '```'
  # One run, and its exit status captured on the very next line: `$?` after a
  # pipeline or after an `echo` is the status of tail or of echo, not of verify.
  if [ -f "$RELEASE_BIN" ]; then
    verify_out=$(node "$RELEASE_BIN" verify 2>&1)
    verify_rc=$?
    printf '%s\n' "$verify_out" | tail -30
  else
    verify_rc="n/a"
    echo "$RELEASE_MISSING"
  fi
  echo '```'
  echo
  echo "verify exit code: $verify_rc"
  echo
  echo "### The 08:30 scheduled run"
  echo
  if [ -f "$HOME/Library/Logs/chamber-verify.log" ]; then
    echo '```'
    # Last run only (the log is appended to forever), and within it only the
    # lines that answer a question. `chamber ingest` prints hundreds of
    # skipped-entry lines — dotted files, unsupported extensions — which are
    # correct behaviour and pure noise here. Showing them buried the verify
    # verdict 25 lines deep on the first run of this script.
    awk '/^=== chamber /{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' \
      "$HOME/Library/Logs/chamber-verify.log" \
      | grep -E '^=== |^  database|belief\(s\) checked|pins verified|hash_mismatch|not_found|ingest FAILED|^ingested' \
      | tail -20
    echo '```'
  else
    echo "**The scheduled job has never written a log.** A scheduler that"
    echo "silently stopped looks identical to a clean result, so this line"
    echo "matters: check \`launchctl list | grep chamber\`."
  fi
  echo

  echo "## Corpus"
  echo
  echo '```'
  if [ -f "$RELEASE_BIN" ]; then
    node "$RELEASE_BIN" corpus 2>&1 | head -30
  else
    echo "$RELEASE_MISSING"
  fi
  echo '```'
  echo

  echo "## Ledger"
  echo
  echo '```'
  node --experimental-strip-types --input-type=module -e '
    const { openChamberDb } = await import(process.env.REPO + "/src/db.ts");
    const db = openChamberDb(process.env.HOME + "/.local/share/chamber/chamber.sqlite");
    const one = (label, sql, ...p) => {
      try { console.log(label.padEnd(26) + db.prepare(sql).get(...p).c); }
      catch (e) { console.log(label.padEnd(26) + "ERROR: " + e.message); }
    };
    const since = new Date(Date.now() - 864e5).toISOString();
    one("beliefs (total)",        "SELECT COUNT(*) c FROM belief");
    one("beliefs (24h)",          "SELECT COUNT(*) c FROM belief WHERE created_at > ?", since);
    one("open citation debt",     "SELECT COUNT(*) c FROM citation_debt WHERE status IN (?,?)", "pending", "proposed_paid");
    one("pending writes",         "SELECT COUNT(*) c FROM pending_write WHERE status = ?", "pending");
    one("audit events (24h)",     "SELECT COUNT(*) c FROM audit_event WHERE created_at > ?", since);
    one("gate events (24h)",      "SELECT COUNT(*) c FROM gate_event WHERE created_at > ?", since);
    one("sessions (24h)",         "SELECT COUNT(*) c FROM session WHERE started_at > ?", since);
    try {
      const { verifyAuditChain } = await import(process.env.REPO + "/src/audit.ts");
      console.log("audit chain".padEnd(26) + JSON.stringify(verifyAuditChain(db)));
    } catch (e) { console.log("audit chain".padEnd(26) + "ERROR: " + e.message); }
  ' 2>&1
  echo '```'
  echo

  echo "## Gates"
  echo
  cd "$REPO" 2>/dev/null || exit 0
  echo '```'
  npm run test 2>&1 | tail -2
  printf 'typecheck errors: '
  npx tsc --noEmit 2>&1 | grep -c "error TS"
  echo
  echo "probe exit codes (0 = the defect it asserts is absent):"
  echo "  gate_audit            $(probe_exit gate_audit.ts)"
  echo "  pin_bypass            $(probe_exit pin_bypass.ts)"
  echo "  verify_partial_drift  $(probe_exit verify_partial_drift.ts)"
  echo "  debt_paraphrase       $(probe_exit debt_paraphrase.ts)"
  echo "  sandbox_escape        $(probe_exit sandbox_escape.ts CHAMBER_SANDBOX_REQUIRED=1)"
  echo '```'
  echo

  echo "## Repository"
  echo
  echo '```'
  echo "HEAD:     $(git -C "$REPO" rev-parse --short HEAD) on $(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  echo "unpushed: $(git -C "$REPO" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 'no upstream')"
  echo "dirty:    $(git -C "$REPO" status --porcelain | wc -l | tr -d ' ') file(s)"
  echo
  echo "commits in the last 24h:"
  git -C "$REPO" log --since="24 hours ago" --oneline || echo "  (none)"
  echo '```'
} > "$OUT" 2>&1

echo "wrote $OUT"
````

Then confirm the file mode survived:

```bash
git ls-files -s scripts/daily-snapshot.sh      # still starts with 100755
git diff --summary scripts/daily-snapshot.sh   # prints no "mode change" line
ls -l scripts/daily-snapshot.sh                # -rwxr-xr-x
```

If the mode changed, `chmod 755 scripts/daily-snapshot.sh`: the launchd job runs the file as a command.

- [ ] **Step 5: Edit the plist**

Two `Edit` calls on `deploy/launchd/com.chamber.daily-snapshot.plist`, in this order.

**Edit 1 of 2** in `deploy/launchd/com.chamber.daily-snapshot.plist`. `old_string`:

```xml
    Output is a dated markdown file per day, which is what makes the record
    survive a session ending -- the analysis half can be written later, by
    anyone, from a file that is still there.
  -->
```

`new_string`:

```xml
    Output is a dated markdown file per day, which is what makes the record
    survive a session ending -- the analysis half can be written later, by
    anyone, from a file that is still there.

    It runs the copy of the script inside the release checkout that
    `chamber pin <tag>` keeps, not the development checkout, so the report
    describes the release the 08:30 job ran and not whatever branch happens to
    be checked out at 10:07. The job's login shell expands $HOME. A release tag
    older than the one that first contains this path has the previous script,
    which calls the `chamber` on PATH; see deploy/SCHEDULING.md.
  -->
```

**Edit 2 of 2** in `deploy/launchd/com.chamber.daily-snapshot.plist`. `old_string`:

```xml
    <string>REPLACE_WITH_HOME/Projects/chamber/scripts/daily-snapshot.sh</string>
```

`new_string`:

```xml
    <string>$HOME/.local/share/chamber-release/scripts/daily-snapshot.sh</string>
```

The new comment has no `--` in it on purpose (the old text already has some; do not add more).

- [ ] **Step 6: Run the tests, shellcheck, and the plist linter**

```bash
node --experimental-strip-types tests/harness.ts --suite=release 2>&1 | grep "snapshot\|FAIL\|passed"
shellcheck scripts/daily-snapshot.sh; echo "shellcheck exit: $?"
sh -n scripts/daily-snapshot.sh && echo "sh syntax ok"
plutil -lint deploy/launchd/com.chamber.daily-snapshot.plist || echo "plutil NOT RUN or failed"
```

Expected: the three snapshot tests `[PASS]` and `N/N passed · 0 failed`; `shellcheck exit: 0`; `sh syntax ok`; `deploy/launchd/com.chamber.daily-snapshot.plist: OK`. (`plutil` exists on macOS only; elsewhere write `NOT RUN`. Do not use Python's `plistlib` on this file: the existing comment contains `--`, which a strict XML parser rejects and `plutil` accepts.)

- [ ] **Step 7: Run the four gates, then commit**

```bash
git status --short     # deploy/launchd/com.chamber.daily-snapshot.plist, scripts/daily-snapshot.sh, tests/harness.ts only
git add deploy/launchd/com.chamber.daily-snapshot.plist scripts/daily-snapshot.sh tests/harness.ts
git commit -m "fix: make the daily snapshot report verify's real exit status and the release it ran

- The exit status is captured right after chamber verify; it used to be read
  after an echo and was always 0.
- verify and corpus run the pinned release checkout; when it is missing the
  report says to run chamber pin instead of calling the dev chamber.
- The stale known-failing labels are gone, and shellcheck is clean.
- The launchd template runs the release checkout's copy of the script.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Mutation proofs**

```bash
run() { node --experimental-strip-types tests/harness.ts --suite=release 2>&1 | grep "FAIL" | cut -c1-150; }

# (a) the old script and the old plist
git show HEAD~1:scripts/daily-snapshot.sh > scripts/daily-snapshot.sh
git show HEAD~1:deploy/launchd/com.chamber.daily-snapshot.plist > deploy/launchd/com.chamber.daily-snapshot.plist
run; shellcheck scripts/daily-snapshot.sh >/dev/null; echo "old script shellcheck exit: $?"
git checkout -- scripts/daily-snapshot.sh deploy/launchd/com.chamber.daily-snapshot.plist

# (b) the exit status is not captured
python3 - <<'EOF'
p = "scripts/daily-snapshot.sh"
s = open(p).read()
old = "    verify_rc=$?\n"
assert s.count(old) == 1
open(p, "w").write(s.replace(old, "    verify_rc=0\n"))
EOF
run; git checkout -- scripts/daily-snapshot.sh

# (c) the dev chamber is called when the release is missing
python3 - <<'EOF'
p = "scripts/daily-snapshot.sh"
s = open(p).read()
old = '    verify_rc="n/a"\n    echo "$RELEASE_MISSING"'
assert s.count(old) == 1
open(p, "w").write(s.replace(old, "    chamber verify 2>&1 | tail -30\n    verify_rc=$?"))
EOF
run; git checkout -- scripts/daily-snapshot.sh
git diff --stat
```

Expected: (a) three `[FAIL]` lines and `old script shellcheck exit: 1`; (b) only `the daily snapshot records verify's own exit status from the release checkout`; (c) only `the daily snapshot says the release checkout is missing instead of calling the dev chamber`; and an empty final `git diff --stat`.

**Not caught by the gates:**
- The tests never reach the Ledger, Gates (`npm test`, `tsc`, probes) or Repository sections: `CHAMBER_REPO` points nowhere, on purpose, so the run takes a fraction of a second and needs no database. A defect in those sections is outside what these tests see. `shellcheck` and `sh -n` cover their syntax only.
- The probe lines still call `timeout 150 node ...`; `timeout` is not on macOS unless coreutils is installed, so on a bare Mac those exit codes read `127`. That is existing behaviour and out of this task's scope.
- A release tag older than the one that contains this script keeps the old script, and the plist now points at the release checkout's copy of it. That is why Task 9 adds the effective-date note to `deploy/SCHEDULING.md`: pinning v0.1.9 and loading this plist runs v0.1.9's old script, with the old `rc` bug.

---

### Task 9: Docs (C5) and the changelog

**Files:**
- Create: `docs/BACKUP.md`
- Modify: `deploy/PILOT.md`, `docs/KNOWN_LIMITATIONS.md`, `README.md`, `benchmarks/BENCHMARK.md`, `deploy/SCHEDULING.md`, `CHANGELOG.md`
- Modify: `tests/harness.ts` (one `config` test that keeps these documents in step with the code)

**Interfaces:** consumes the behaviour of Tasks 5 and 8 (the bwrap flags and probe, the daily snapshot), and documents Tasks 1 to 8 in the changelog. Produces nothing for code.

**Everything here must be true of the tree you are standing in.** The texts below were checked against `ccdf148` plus Tasks 1 to 8. After the rebase, the runtime-hardening PR may have changed `sandboxRequired()` and `docs/KNOWN_LIMITATIONS.md` entry 4. Step 1 finds out which wording of entry 1 is true; do not edit entry 4 or anything else that PR owns.

- [ ] **Step 1: Find out what `CHAMBER_SANDBOX_REQUIRED` does by default, and how many limitations there are**

Run all three. They only read.

```bash
# unset: does a non-isolating backend run? (backend forced to "subprocess" so the answer does not depend on this machine)
env -u CHAMBER_SANDBOX_REQUIRED CHAMBER_SANDBOX_BACKEND=subprocess node --experimental-strip-types -e '
import("./src/sandbox.ts").then((m) => {
  const r = m.runInSandbox({ runtime: "bash", source: "echo hi", timeoutMs: 5000 });
  console.log(r.ok ? "DEFAULT_OFF" : "DEFAULT_ON: " + r.error);
});'

# control: the same call with the flag set must refuse, or the command above proves nothing
CHAMBER_SANDBOX_REQUIRED=1 CHAMBER_SANDBOX_BACKEND=subprocess node --experimental-strip-types -e '
import("./src/sandbox.ts").then((m) => {
  const r = m.runInSandbox({ runtime: "bash", source: "echo hi", timeoutMs: 5000 });
  console.log(r.ok ? "DEFAULT_OFF" : "DEFAULT_ON: " + r.error);
});'

grep -c '^## ' docs/KNOWN_LIMITATIONS.md
```

Expected at `ccdf148`: `DEFAULT_OFF`, then `DEFAULT_ON: sandbox required but subprocess does not isolate (isolating backends: bwrap)`, then `20`. The control line must read `DEFAULT_ON: ...`; if it reads `DEFAULT_OFF`, stop and report.

- First line `DEFAULT_OFF`: use **entry 1 text A** (Step 5).
- First line `DEFAULT_ON: ...`: use **entry 1 text B** (Step 5).
- The count is the number of limitations the README must state. The README edit below says `Twenty`. If the count is not 20, change that word in the `new_string` of the README edit (Step 6, Edit 4) to: 17 `Seventeen`, 18 `Eighteen`, 19 `Nineteen`, 21 `Twenty-one`, 22 `Twenty-two`. (The new test fails with the count it found if you get it wrong.)

- [ ] **Step 2: Write the failing test**

`Edit` on `tests/harness.ts`: `old_string` `// ─── cli process smoke tests`, `new_string` the block below followed by `// ─── cli process smoke tests`.

```ts
test("config", "the docs agree with the code: limitation count, sandbox claims, backup pointer, verify samples", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");

  // README states how many limitations the file documents.
  const limits = read("docs", "KNOWN_LIMITATIONS.md");
  const entries = (limits.match(/^## /gm) ?? []).length;
  const words = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "twenty-one",
    "twenty-two", "twenty-three", "twenty-four", "twenty-five", "twenty-six", "twenty-seven", "twenty-eight",
    "twenty-nine", "thirty",
  ];
  const readme = read("README.md");
  const said = /([A-Za-z]+(?:-[a-z]+)?) limitations are documented there/.exec(readme);
  assert(said !== null, "README no longer says how many limitations are documented");
  assert(
    words.indexOf(said[1]!.toLowerCase()) === entries,
    `README says "${said[1]}" limitations; docs/KNOWN_LIMITATIONS.md has ${entries} entries`,
  );

  // The sandbox is described as it is in src/sandbox.ts, everywhere it was described.
  assert(!limits.includes("## 1. The sandbox does not isolate"), "entry 1 still has the old title");
  assert(
    limits.includes("probes/sandbox_confines.ts") && limits.includes("ISOLATING_BACKENDS"),
    "entry 1 does not describe the bwrap backend and its probe",
  );
  assert(!readme.includes("does not fail closed"), "README still says CHAMBER_SANDBOX_REQUIRED does not fail closed");
  assert(read("benchmarks", "BENCHMARK.md").includes("As of 2026-08-02 the sandbox did not isolate"), "BENCHMARK T1 row lost its date");
  assert(!limits.includes("one was closed in deploy: `src/checkpoint_export.ts`"), "entry 3 still claims a scheduled export");

  // Backups.
  const pilot = read("deploy", "PILOT.md");
  assert(!pilot.includes("cp chamber.sqlite chamber.sqlite.bak"), "PILOT.md still tells the operator to cp the database");
  assert(pilot.includes("docs/BACKUP.md"), "PILOT.md does not point at docs/BACKUP.md");
  const backup = read("docs", "BACKUP.md");
  for (const needle of [".backup", "VACUUM INTO", "-wal", "-shm", "chamber config show", "chamber verify", "chamber checkpoint verify", "chmod 600"]) {
    assert(backup.includes(needle), `docs/BACKUP.md does not mention ${needle}`);
  }

  // Scheduling: samples as verify prints them now, and the two operator notes.
  const sched = read("deploy", "SCHEDULING.md");
  for (const line of sched.split("\n").filter((l) => l.includes("belief(s) checked"))) {
    assert(line.endsWith("with some support lost"), `a sample verify line is missing the last count: ${line}`);
  }
  assert((sched.match(/^=== verify exit \d ===$/gm) ?? []).length >= 3, "the samples do not end with the job's exit line");
  assert((sched.match(/^ {2}database = .*\[from default\]$/gm) ?? []).length >= 3, "the samples do not show the database line");
  assert(sched.includes("not over\nSSH") && sched.includes("`unload` stops the job"), "the pin notes are missing");
  assert(sched.includes("This takes effect for a release tag that contains this script"), "the daily-snapshot effective-date note is missing");
});

```

- [ ] **Step 3: Run it and see it fail**

```bash
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -A1 "FAIL"
```

Expected: `[FAIL] config/the docs agree with the code: ...` with `README says "Eighteen" limitations; docs/KNOWN_LIMITATIONS.md has 20 entries` (the numbers follow Step 1).

- [ ] **Step 4: Create `docs/BACKUP.md`**

````md
# Backing up the Chamber database

Chamber keeps its state in one SQLite file: beliefs, citation pins, the audit
chain, checkpoints, approvals, spend and the job queue. Your notes are not in
it. They stay where they are, and `chamber ingest` rebuilds the corpus from
them, but a belief and the pins it was committed against exist only here.

## Where the database is

```bash
chamber config show
```

The `database = ...` line is the path, and the bracket after it says where the
path came from (`[from default]`, `[from env]` or `[from config]`).

## Take a backup while Chamber is running

Use SQLite's own backup, not `cp`:

```bash
umask 077
sqlite3 "$DB" ".backup '$DEST'"
```

or, on SQLite 3.27 or newer:

```bash
umask 077
sqlite3 "$DB" "VACUUM INTO '$DEST'"
```

`$DB` is the path from `chamber config show` and `$DEST` is a file that does
not exist yet (`VACUUM INTO` refuses to overwrite). Both give a consistent
snapshot of the committed state while other processes read and write.

Chamber runs its database in WAL mode. A committed write lands first in the
`-wal` file next to the database and reaches the main file only at a later
checkpoint. So a plain `cp chamber.sqlite backup.sqlite` can copy a main file
that does not contain transactions Chamber has already acknowledged, and it can
copy it halfway through a write. In a test with a WAL database that had not yet
checkpointed, the `cp` copy had lost a whole table that `.backup` and
`VACUUM INTO` kept. A backup that cannot be told from a good one until the day
you restore it is worse than none.

Keep backups private. The database holds the text of your notes' passages and
your audit trail:

```bash
chmod 600 "$DEST"
```

Keep them in a directory only you can read (`chmod 700`). The `umask 077` above
makes the backup file `0600` from the start.

## Restore

1. Stop everything that writes to the database. On macOS that is the scheduled
   job; on a server it is the service and the timer:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.chamber.verify.plist
   # or: sudo systemctl stop chamber.service chamber-jobs.timer chamber-jobs.service
   ```

   `unload` stops a job that is running at that moment. Do this when it is not.

2. Replace the file and remove the old write-ahead files. A `-wal` or `-shm`
   file left over from the database you are replacing belongs to that database,
   and SQLite would apply it to the restored one:

   ```bash
   cp "$BACKUP" "$DB"
   chmod 600 "$DB"
   rm -f "$DB-wal" "$DB-shm"
   ```

3. Check it:

   ```bash
   chamber verify
   ```

   `verify` re-checks every stored pin against the corpus as it is now. If you
   restored a database older than your last `chamber ingest`, run
   `chamber ingest` first so the corpus matches.

4. Start the jobs again:

   ```bash
   launchctl load ~/Library/LaunchAgents/com.chamber.verify.plist
   # or: sudo systemctl start chamber.service chamber-jobs.timer
   ```

## After a restore, check the checkpoint

A restored database is an older chain, and an older chain is exactly what a
checkpoint receipt exists to expose. `chamber checkpoint` records the audit
chain's length and root at the moment it runs, and writes an entry to the anchor
log. `chamber checkpoint verify` holds a receipt against the database as it is
now:

```bash
chamber checkpoint verify <receipt>
```

It prints one line each for `signature`, `chain`, `anchors` and `history`, and
exits 1 if any of them fails. If the receipt, or an anchor in the log, was made
*after* the moment your backup was taken, the restored chain is shorter than
what they attest, and `chain`, `anchors` or `history` says so. That failure is
the correct answer, not a fault in the restore: it is the record that the
writes between the backup and the failure are gone. A receipt older than the
backup still verifies.

Run it after every restore, and read the failure if there is one, because a
restored older database is also what a rollback by someone else looks like.
Take a fresh checkpoint once you are satisfied with the restored database, so
the next restore has something recent to compare against, and copy the anchor
log somewhere this machine cannot rewrite.
````

- [ ] **Step 5: Replace entry 1 of `docs/KNOWN_LIMITATIONS.md`**

Entry 1 runs from the line `## 1. The sandbox does not isolate` up to, not including, the line `## 2. A citation can be genuine and still be wrong`. Write the text for the variant Step 1 chose to a scratch file outside the worktree (`S=$(mktemp -d)`; `$S/entry1.md`), then run the replace script from the worktree root. The two texts differ only in the paragraph that starts `**What \`CHAMBER_SANDBOX_REQUIRED\` does.**`.

Text A (unset means off):

```md
## 1. The sandbox isolates only on Linux with bubblewrap, and nothing isolates on macOS

`src/sandbox.ts` knows three backends, and only one of them isolates anything.

- **`bwrap`** (Linux, with `bubblewrap` installed) runs the payload with a short
  allowlist of read-only system directories (`/usr`, `/bin`, `/sbin`, `/lib`,
  `/lib64` and the runtime's own prefix), a fresh `/dev` and `/proc`, a tmpfs
  `/tmp`, and the work directory. It unshares the network, pid, ipc and uts
  namespaces and starts a new terminal session. `$HOME`, `~/.ssh`, `~/.secrets`
  and the Chamber database are simply not mounted. It is the only member of
  `ISOLATING_BACKENDS`.
- **`docker`** is reported when a `docker` binary is on `PATH`, but there is no
  `runDocker`. A run on this backend is dispatched to the plain subprocess
  runner and relabelled `"subprocess"` in the result, so it isolates nothing.
- **`subprocess`** is a child process with a scrubbed environment and nothing
  else. It reads `$HOME`, `~/.ssh` and `~/.secrets`, writes outside its working
  directory and reaches the network. `probes/sandbox_escape.ts` reproduces that
  when the flag below is off.

There is no macOS backend. `probes/seatbelt/` records what `sandbox-exec` can and
cannot enforce (the workable profile still leaves `$HOME` readable) and nothing
more, so on a Mac every run is the subprocess backend or a refusal.

**What `CHAMBER_SANDBOX_REQUIRED` does.** Unset, or set to `0`, `false`, `no` or
`off`, it is off: `runInSandbox` runs the payload on whatever backend was
detected, including the subprocess backend, as your user. Any other value turns
it on, and then a run is refused unless the backend is in `ISOLATING_BACKENDS`
(`sandbox required but docker does not isolate`) and the backend has first
confined a probe of its own: a payload that must fail to read `/etc/passwd` and
fail to connect to `1.1.1.1`. A `bwrap` that is a stub, or that cannot create a
namespace, is refused with `did not confine a probe`. An unrecognised spelling
counts as on, so a typo keeps the promise instead of dropping it.

**What proves it.** Two probes, and they answer different questions.
`probes/sandbox_escape.ts` (part of `npm run probes`, run with the flag on)
passes when the payload does not escape, and it passes on a Mac because nothing
ran: a refusal and a contained run look the same to it. `probes/sandbox_confines.ts`
(`npm run probes:isolation`) demands the other half. The payload must run, and it
must fail to read `/etc/passwd`, fail to reach the network, and fail to see a
host process (the probe starts a sleeping child with a random marker in its
command line, checks that a scan of `/proc` finds it outside the sandbox, and
then requires the scan inside to find nothing). It can only pass on Linux with a
working `bwrap`, and CI runs it there. On a machine where it cannot pass, the
sandbox has not been shown to confine anything.

**What it does not cover.** The probe has no needle for the ipc and uts
namespaces or for the new terminal session; they are set in `runBwrap` and
nothing checks them. Nothing limits memory, CPU or process count beyond a
wall-clock timeout and an output cap. Every bind is read-only except the tmpfs
`/tmp` and the work directory, which is deliberate, but a payload can still
fill them.

**What it costs.** Less than the old probe output suggested, and you should know
why. No agent loop in the shipped code sends model-written code to the sandbox.
Three paths run source that did not come from Chamber: `chamber tool synth`
(`synthesizeTool` in `src/tools.ts`), `runTool` for a registered tool, and
`verifyMcpToolSource` in `src/mcp_bridge.ts` for a tool declared by an imported
MCP manifest. On Linux with `bwrap` they are confined as above. Anywhere else,
with the flag off, they run with your full user privileges, and "it ran in the
sandbox" is not a safety statement. With the flag on they refuse, which is safe
and means a Mac cannot run them at all.

**What would fix it.** A `runDocker` (`docker run --rm --network none --read-only
--memory 512m --pids-limit 128`) would give macOS an isolating backend and give
every backend resource limits, and the `docker` branch should stop relabelling
itself `subprocess` in the meantime. Until then, treat a Mac as a machine with no
sandbox. This is `docs/NEXT_LEVEL_PLAN.md` Phase 1.1.

```

Text B (unset means on):

```md
## 1. The sandbox isolates only on Linux with bubblewrap, and nothing isolates on macOS

`src/sandbox.ts` knows three backends, and only one of them isolates anything.

- **`bwrap`** (Linux, with `bubblewrap` installed) runs the payload with a short
  allowlist of read-only system directories (`/usr`, `/bin`, `/sbin`, `/lib`,
  `/lib64` and the runtime's own prefix), a fresh `/dev` and `/proc`, a tmpfs
  `/tmp`, and the work directory. It unshares the network, pid, ipc and uts
  namespaces and starts a new terminal session. `$HOME`, `~/.ssh`, `~/.secrets`
  and the Chamber database are simply not mounted. It is the only member of
  `ISOLATING_BACKENDS`.
- **`docker`** is reported when a `docker` binary is on `PATH`, but there is no
  `runDocker`. A run on this backend is dispatched to the plain subprocess
  runner and relabelled `"subprocess"` in the result, so it isolates nothing.
- **`subprocess`** is a child process with a scrubbed environment and nothing
  else. It reads `$HOME`, `~/.ssh` and `~/.secrets`, writes outside its working
  directory and reaches the network. `probes/sandbox_escape.ts` reproduces that
  when the flag below is off.

There is no macOS backend. `probes/seatbelt/` records what `sandbox-exec` can and
cannot enforce (the workable profile still leaves `$HOME` readable) and nothing
more, so on a Mac every run is the subprocess backend or a refusal.

**What `CHAMBER_SANDBOX_REQUIRED` does.** Unset, it is on. Only `0`, `false`,
`no` or `off` turn it off, and then `runInSandbox` runs the payload on whatever
backend was detected, including the subprocess backend, as your user. While it
is on, a run is refused unless the backend is in `ISOLATING_BACKENDS`
(`sandbox required but docker does not isolate`) and the backend has first
confined a probe of its own: a payload that must fail to read `/etc/passwd` and
fail to connect to `1.1.1.1`. A `bwrap` that is a stub, or that cannot create a
namespace, is refused with `did not confine a probe`. An unrecognised spelling
counts as on, so a typo keeps the promise instead of dropping it.

**What proves it.** Two probes, and they answer different questions.
`probes/sandbox_escape.ts` (part of `npm run probes`, run with the flag on)
passes when the payload does not escape, and it passes on a Mac because nothing
ran: a refusal and a contained run look the same to it. `probes/sandbox_confines.ts`
(`npm run probes:isolation`) demands the other half. The payload must run, and it
must fail to read `/etc/passwd`, fail to reach the network, and fail to see a
host process (the probe starts a sleeping child with a random marker in its
command line, checks that a scan of `/proc` finds it outside the sandbox, and
then requires the scan inside to find nothing). It can only pass on Linux with a
working `bwrap`, and CI runs it there. On a machine where it cannot pass, the
sandbox has not been shown to confine anything.

**What it does not cover.** The probe has no needle for the ipc and uts
namespaces or for the new terminal session; they are set in `runBwrap` and
nothing checks them. Nothing limits memory, CPU or process count beyond a
wall-clock timeout and an output cap. Every bind is read-only except the tmpfs
`/tmp` and the work directory, which is deliberate, but a payload can still
fill them.

**What it costs.** Less than the old probe output suggested, and you should know
why. No agent loop in the shipped code sends model-written code to the sandbox.
Three paths run source that did not come from Chamber: `chamber tool synth`
(`synthesizeTool` in `src/tools.ts`), `runTool` for a registered tool, and
`verifyMcpToolSource` in `src/mcp_bridge.ts` for a tool declared by an imported
MCP manifest. On Linux with `bwrap` they are confined as above. Anywhere else,
with the flag off, they run with your full user privileges, and "it ran in the
sandbox" is not a safety statement. With the flag on they refuse, which is safe
and means a Mac cannot run them at all.

**What would fix it.** A `runDocker` (`docker run --rm --network none --read-only
--memory 512m --pids-limit 128`) would give macOS an isolating backend and give
every backend resource limits, and the `docker` branch should stop relabelling
itself `subprocess` in the meantime. Until then, treat a Mac as a machine with no
sandbox. This is `docs/NEXT_LEVEL_PLAN.md` Phase 1.1.

```

The replace script, saved as `$S/replace_entry1.py`:

```python
import sys

# usage: replace_entry1.py <file holding the new entry 1 text>
p = "docs/KNOWN_LIMITATIONS.md"
s = open(p, encoding="utf8").read()
start = s.index("## 1. The sandbox does not isolate")
end = s.index("## 2. A citation can be genuine and still be wrong")
assert 0 <= start < end
new = open(sys.argv[1], encoding="utf8").read()
assert new.startswith("## 1. ") and new.endswith("\n\n")
open(p, "w", encoding="utf8").write(s[:start] + new + s[end:])
```

```bash
python3 "$S/replace_entry1.py" "$S/entry1.md"
git diff --stat
grep -c '^## ' docs/KNOWN_LIMITATIONS.md      # unchanged from Step 1
```

Expected: only `docs/KNOWN_LIMITATIONS.md` changed, and the heading count is what it was. The script refuses (an `assert`) if either heading is missing or the new text does not start with `## 1. ` and end with a blank line.

- [ ] **Step 6: Apply the other fifteen edits**

Apply these `Edit` calls in this order, each to the file it names. They are: `deploy/PILOT.md` (1), `docs/KNOWN_LIMITATIONS.md` (2: the intro sentence and entry 3's correction), `README.md` (1), `benchmarks/BENCHMARK.md` (1), `deploy/SCHEDULING.md` (9: what verify exits on, the two pin notes, the three sample outputs, the exit-contract sentence, and the new daily-snapshot section) and `CHANGELOG.md` (1). Whether or not you include the final newline of a block, include it in both `old_string` and `new_string`. The `CHANGELOG.md` edit adds one new subsection under `## Unreleased`, just above `## 0.1.9`; it does not touch the headings another change may have put under Unreleased.

**Edit 1 of 15** in `deploy/PILOT.md`. `old_string`:

```md
- [ ] SQLite path backed up (`cp chamber.sqlite chamber.sqlite.bak`)
```

`new_string`:

```md
- [ ] SQLite path backed up with `sqlite3 ... ".backup"`, not `cp` (see [docs/BACKUP.md](../docs/BACKUP.md))
```

**Edit 2 of 15** in `docs/KNOWN_LIMITATIONS.md`. `old_string`:

```md
than skimmed: the sandbox does not isolate, and a citation can be genuine and still be
wrong.
```

`new_string`:

```md
than skimmed: the sandbox isolates only on Linux with bubblewrap, and a citation can be
genuine and still be wrong.
```

**Edit 3 of 15** in `docs/KNOWN_LIMITATIONS.md`. `old_string`:

```md
> **Correction, 2026-08-13.** Two of this entry's three claims have since been closed
> in code and one was closed in deploy: `src/checkpoint_export.ts` now generates an
> ed25519 keypair and signs receipts, the default output path is config-resolved
> rather than `/tmp`, and `deploy/launchd/com.chamber.daily-snapshot.plist` runs the
> export on a schedule. What still stands is the ceiling the last paragraph names:
```

`new_string`:

```md
> **Correction, 2026-08-13, corrected again 2026-10-21.** Two of this entry's three
> claims have since been closed in code: `src/checkpoint_export.ts` now generates an
> ed25519 keypair and signs receipts, and the default output path is config-resolved
> rather than `/tmp`. The 2026-08-13 version of this note said the third was closed
> in deploy because `deploy/launchd/com.chamber.daily-snapshot.plist` "runs the export
> on a schedule". It does not: that plist runs `scripts/daily-snapshot.sh`, which
> writes a daily report and never calls `chamber checkpoint`, and nothing else in the
> repository schedules one, so a checkpoint is still never taken automatically. What
> also still stands is the ceiling the last paragraph names:
```

**Edit 4 of 15** in `README.md`. `old_string`:

```md
any output. Eighteen limitations are documented there, including the two least
flattering. The sandbox does not isolate: a docker detection can relabel to a
subprocess, `CHAMBER_SANDBOX_REQUIRED=1` does not fail closed, and a probed run
read `$HOME` and resolved DNS (`docs/KNOWN_LIMITATIONS.md` §1). That path is off
`chamber_check`. Do not read "sandbox" as containment. Citation debt blocks a
```

`new_string`:

```md
any output. Twenty limitations are documented there, including the two least
flattering. The sandbox isolates only on Linux with bubblewrap installed; on macOS
nothing isolates, and a docker detection is relabelled to a plain subprocess
(`docs/KNOWN_LIMITATIONS.md` §1). That path is off `chamber_check`. Do not read
"sandbox" as containment unless `probes/sandbox_confines.ts` passes on the machine
that runs it. Citation debt blocks a
```

**Edit 5 of 15** in `benchmarks/BENCHMARK.md`. `old_string`:

```md
| T1 (Chamber) | 2 | 1 | The sandbox does not isolate. `CHAMBER_SANDBOX_REQUIRED=1` is unreachable, no `runDocker` exists, and a live probe read `$HOME`, wrote to it, and resolved DNS while reporting `backend: "docker"`. |
```

`new_string`:

```md
| T1 (Chamber) | 2 | 1 | As of 2026-08-02 the sandbox did not isolate: `CHAMBER_SANDBOX_REQUIRED=1` was unreachable, no `runDocker` existed, and a live probe read `$HOME`, wrote to it, and resolved DNS while reporting `backend: "docker"`. Since then a bwrap backend confines on Linux (`probes/sandbox_confines.ts` is the evidence) and the flag fails closed. `runDocker` still does not exist and macOS has no isolating backend (`docs/KNOWN_LIMITATIONS.md` §1), so the score stays 1. |
```

**Edit 6 of 15** in `deploy/SCHEDULING.md`. `old_string`:

```md
is now. It exits non-zero exactly when a belief has no verified support left,
which makes it usable as an unattended check.
```

`new_string`:

```md
is now. It exits non-zero exactly when a stored pin no longer verifies, either
because a belief has no verified support left or because it has lost some of it,
which makes it usable as an unattended check.
```

**Edit 7 of 15** in `deploy/SCHEDULING.md`. `old_string`:

```md
nothing else. Check the log after the first run rather than assuming.
```

`new_string`:

```md
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
```

**Edit 8 of 15** in `deploy/SCHEDULING.md`. `old_string`:

````md
```
=== chamber 2026-08-03T08:30:00+0400 ===
ingested 412 file(s) as 3907 passage(s) from /Users/you/Vault

0 belief(s) checked, 0 with no verified support left
```
````

`new_string`:

````md
```
=== chamber 2026-08-03T08:30:00+0400 ===
  database = /Users/you/.local/share/chamber/chamber.sqlite   [from default]
ingested 412 file(s) as 3907 passage(s) from /Users/you/Vault

0 belief(s) checked, 0 with no verified support left, 0 with some support lost
=== verify exit 0 ===
```

The `database` line says which file was checked. The last line is the job's
exit status, which is `verify`'s.
````

**Edit 9 of 15** in `deploy/SCHEDULING.md`. `old_string`:

````md
```
blf_c8a38d3d16b7f617  0/1 pins verified
````

`new_string`:

````md
```
=== chamber 2026-08-03T08:30:00+0400 ===
  database = /Users/you/.local/share/chamber/chamber.sqlite   [from default]
ingested 412 file(s) as 3907 passage(s) from /Users/you/Vault
blf_c8a38d3d16b7f617  0/1 pins verified
````

**Edit 10 of 15** in `deploy/SCHEDULING.md`. `old_string`:

````md
1 belief(s) checked, 1 with no verified support left
```
````

`new_string`:

````md
1 belief(s) checked, 1 with no verified support left, 0 with some support lost
=== verify exit 1 ===
```

A belief that lost only some of its pins is counted in the last number instead
(`0 with no verified support left, 1 with some support lost`). It exits 1 too:
losing part of the evidence is drift.
````

**Edit 11 of 15** in `deploy/SCHEDULING.md`. `old_string`:

````md
```
=== chamber 2026-08-03T08:30:00+0400 ===
ingest: no path given and no roots configured
````

`new_string`:

````md
```
=== chamber 2026-08-03T08:30:00+0400 ===
  database = /Users/you/.local/share/chamber/chamber.sqlite   [from default]
ingest: no path given and no roots configured
````

**Edit 12 of 15** in `deploy/SCHEDULING.md`. `old_string`:

````md
!! ingest FAILED (exit 1) - verifying against the corpus as it stands, which may be stale

0 belief(s) checked, 0 with no verified support left
```
````

`new_string`:

````md
!! ingest FAILED (exit 1) - verifying against the corpus as it stands, which may be stale

0 belief(s) checked, 0 with no verified support left, 0 with some support lost
=== verify exit 0 ===
```
````

**Edit 13 of 15** in `deploy/SCHEDULING.md`. `old_string`:

```md
contract: non-zero iff a belief has no verified support left. Folding ingest's
```

`new_string`:

```md
contract: non-zero iff a stored pin no longer verifies. Folding ingest's
```

**Edit 14 of 15** in `deploy/SCHEDULING.md`. `old_string`:

```md
## Linux (cron)
```

`new_string`:

````md
## Daily snapshot (macOS)

`scripts/daily-snapshot.sh` writes one dated Markdown report a day to
`~/Library/Logs/chamber-daily/`: the drift result, the corpus, the ledger
counts, the gates and the repository state. It records and does not judge, so it
exits 0 even when a check inside it fails; `chamber verify` is the gate.

The template runs the copy of the script inside the release checkout, so the
report describes the release the 08:30 job ran. Its Drift and Corpus sections run
that checkout's `bin/chamber.js`. If the checkout is missing, the report says
`release checkout missing: run chamber pin <tag>` and does not fall back to the
`chamber` on your `PATH`. The Ledger, Gates and Repository sections describe your
development checkout (`CHAMBER_REPO`, default `~/Projects/chamber`).

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
````

**Edit 15 of 15** in `CHANGELOG.md`. `old_string`:

```md
## 0.1.9 — 2026-10-03
```

`new_string`:

```md
### Supply chain, CI, `chamber pin` and docs

- **Dependency advisories.** `npm audit fix` moved `proxy-addr` (critical) and
  `brace-expansion` (high) inside their ranges in `package-lock.json`;
  `npm audit` now reports 0. CI fails on `npm audit --audit-level=high`.
- **CI installs and scans.** The embedder's Python packages come from
  `scripts/requirements-embed.txt`, pinned with hashes and installed with
  `--require-hashes`. A new job runs gitleaks 8.30.1 (checked against a
  SHA-256) over the whole history, and the image job now builds and scans both
  `Dockerfile` and `deploy/Dockerfile` under the same trivy gate. Dependabot
  opens weekly updates for npm, GitHub Actions and both Dockerfiles.
- **The stdio image is cleaned like the deploy image.** The root `Dockerfile`
  now runs `apt-get upgrade` and removes npm, npx and corepack; the image had
  three fixable HIGH findings and now has none.
- **MiniLM weights are checked before they load.** `scripts/embed_minilm.py`
  hashes `model_quantized.onnx` and compares it with `models/minilm/VERSION`;
  a mismatch, a missing `VERSION` or a missing `SHA-256:` line exits 3 in every
  mode, before the model is imported. The TypeScript side treats it like any
  other embedder failure.
- **One version everywhere.** `server.json` said 0.1.10 while the package said
  0.1.9, and the MCP server reported a third, hand-typed copy. The server now
  reads `package.json`, `server.json` agrees, and a test fails when any of
  them, or the newest CHANGELOG heading, disagree.
- **`chamber-jobs.service` is hardened** with the directives
  `chamber.service` already had, including a `@system-service` syscall filter.
- **The bwrap sandbox unshares more.** `--unshare-pid`, `--unshare-ipc`,
  `--unshare-uts` and `--new-session` join `--unshare-net`. A payload's `/proc`
  used to list every host process. `probes/sandbox_confines.ts` checks the pid
  namespace with a process needle that it first proves visible without the
  sandbox.
- **`chamber pin` runs the release before it rewrites the job.** After the
  checkout, `node bin/chamber.js --version` must run under `/bin/sh -lc` and
  print the version in `package.json`; otherwise pin exits 1 and leaves the job
  alone. The plist is replaced atomically, git runs with prompts off and
  without inherited `GIT_DIR`, with timeouts, an http(s) origin carrying
  credentials is refused, and a commented-out `ProgramArguments` block or a
  `Program` key no longer confuses the plist check.
- **The daily snapshot reports what happened.** `verify exit code` was always
  0 (it read `$?` after an `echo`); it now carries verify's status. Drift and
  Corpus run the pinned release checkout, or say to run `chamber pin`. The
  launchd template runs the release checkout's copy of the script, which takes
  effect for a tag that contains it.
- **Docs.** New `docs/BACKUP.md` (live backups with `.backup`, not `cp`;
  restore; `chamber checkpoint verify` afterwards). `docs/KNOWN_LIMITATIONS.md`
  entry 1 describes the sandbox as it is, entry 3 no longer claims a scheduled
  export, and the README's count and sandbox sentence match. The sample outputs
  in `deploy/SCHEDULING.md` match what `chamber verify` prints.

## 0.1.9 — 2026-10-03
```

- [ ] **Step 7: Run the test and see it pass**

```bash
node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep "docs agree\|FAIL\|passed"
```

Expected: `[PASS]` for the new test and `N/N passed · 0 failed`.

- [ ] **Step 8: Read what you wrote**

Prose that is wrong passes a test. Check these by eye and by command, and fix the text, not the test:

```bash
grep -n "sandbox" README.md | sed -n 1,12p
sed -n '/^## 1\. /,/^## 2\. /p' docs/KNOWN_LIMITATIONS.md | grep -n "ISOLATING_BACKENDS\|sandbox_confines\|runDocker\|CHAMBER_SANDBOX_REQUIRED"
grep -n "belief(s) checked" deploy/SCHEDULING.md
git diff --stat
```

- Every `belief(s) checked` line in `deploy/SCHEDULING.md` ends with `with some support lost`.
- Entry 1 says `runDocker` does not exist, names `probes/sandbox_confines.ts`, and agrees with the variant Step 1 chose.
- `git diff --stat` lists only the seven documentation files plus `tests/harness.ts`, and `docs/BACKUP.md` as untracked.

- [ ] **Step 9: Run the four gates, then commit**

```bash
git status --short     # CHANGELOG.md README.md benchmarks/BENCHMARK.md deploy/PILOT.md deploy/SCHEDULING.md docs/BACKUP.md docs/KNOWN_LIMITATIONS.md tests/harness.ts only
git add CHANGELOG.md README.md benchmarks/BENCHMARK.md deploy/PILOT.md deploy/SCHEDULING.md docs/BACKUP.md docs/KNOWN_LIMITATIONS.md tests/harness.ts
git commit -m "docs: add the backup guide and correct the sandbox, scheduling and checkpoint docs

- docs/BACKUP.md: live backups with .backup or VACUUM INTO (not cp, which can
  miss committed WAL data), restore, and chamber checkpoint verify afterwards.
- KNOWN_LIMITATIONS entry 1 describes the bwrap backend and its probe, the
  missing runDocker, and the absence of any isolation on macOS; entry 3 no
  longer claims the daily-snapshot plist exports a checkpoint.
- README, BENCHMARK and SCHEDULING agree with that and with what chamber
  verify prints now; SCHEDULING gains the desktop-Terminal and unload notes
  and the daily-snapshot section.
- PILOT.md points at BACKUP.md; the changelog records this PR.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Mutation proofs**

Each stale document, put back, must turn the same test red:

```bash
run() { node --experimental-strip-types tests/harness.ts --suite=config 2>&1 | grep -A1 "FAIL.*docs agree" | tail -1; }
for f in README.md deploy/PILOT.md deploy/SCHEDULING.md benchmarks/BENCHMARK.md docs/KNOWN_LIMITATIONS.md; do
  git show HEAD~1:$f > $f; echo "== old $f"; run; git checkout -- $f
done
mv docs/BACKUP.md "$S/BACKUP.md.keep"; echo "== no docs/BACKUP.md"; run; mv "$S/BACKUP.md.keep" docs/BACKUP.md
git status --short
git diff --stat
```

Expected, in order: `README says "Eighteen" limitations; ...`; `PILOT.md still tells the operator to cp the database`; `a sample verify line is missing the last count: ...`; `BENCHMARK T1 row lost its date`; `entry 1 still has the old title`; `ENOENT ... docs/BACKUP.md`; and no `git status` or `git diff` output at the end (the mutations are all restored; `docs/BACKUP.md` is committed, so it must not show as deleted).

**Not caught by the gates:**
- Prose can be wrong while the test passes. The test checks the count, the dropped stale claims, the pointers, and the shape of the samples; it cannot check that `docs/BACKUP.md`'s restore procedure works. Its facts were verified on 2026-10-21: in a WAL database that had not yet checkpointed, a `cp` of the main file lost a whole table that `sqlite3 ".backup"` and `VACUUM INTO` kept; `chamber checkpoint verify <receipt>` prints `signature`, `chain`, `anchors` and `history` lines and sets exit 1 on any failure. The restore itself was not run on a live Chamber database. Say so in the report.
- Entry 1 describes `src/sandbox.ts` as of Task 5. If the runtime-hardening PR changed what `runInSandbox` refuses, re-read `runInSandbox` and `sandboxRequired` once more against the paragraph Step 1 picked.
- `docs/KNOWN_LIMITATIONS.md` entry 13 (the scheduled job's log names neither its database nor its exit status) is now plainly out of date, because the job prints both. The spec does not list it, so it is left alone; mention it in the report as a follow-up.
- The sample database path in `deploy/SCHEDULING.md` (`/Users/you/.local/share/chamber/chamber.sqlite`) is an example, as the old `/Users/you/Vault` was.

---

## Branch hand-off (no task, no commit)

After Task 9, from the worktree root, report these and stop. Do not push; the owner's push gate (a real review, an audit, two secret scanners in both modes, then the owner's decision) comes before anything leaves this machine.

```bash
S=$(mktemp -d)
git log --oneline origin/main..HEAD            # the spec commit, then one or two commits per task
git diff --stat origin/main..HEAD | tail -3
npm run typecheck && npm run lint               # then the two below, each read to its own last line
npm test
npm run probes
gitleaks git --redact --no-banner --exit-code=2 . > "$S/gl-git.txt" 2>&1; echo "gitleaks git exit: $?"; tail -2 "$S/gl-git.txt"
gitleaks dir --redact --no-banner --exit-code=2 . > "$S/gl-dir.txt" 2>&1; echo "gitleaks dir exit: $?"; tail -2 "$S/gl-dir.txt"
rm -rf "$S"
```

In the report, list: which steps were `NOT RUN` and why (docker, trivy, shellcheck, uv, actionlint, plutil); the baseline-versus-final probe results; the three things the owner may want to act on (the `image` job's new check names, the first real `chamber pin` on the owner's Mac, and `docs/KNOWN_LIMITATIONS.md` entry 13); and that no tool exercised the CI jobs themselves, only CI can.
