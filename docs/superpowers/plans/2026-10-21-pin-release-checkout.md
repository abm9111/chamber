# Pin the 08:30 job to a release checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `chamber pin <tag>` keeps `~/.local/share/chamber-release` detached at a release tag. The 08:30 LaunchAgent runs that checkout's `bin/chamber.js` through `node`, not the `chamber` that `npm link` points at the development checkout.

**Architecture:** One new module, `src/release_pin.ts`, has three layers. The first is pure text: the job script is generated twice from one function (bare `chamber`, and the release command), and an installed plist is accepted only when its script decodes to exactly one of those two strings. The second is `pinCheckout`, which validates the tag name, the source checkout and the release directory, then fetches `refs/tags/<tag>`, checks the tag's tree for `bin/chamber.js`, and moves `HEAD`. The third is `pinRelease`. It reads the plist before anything moves, calls `pinCheckout`, then rewrites the plist and reloads the agent through an injected `launchctl`. `src/cli.ts` routes `pin` before config load, like `init` and `config`.

**Tech Stack:** TypeScript run directly by Node (`--experimental-strip-types`, `engines` `>=23.6`), `node:child_process` `spawnSync` for `git` and `launchctl`, the existing `tests/harness.ts` runner. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-21-pin-release-checkout-design.md`

## Global Constraints

- Implement in a new worktree from `origin/main`: `git worktree add .worktrees/pin-release -b feat/pin-release origin/main`. Do not implement in `/Users/shadow/Projects/chamber` itself: it is on another branch and has unrelated edits in `.gitignore`, `src/embedder.ts` and `scripts/embed_minilm.py`.
- The release checkout is `~/.local/share/chamber-release`. It is never `~/.local/share/chamber`, which is the data directory and holds `chamber.sqlite`.
- The job runs each of `config show`, `ingest` and `verify` as `node "$HOME/.local/share/chamber-release/bin/chamber.js"`. It names `node` because `bin/chamber.js` is mode `100644` in every tag. Nothing else in the script changes: not the banner, the failure line, the notification text, or `CHAMBER_PYTHON`.
- The installed plist's script is accepted only when it decodes to exactly `BARE_SCRIPT` or `PINNED_SCRIPT`. Never find-and-replace `chamber` in a script. That is a blocklist, and it would also rewrite the banner and the log path.
- Order inside `pinRelease`:
  1. Read the plist.
  2. Check the tag name.
  3. Check the source checkout.
  4. Check the release directory.
  5. Fetch.
  6. Check the tag's tree for `bin/chamber.js`.
  7. Move `HEAD`.
  8. Check `bin/chamber.js` on disk.
  9. Write the plist.
  10. Load or reload the agent.

  A refusal at any step before 7 leaves `HEAD` and the plist untouched.
- Pin fetches only `refs/tags/<tag>:refs/tags/<tag>` from `origin`, with `--no-tags` and without `+`. A tag that moved on origin is git's refusal, not a silent move.
- Only a directory that did not exist when this run started is removed, and only when the checkout failed to reach the tag. An older checkout is never removed, reset or cleaned.
- After `launchctl load`, `launchctl list com.chamber.verify` must exit 0. A load that exits 0 but leaves the agent unloaded is a failure. A failed reload exits 1 and leaves the checkout and the plist as written.
- Pin does not run `npm link`, edit a crontab, touch `deploy/systemd/`, build `dist/`, or rewrite `CHAMBER_PYTHON`.
- Tests never read the real home directory and never call the real `launchctl`. Fixture repos are built with plumbing (`hash-object`, `update-index`, `write-tree`, `commit-tree --no-gpg-sign`, `update-ref`, `tag`), so no commit hook runs, no identity config is needed, and nothing is pushed.
- `tests/harness.ts` contains a fixture that a secret scanner rejects when an edit tool reads the whole file. Find each anchor this plan names with `grep -n`, Read about 20 lines around it, and Edit there. Do not print the whole file. Do not open the skill-secret fixture.
- The harness maps an unknown `--suite=` name to `all`, so it silently runs every test. Task 1 adds `"release"` to both the `Suite` union and the `suiteFromArg` list. Until it does, `--suite=release` is not a filter.
- Node on `PATH` must be `>=23.6`. If `node -v` is older, prepend `/opt/homebrew/bin`.
- Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run probes` before the first task and after the last one. Report every error with its file and line.
- Commit messages are `type: description` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Name every file in `git add`. Never add a directory.
- No push in this plan. A push goes through the owner's push gate.

---

### Task 1: The job script, read and pinned as text

**Files:**
- Create: `src/release_pin.ts`
- Modify: `deploy/launchd/com.chamber.verify.plist` (the `ProgramArguments` comment and script)
- Modify: `tests/harness.ts` (`Suite` union, `suiteFromArg` list, one import, a new section immediately before the line `// ─── cli process smoke tests ────────────────────────────────────────────────`)
- Commit first: `docs/superpowers/specs/2026-10-21-pin-release-checkout-design.md`, `docs/superpowers/plans/2026-10-21-pin-release-checkout.md`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `JOB_LABEL: "com.chamber.verify"`
  - `RELEASE_SUBDIR: ".local/share/chamber-release"`
  - `RELEASE_COMMAND: string`, equal to `node "$HOME/.local/share/chamber-release/bin/chamber.js"`
  - `BARE_SCRIPT: string`
  - `PINNED_SCRIPT: string`
  - `type JobScriptForm = "bare" | "pinned"`
  - `type JobPlistRead = { ok: true; form: JobScriptForm } | { ok: false; reason: string }`
  - `readJobPlist(xml: string): JobPlistRead`
  - `pinJobPlist(xml: string): string`, which throws `Error(reason)` unless the form is bare or pinned
  - Test helper in `tests/harness.ts`: `jobPlistXml(script: string): string`

- [ ] **Step 1: Make the worktree and commit the design**

```bash
cd /Users/shadow/Projects/chamber
git fetch origin
git worktree add .worktrees/pin-release -b feat/pin-release origin/main
mkdir -p .worktrees/pin-release/docs/superpowers/specs .worktrees/pin-release/docs/superpowers/plans
cp docs/superpowers/specs/2026-10-21-pin-release-checkout-design.md .worktrees/pin-release/docs/superpowers/specs/
cp docs/superpowers/plans/2026-10-21-pin-release-checkout.md .worktrees/pin-release/docs/superpowers/plans/
cd .worktrees/pin-release
npm ci
git add docs/superpowers/specs/2026-10-21-pin-release-checkout-design.md docs/superpowers/plans/2026-10-21-pin-release-checkout.md
git commit -m "docs: record the release pin design and plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Every later command in this plan runs in `.worktrees/pin-release`.

- [ ] **Step 2: Run the baseline**

Run: `npm run typecheck && npm run lint && npm test && npm run probes`
Expected: all four pass. If any fails on the untouched tree, stop and report the failure verbatim. Do not start Task 1 on a red baseline.

- [ ] **Step 3: Register the `release` suite**

In `tests/harness.ts`, in the `type Suite =` union, add a member after `  | "config"`:

```typescript
  | "config"
  | "release"
  | "all";
```

In `suiteFromArg`, add a list entry after `    "daemon",`:

```typescript
    "daemon",
    "release",
    "all",
```

- [ ] **Step 4: Write the failing tests**

Add this import after `import { withSiblings } from "../src/siblings.ts";`:

```typescript
import {
  BARE_SCRIPT,
  PINNED_SCRIPT,
  RELEASE_COMMAND,
  pinJobPlist,
  readJobPlist,
} from "../src/release_pin.ts";
```

Add this section immediately before the line `// ─── cli process smoke tests ────────────────────────────────────────────────`:

```typescript
// ─── release pin ────────────────────────────────────────────────────────────

/** A job plist with only the parts pin reads. `script` is written as is. */
function jobPlistXml(script: string): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>com.chamber.verify</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>/bin/sh</string>`,
    `    <string>-lc</string>`,
    `    <string>${script}</string>`,
    `  </array>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

test("release", "the shipped template runs the release checkout", () => {
  const template = readFileSync(
    fileURLToPath(new URL("../deploy/launchd/com.chamber.verify.plist", import.meta.url)),
    "utf8",
  );
  const read = readJobPlist(template);
  assert(read.ok && read.form === "pinned", `template: ${JSON.stringify(read)}`);
});

test("release", "the pinned script differs from the bare one only in its three chamber commands", () => {
  assert(
    RELEASE_COMMAND === `node "$HOME/.local/share/chamber-release/bin/chamber.js"`,
    RELEASE_COMMAND,
  );
  const bare = BARE_SCRIPT.split("\n");
  const pinned = PINNED_SCRIPT.split("\n");
  assert(bare.length === pinned.length, `${bare.length} lines vs ${pinned.length}`);
  const changed = bare.flatMap((line, i) => (line === pinned[i] ? [] : [i]));
  assert(JSON.stringify(changed) === "[1,2,3]", `changed lines ${JSON.stringify(changed)}`);
  for (const i of changed) {
    const was = bare[i] ?? "";
    assert(was.startsWith("chamber "), `bare line ${i} is ${was}`);
    assert(
      pinned[i] === `${RELEASE_COMMAND}${was.slice("chamber".length)}`,
      `pinned line ${i} is ${pinned[i]}`,
    );
  }
  for (const s of [BARE_SCRIPT, PINNED_SCRIPT]) {
    assert(!s.includes("<") && !s.includes("&"), "a job script now needs XML escaping");
  }
});

test("release", "a bare job plist is pinned in place and nothing else changes", () => {
  const xml = jobPlistXml(BARE_SCRIPT);
  const before = readJobPlist(xml);
  assert(before.ok && before.form === "bare", JSON.stringify(before));
  const pinned = pinJobPlist(xml);
  const after = readJobPlist(pinned);
  assert(after.ok && after.form === "pinned", JSON.stringify(after));
  // A string search argument is literal; only a replacement string reads `$`.
  assert(
    pinned.replace(PINNED_SCRIPT, "SCRIPT") === xml.replace(BARE_SCRIPT, "SCRIPT"),
    "pinning changed more than the script",
  );
  assert(pinJobPlist(pinned) === pinned, "pinning a pinned plist changed it");
});

test("release", "an entity-encoded bare script is still read as bare", () => {
  const encoded = BARE_SCRIPT.replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const read = readJobPlist(jobPlistXml(encoded));
  assert(read.ok && read.form === "bare", JSON.stringify(read));
  const after = readJobPlist(pinJobPlist(jobPlistXml(encoded)));
  assert(after.ok && after.form === "pinned", JSON.stringify(after));
});

test("release", "a job plist with any other script is refused", () => {
  const lines = BARE_SCRIPT.split("\n");
  const onePinned = [
    lines[0],
    `${RELEASE_COMMAND} config show 2>/dev/null | grep database`,
    ...lines.slice(2),
  ].join("\n");
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["an extra command", jobPlistXml(`${BARE_SCRIPT}\necho extra`)],
    ["one command pinned", jobPlistXml(onePinned)],
    ["another chamber", jobPlistXml(BARE_SCRIPT.replaceAll("chamber ", "/usr/local/bin/chamber "))],
    ["a non-login shell", jobPlistXml(BARE_SCRIPT).replace("<string>-lc</string>", "<string>-c</string>")],
    ["no ProgramArguments", jobPlistXml(BARE_SCRIPT).replace("<key>ProgramArguments</key>", "<key>Program</key>")],
    ["two ProgramArguments", jobPlistXml(BARE_SCRIPT).replace("</dict>", "  <key>ProgramArguments</key>\n</dict>")],
  ];
  for (const [label, xml] of cases) {
    const read = readJobPlist(xml);
    assert(!read.ok, `${label} was accepted as ${JSON.stringify(read)}`);
    let threw = false;
    try {
      pinJobPlist(xml);
    } catch {
      threw = true;
    }
    assert(threw, `${label}: pinJobPlist rewrote it`);
  }
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=release`
Expected: the run fails at import with `Cannot find module` for `src/release_pin.ts`.

- [ ] **Step 6: Write `src/release_pin.ts`**

```typescript
/**
 * `chamber pin <tag>`: the 08:30 job runs a release, not a branch.
 *
 * `npm link` makes the `chamber` on PATH the development checkout, so a job
 * that calls bare `chamber` runs whatever branch is checked out when it
 * fires. Pin keeps a second checkout at ~/.local/share/chamber-release,
 * detached at a release tag, and points the LaunchAgent's three chamber
 * commands at that checkout's bin/chamber.js. The job itself never fetches
 * and never checks anything out.
 *
 * The commands go through `node` because bin/chamber.js is mode 100644 in
 * git: a fresh checkout cannot run it directly. The checkout is not
 * ~/.local/share/chamber, because that is the data directory and the default
 * database lives there.
 */

export const JOB_LABEL = "com.chamber.verify";
export const RELEASE_SUBDIR = ".local/share/chamber-release";
export const RELEASE_COMMAND = `node "$HOME/${RELEASE_SUBDIR}/bin/chamber.js"`;

/**
 * The shipped job script, with `chamber` standing for whatever runs Chamber.
 * The installed script is accepted only when it is exactly one of the two
 * strings built from this function. Replacing "chamber" wherever it occurs
 * would also rewrite the banner and the log path, and would accept a script
 * someone has since edited into something else.
 */
function jobScript(chamber: string): string {
  return [
    `echo "=== chamber $(date '+%Y-%m-%dT%H:%M:%S%z') ==="`,
    `${chamber} config show 2>/dev/null | grep database`,
    `${chamber} ingest || echo "!! ingest FAILED (exit $?) - verifying against the corpus as it stands, which may be stale"`,
    `${chamber} verify`,
    `rc=$?`,
    `echo "=== verify exit $rc ==="`,
    `if [ "$rc" -ne 0 ]; then`,
    `  msg="A belief has lost its evidence (verify exit $rc). See Library/Logs/chamber-verify.log"`,
    String.raw`  osascript -e "display notification \"$msg\" with title \"Chamber: evidence drift\"" >/dev/null`,
    `fi`,
    `exit $rc`,
  ].join("\n");
}

export const BARE_SCRIPT = jobScript("chamber");
export const PINNED_SCRIPT = jobScript(RELEASE_COMMAND);

export type JobScriptForm = "bare" | "pinned";
export type JobPlistRead =
  | { ok: true; form: JobScriptForm }
  | { ok: false; reason: string };

// `/bin/sh`, `-lc`, then the script, and nothing else in the array. Groups:
// 1 everything up to the script's opening tag, 2 the shell, 3 the flag,
// 4 the script as written in the file, 5 the closing tags.
const PROGRAM_ARGUMENTS =
  /(<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>\s*<string>)([^<]*)(<\/string>\s*<\/array>)/;

// `&amp;` last, so `&amp;lt;` decodes once, to `&lt;`, and not on to `<`.
function decodeXmlText(raw: string): string {
  return raw
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function encodeXmlText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

/** Which shipped form an installed job plist holds, or why it holds neither. */
export function readJobPlist(xml: string): JobPlistRead {
  if (xml.split("<key>ProgramArguments</key>").length !== 2) {
    return { ok: false, reason: "ProgramArguments does not appear exactly once" };
  }
  const m = PROGRAM_ARGUMENTS.exec(xml);
  if (m === null || m[2] !== "/bin/sh" || m[3] !== "-lc" || m[4] === undefined) {
    return { ok: false, reason: "ProgramArguments is not /bin/sh -lc followed by one script" };
  }
  const script = decodeXmlText(m[4]);
  if (script === BARE_SCRIPT) return { ok: true, form: "bare" };
  if (script === PINNED_SCRIPT) return { ok: true, form: "pinned" };
  return {
    ok: false,
    reason: "its script is not the one Chamber ships, with bare chamber or with the release checkout",
  };
}

/** The same plist with its script in the pinned form. Throws unless readJobPlist accepts it. */
export function pinJobPlist(xml: string): string {
  const read = readJobPlist(xml);
  if (!read.ok) throw new Error(read.reason);
  if (read.form === "pinned") return xml;
  // A replacer function, not a replacement string: the script is full of `$`,
  // and String.prototype.replace reads `$'` and `$&` in a string as patterns.
  return xml.replace(
    PROGRAM_ARGUMENTS,
    (_all: string, head: string, _shell: string, _flag: string, _script: string, tail: string) =>
      `${head}${encodeXmlText(PINNED_SCRIPT)}${tail}`,
  );
}
```

- [ ] **Step 7: Point the shipped template at the release checkout**

In `deploy/launchd/com.chamber.verify.plist`, change these three script lines:

```
chamber config show 2>/dev/null | grep database
chamber ingest || echo "!! ingest FAILED (exit $?) - verifying against the corpus as it stands, which may be stale"
chamber verify
```

to:

```
node "$HOME/.local/share/chamber-release/bin/chamber.js" config show 2>/dev/null | grep database
node "$HOME/.local/share/chamber-release/bin/chamber.js" ingest || echo "!! ingest FAILED (exit $?) - verifying against the corpus as it stands, which may be stale"
node "$HOME/.local/share/chamber-release/bin/chamber.js" verify
```

Leave every other byte of the script alone. In the same file, add this paragraph to the comment directly above `<key>ProgramArguments</key>`, after the paragraph ending `quietly destroy verify's exit contract.` and before the closing `-->`. An XML comment cannot contain two hyphens in a row, so keep the text exactly as written:

```
    The three chamber commands run the release checkout that `chamber pin
    <tag>` keeps at ~/.local/share/chamber-release. The `chamber` on PATH is
    the one `npm link` points at the development checkout, so calling it here
    would run whatever branch was checked out at 08:30. `node` is named
    because bin/chamber.js is not executable in git, so a fresh checkout
    cannot run it directly. Run `chamber pin <tag>` before loading this file.
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=release`
Expected: 5 tests under `release/`, all `[PASS]`, and no tests from other suites.

- [ ] **Step 9: Check `BARE_SCRIPT` against the template users actually installed**

The harness cannot check this, because CI checks out without tags. Read-only:

```bash
S=$(mktemp -d)
git show v0.1.9:deploy/launchd/com.chamber.verify.plist > "$S/v0.1.9.plist"
node --experimental-strip-types --input-type=module -e '
import { readFileSync } from "node:fs";
import { readJobPlist } from "./src/release_pin.ts";
for (const p of process.argv.slice(1)) console.log(p, JSON.stringify(readJobPlist(readFileSync(p, "utf8"))));
' "$S/v0.1.9.plist" "$HOME/Library/LaunchAgents/com.chamber.verify.plist"
rm -rf "$S"
```

Expected: both lines end `{"ok":true,"form":"bare"}`. If either says `"ok":false`, `jobScript` does not reproduce the shipped script byte for byte. Fix `jobScript` and do not touch the plists. If the installed file is the one refused and the v0.1.9 file is accepted, stop and report to the owner, because pin would refuse on this machine.

- [ ] **Step 10: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

```bash
git add src/release_pin.ts deploy/launchd/com.chamber.verify.plist tests/harness.ts
git commit -m "feat: run the 08:30 job from the release checkout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: A release checkout detached at a tag

**Files:**
- Modify: `src/release_pin.ts` (imports at the top; append the checkout half)
- Modify: `tests/harness.ts` (extend the `../src/release_pin.ts` import; append to the `release pin` section, still before `// ─── cli process smoke tests`)

**Interfaces:**
- Consumes: nothing from Task 1 in the implementation. The tests reuse the harness's `assert`, `test`, `existsSync`, `readFileSync`, `writeFileSync`, `mkdirSync`, `rmSync`, `realpathSync`, `mkdtempSync`, `spawnSync`, `join`, `dirname` and `tmpdir`, which are all already imported.
- Produces:
  - `interface CheckoutOptions { tag: string; sourceRoot: string; releaseDir: string }`
  - `type CheckoutResult = { ok: true; commit: string; already: boolean } | { ok: false; reason: string }`
  - `pinCheckout(opts: CheckoutOptions): CheckoutResult`. `commit` is the peeled 40-hex commit. `already` is true only when `HEAD` was already detached at that commit.
  - Refusal reasons contain these fixed phrases, which the tests match:
    - `the tag name is empty`
    - `starts with "-"`
    - `contains a space or a newline`
    - `is not a valid tag name`
    - `is not a git checkout`
    - `has no origin remote`
    - `fetches from`
    - `dist exists`
    - `has tracked changes`
    - `has no bin/chamber.js`
    - `git fetch:`
    - `git checkout:`
  - Test helpers: `FIXTURE_GIT_ENV`, `fixtureGit(cwd, args, input?) => string`, `fixtureCommit(repo, files, message, parent?) => string`, `interface ReleaseFixture { root; origin; source; releaseDir; plistPath; v1; v2; nobin }`, `withReleaseFixture(fn: (fx: ReleaseFixture) => void): void`, `headOf(dir) => string`, `isDetachedHead(dir) => boolean`

- [ ] **Step 1: Write the fixture and the failing tests**

Replace the `../src/release_pin.ts` import in `tests/harness.ts` with:

```typescript
import {
  BARE_SCRIPT,
  PINNED_SCRIPT,
  RELEASE_COMMAND,
  pinCheckout,
  pinJobPlist,
  readJobPlist,
} from "../src/release_pin.ts";
```

Append to the `release pin` section, after the last Task 1 test:

```typescript
// Fixture repositories are built with plumbing only. `commit-tree` runs no
// hook and needs no configured identity, and nothing is ever pushed, so the
// global pre-commit and pre-push gates never see these throwaway repos.
const FIXTURE_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Chamber Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Chamber Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function fixtureGit(cwd: string, args: readonly string[], input?: string): string {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, ...FIXTURE_GIT_ENV },
  });
  if (r.status !== 0) {
    throw new Error(`fixture git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  }
  return (r.stdout ?? "").trim();
}

/** A commit holding exactly `files`, built without touching the working tree. */
function fixtureCommit(
  repo: string,
  files: Readonly<Record<string, string>>,
  message: string,
  parent?: string,
): string {
  fixtureGit(repo, ["read-tree", "--empty"]);
  for (const [path, body] of Object.entries(files)) {
    const blob = fixtureGit(repo, ["hash-object", "-w", "--stdin"], body);
    fixtureGit(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
  }
  const tree = fixtureGit(repo, ["write-tree"]);
  const args = ["commit-tree", "--no-gpg-sign", tree, "-m", message];
  if (parent !== undefined) args.push("-p", parent);
  return fixtureGit(repo, args);
}

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

/**
 * An origin with three tags and a branch, a source checkout whose only job is
 * to name that origin, and paths for a release directory and a plist that do
 * not exist yet. v1 is a lightweight tag. v2 is annotated, so it must be
 * peeled to its commit. v2 adds CHANGES.md. nobin has no bin/chamber.js.
 */
function releaseFixture(): ReleaseFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chamber-pin-")));
  const origin = join(root, "origin");
  fixtureGit(root, ["init", "-q", "-b", "main", origin]);
  const v1 = fixtureCommit(origin, { "bin/chamber.js": "// v1\n", "README.md": "one\n" }, "v1");
  const v2 = fixtureCommit(
    origin,
    { "bin/chamber.js": "// v2\n", "README.md": "two\n", "CHANGES.md": "two\n" },
    "v2",
    v1,
  );
  const nobin = fixtureCommit(origin, { "README.md": "three\n" }, "no bin", v2);
  fixtureGit(origin, ["update-ref", "refs/heads/main", nobin]);
  fixtureGit(origin, ["update-ref", "refs/heads/feature", v2]);
  fixtureGit(origin, ["tag", "v1", v1]);
  fixtureGit(origin, ["-c", "tag.gpgSign=false", "tag", "-a", "-m", "v2", "v2", v2]);
  fixtureGit(origin, ["tag", "nobin", nobin]);
  const source = join(root, "source");
  fixtureGit(root, ["init", "-q", "-b", "main", source]);
  fixtureGit(source, ["remote", "add", "origin", origin]);
  return {
    root,
    origin,
    source,
    releaseDir: join(root, "share", "chamber-release"),
    plistPath: join(root, "LaunchAgents", "com.chamber.verify.plist"),
    v1,
    v2,
    nobin,
  };
}

function withReleaseFixture(fn: (fx: ReleaseFixture) => void): void {
  const fx = releaseFixture();
  try {
    fn(fx);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

function headOf(dir: string): string {
  return fixtureGit(dir, ["rev-parse", "HEAD"]);
}

function isDetachedHead(dir: string): boolean {
  return spawnSync("git", ["-C", dir, "symbolic-ref", "--quiet", "HEAD"]).status !== 0;
}

test("release", "pin clones a tag into a new release directory, detached", () => {
  withReleaseFixture((fx) => {
    const r = pinCheckout({ tag: "v1", sourceRoot: fx.source, releaseDir: fx.releaseDir });
    assert(r.ok, `pin refused: ${JSON.stringify(r)}`);
    assert(r.commit === fx.v1 && !r.already, JSON.stringify(r));
    assert(headOf(fx.releaseDir) === fx.v1, "HEAD is not the v1 commit");
    assert(isDetachedHead(fx.releaseDir), "HEAD is attached to a branch");
    assert(
      readFileSync(join(fx.releaseDir, "bin", "chamber.js"), "utf8") === "// v1\n",
      "bin/chamber.js is not v1's",
    );
    assert(
      fixtureGit(fx.releaseDir, ["remote", "get-url", "origin"]) === fx.origin,
      "the release checkout does not fetch from the source's origin",
    );
  });
});

test("release", "a second pin moves the checkout to another tag", () => {
  withReleaseFixture((fx) => {
    const opts = { sourceRoot: fx.source, releaseDir: fx.releaseDir };
    assert(pinCheckout({ ...opts, tag: "v1" }).ok, "v1 refused");
    const r = pinCheckout({ ...opts, tag: "v2" });
    assert(r.ok && r.commit === fx.v2 && !r.already, JSON.stringify(r));
    assert(headOf(fx.releaseDir) === fx.v2, "HEAD is not the v2 commit");
    assert(isDetachedHead(fx.releaseDir), "HEAD is attached to a branch");
    assert(
      readFileSync(join(fx.releaseDir, "bin", "chamber.js"), "utf8") === "// v2\n",
      "bin/chamber.js is not v2's",
    );
    assert(existsSync(join(fx.releaseDir, "CHANGES.md")), "v2's new file is missing");
  });
});

test("release", "pinning the tag already checked out succeeds without moving", () => {
  withReleaseFixture((fx) => {
    const opts = { tag: "v2", sourceRoot: fx.source, releaseDir: fx.releaseDir };
    assert(pinCheckout(opts).ok, "first pin refused");
    const again = pinCheckout(opts);
    assert(again.ok && again.already && again.commit === fx.v2, JSON.stringify(again));
    assert(headOf(fx.releaseDir) === fx.v2, "HEAD moved");
  });
});

test("release", "a missing tag, a branch name and a raw commit are refused", () => {
  withReleaseFixture((fx) => {
    const opts = { sourceRoot: fx.source, releaseDir: fx.releaseDir };
    for (const tag of ["nope", "feature", fx.v1]) {
      const r = pinCheckout({ ...opts, tag });
      assert(!r.ok && r.reason.includes("git fetch:"), `${tag}: ${JSON.stringify(r)}`);
      assert(!existsSync(fx.releaseDir), `a refused first pin of ${tag} left its clone behind`);
    }
    assert(pinCheckout({ ...opts, tag: "v1" }).ok, "v1 refused");
    for (const tag of ["nope", "feature", fx.v2]) {
      const r = pinCheckout({ ...opts, tag });
      assert(!r.ok, `${tag} was pinned`);
      assert(existsSync(fx.releaseDir), `refusing ${tag} removed an older checkout`);
      assert(headOf(fx.releaseDir) === fx.v1, `refusing ${tag} moved HEAD`);
    }
  });
});

test("release", "a malformed tag name is refused before anything is created", () => {
  withReleaseFixture((fx) => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["", "the tag name is empty"],
      ["-v1", 'starts with "-"'],
      ["v 1", "contains a space or a newline"],
      ["v1\n", "contains a space or a newline"],
      ["v1..x", "is not a valid tag name"],
    ];
    for (const [tag, why] of cases) {
      const r = pinCheckout({ tag, sourceRoot: fx.source, releaseDir: fx.releaseDir });
      assert(!r.ok && r.reason.includes(why), `${JSON.stringify(tag)}: ${JSON.stringify(r)}`);
      assert(!existsSync(dirname(fx.releaseDir)), `${JSON.stringify(tag)} created a directory`);
    }
  });
});

test("release", "a tracked change in the release checkout stops pin", () => {
  withReleaseFixture((fx) => {
    const opts = { sourceRoot: fx.source, releaseDir: fx.releaseDir };
    assert(pinCheckout({ ...opts, tag: "v1" }).ok, "v1 refused");
    const bin = join(fx.releaseDir, "bin", "chamber.js");
    writeFileSync(bin, "// edited\n");
    const r = pinCheckout({ ...opts, tag: "v2" });
    assert(!r.ok && r.reason.includes("has tracked changes"), JSON.stringify(r));
    assert(headOf(fx.releaseDir) === fx.v1, "HEAD moved past a tracked change");
    assert(readFileSync(bin, "utf8") === "// edited\n", "pin reset the tracked change");
  });
});

test("release", "an untracked file the tag would overwrite stops pin with git's refusal", () => {
  withReleaseFixture((fx) => {
    const opts = { sourceRoot: fx.source, releaseDir: fx.releaseDir };
    assert(pinCheckout({ ...opts, tag: "v1" }).ok, "v1 refused");
    const mine = join(fx.releaseDir, "CHANGES.md");
    writeFileSync(mine, "mine\n");
    const r = pinCheckout({ ...opts, tag: "v2" });
    // The file name, not git's English wording: git translates its messages.
    assert(!r.ok && r.reason.includes("git checkout:") && r.reason.includes("CHANGES.md"), JSON.stringify(r));
    assert(headOf(fx.releaseDir) === fx.v1, "HEAD moved");
    assert(readFileSync(mine, "utf8") === "mine\n", "pin overwrote an untracked file");
  });
});

test("release", "a tag without bin/chamber.js is left unpinned", () => {
  withReleaseFixture((fx) => {
    const opts = { sourceRoot: fx.source, releaseDir: fx.releaseDir };
    const fresh = pinCheckout({ ...opts, tag: "nobin" });
    assert(!fresh.ok && fresh.reason.includes("has no bin/chamber.js"), JSON.stringify(fresh));
    assert(!existsSync(fx.releaseDir), "a refused first pin left its clone behind");
    assert(pinCheckout({ ...opts, tag: "v1" }).ok, "v1 refused");
    const over = pinCheckout({ ...opts, tag: "nobin" });
    assert(!over.ok, "nobin was pinned over v1");
    assert(headOf(fx.releaseDir) === fx.v1, "HEAD left v1");
    assert(existsSync(join(fx.releaseDir, "bin", "chamber.js")), "the older checkout lost bin/chamber.js");
  });
});

test("release", "a release directory that is not its own git checkout is left alone", () => {
  withReleaseFixture((fx) => {
    mkdirSync(fx.releaseDir, { recursive: true });
    writeFileSync(join(fx.releaseDir, "chamber.sqlite"), "db\n");
    const plain = pinCheckout({ tag: "v1", sourceRoot: fx.source, releaseDir: fx.releaseDir });
    assert(!plain.ok && plain.reason.includes("is not a git checkout"), JSON.stringify(plain));
    assert(readFileSync(join(fx.releaseDir, "chamber.sqlite"), "utf8") === "db\n", "pin touched a directory it does not own");
    assert(!existsSync(join(fx.releaseDir, ".git")), "pin initialised a directory it does not own");

    // Inside another repository, `git -C` finds the enclosing checkout. Pin
    // must not take that checkout for the release directory and fetch into it.
    const nested = join(fx.source, "nested");
    mkdirSync(nested);
    const inner = pinCheckout({ tag: "v1", sourceRoot: fx.source, releaseDir: nested });
    assert(!inner.ok && inner.reason.includes("is not a git checkout"), JSON.stringify(inner));
    assert(
      spawnSync("git", ["-C", fx.source, "rev-parse", "--verify", "--quiet", "refs/tags/v1"]).status !== 0,
      "pin fetched into the enclosing repository",
    );
  });
});

test("release", "a release checkout with another origin is left alone", () => {
  withReleaseFixture((fx) => {
    const opts = { sourceRoot: fx.source, releaseDir: fx.releaseDir };
    assert(pinCheckout({ ...opts, tag: "v1" }).ok, "v1 refused");
    fixtureGit(fx.releaseDir, ["remote", "set-url", "origin", join(fx.root, "elsewhere")]);
    const r = pinCheckout({ ...opts, tag: "v2" });
    assert(!r.ok && r.reason.includes("fetches from"), JSON.stringify(r));
    assert(headOf(fx.releaseDir) === fx.v1, "HEAD moved");
  });
});

test("release", "a release checkout with dist/ stops pin before HEAD moves", () => {
  withReleaseFixture((fx) => {
    const opts = { sourceRoot: fx.source, releaseDir: fx.releaseDir };
    assert(pinCheckout({ ...opts, tag: "v1" }).ok, "v1 refused");
    mkdirSync(join(fx.releaseDir, "dist"));
    writeFileSync(join(fx.releaseDir, "dist", "cli.js"), "// stale\n");
    const r = pinCheckout({ ...opts, tag: "v2" });
    assert(!r.ok && r.reason.includes("dist exists"), JSON.stringify(r));
    assert(headOf(fx.releaseDir) === fx.v1, "HEAD moved");
    assert(existsSync(join(fx.releaseDir, "dist", "cli.js")), "pin removed dist/");
  });
});

test("release", "pin runs only from a checkout that has an origin", () => {
  withReleaseFixture((fx) => {
    const installed = join(fx.root, "lib", "node_modules", "@bu7umaid", "chamber");
    mkdirSync(installed, { recursive: true });
    const a = pinCheckout({ tag: "v1", sourceRoot: installed, releaseDir: fx.releaseDir });
    assert(!a.ok && a.reason.includes("is not a git checkout"), JSON.stringify(a));

    // A package installed into some project's node_modules sits inside that
    // project's repository, and `git -C` would report the project's origin.
    const vendored = join(fx.source, "node_modules", "@bu7umaid", "chamber");
    mkdirSync(vendored, { recursive: true });
    const b = pinCheckout({ tag: "v1", sourceRoot: vendored, releaseDir: fx.releaseDir });
    assert(!b.ok && b.reason.includes("is not a git checkout"), JSON.stringify(b));

    const lonely = join(fx.root, "no-origin");
    fixtureGit(fx.root, ["init", "-q", "-b", "main", lonely]);
    const c = pinCheckout({ tag: "v1", sourceRoot: lonely, releaseDir: fx.releaseDir });
    assert(!c.ok && c.reason.includes("has no origin remote"), JSON.stringify(c));

    assert(!existsSync(dirname(fx.releaseDir)), "a refused source created a directory");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=release`
Expected: the run fails at import. `pinCheckout` is not exported by `src/release_pin.ts`.

- [ ] **Step 3: Implement the checkout half**

At the top of `src/release_pin.ts`, after the module doc comment, add:

```typescript
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
```

Append to `src/release_pin.ts`:

```typescript
export interface CheckoutOptions {
  tag: string;
  sourceRoot: string;
  releaseDir: string;
}

export type CheckoutResult =
  | { ok: true; commit: string; already: boolean }
  | { ok: false; reason: string };

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

function tagNameRefusal(tag: string): string | null {
  if (tag === "") return "the tag name is empty";
  if (tag.startsWith("-")) return `the tag name ${JSON.stringify(tag)} starts with "-"`;
  if (tag.includes(" ") || tag.includes("\n")) {
    return `the tag name ${JSON.stringify(tag)} contains a space or a newline`;
  }
  // git's own grammar for a ref name, not a hand-written list of bad characters.
  const format = spawnSync("git", ["check-ref-format", `refs/tags/${tag}`], { encoding: "utf8" });
  if (format.error !== undefined) return `git did not run: ${String(format.error)}`;
  if (format.status !== 0) return `${JSON.stringify(tag)} is not a valid tag name`;
  return null;
}

/**
 * True only when `dir` is the top of its own checkout. Asking whether `git -C`
 * succeeds is not enough: inside another repository it succeeds and answers
 * for that repository instead.
 */
function isCheckoutRoot(dir: string): boolean {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  return top.ok && realpathSync(top.out) === realpathSync(dir);
}

function existingCheckoutRefusal(dir: string, originUrl: string): string | null {
  if (!isCheckoutRoot(dir)) return `${dir} exists and is not a git checkout; left alone`;
  const origin = git(dir, ["remote", "get-url", "origin"]);
  if (!origin.ok || origin.out !== originUrl) {
    return `${dir} fetches from ${origin.ok ? origin.out : "no origin"}, not ${originUrl}; left alone`;
  }
  // dist/ is gitignored, so no tag provides it, and bin/chamber.js runs
  // dist/cli.js instead of the tag's src/ whenever it exists.
  if (existsSync(join(dir, "dist"))) {
    return `${join(dir, "dist")} exists, and bin/chamber.js would run it instead of the tag's src/; remove it and pin again`;
  }
  const status = git(dir, ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.ok) return status.message;
  if (status.out !== "") {
    return `${dir} has tracked changes; pin does not reset or clean it:\n${status.out}`;
  }
  return null;
}

function moveCheckout(dir: string, created: boolean, originUrl: string, tag: string): CheckoutResult {
  if (created) {
    mkdirSync(dirname(dir), { recursive: true });
    const init = git(dirname(dir), ["init", "--quiet", dir]);
    if (!init.ok) return { ok: false, reason: `git init: ${init.message}` };
    const remote = git(dir, ["remote", "add", "origin", originUrl]);
    if (!remote.ok) return { ok: false, reason: `git remote add: ${remote.message}` };
  }
  // Only refs/tags/<tag>, so a branch or a raw commit is simply not found.
  // No `+`: a tag that moved on origin is git's refusal, not a silent move.
  const fetch = git(dir, ["fetch", "--quiet", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
  if (!fetch.ok) return { ok: false, reason: `git fetch: ${fetch.message}` };
  const commit = git(dir, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  if (!commit.ok) return { ok: false, reason: `${tag} does not point at a commit` };
  if (!git(dir, ["cat-file", "-e", `${commit.out}:bin/chamber.js`]).ok) {
    return { ok: false, reason: `${tag} has no bin/chamber.js; left unpinned` };
  }
  const head = git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const detached = !git(dir, ["symbolic-ref", "--quiet", "HEAD"]).ok;
  const already = head.ok && head.out === commit.out && detached;
  if (!already) {
    const checkout = git(dir, ["checkout", "--quiet", "--detach", commit.out]);
    if (!checkout.ok) return { ok: false, reason: `git checkout: ${checkout.message}` };
  }
  const bin = join(dir, "bin", "chamber.js");
  if (!existsSync(bin)) return { ok: false, reason: `${bin} is not on disk after checkout` };
  return { ok: true, commit: commit.out, already };
}

/**
 * Fetch `tag` from the source checkout's origin and leave `releaseDir`
 * detached at it. Every refusal before the checkout leaves an existing
 * release checkout exactly as it was. A directory this call created is
 * removed when the checkout fails to reach the tag.
 */
export function pinCheckout(opts: CheckoutOptions): CheckoutResult {
  const { tag, sourceRoot, releaseDir } = opts;
  const badName = tagNameRefusal(tag);
  if (badName !== null) return { ok: false, reason: badName };

  if (!existsSync(sourceRoot) || !isCheckoutRoot(sourceRoot)) {
    return {
      ok: false,
      reason: `${sourceRoot} is not a git checkout; run pin from a clone of the repository, not from an installed package`,
    };
  }
  const origin = git(sourceRoot, ["remote", "get-url", "origin"]);
  if (!origin.ok || origin.out === "") {
    return { ok: false, reason: `${sourceRoot} has no origin remote to fetch ${tag} from` };
  }

  // Decided once, before anything is written: only a directory this run
  // creates may be removed.
  const created = !existsSync(releaseDir);
  if (!created) {
    const kept = existingCheckoutRefusal(releaseDir, origin.out);
    if (kept !== null) return { ok: false, reason: kept };
  }
  const moved = moveCheckout(releaseDir, created, origin.out, tag);
  if (!moved.ok && created) rmSync(releaseDir, { recursive: true, force: true });
  return moved;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=release`
Expected: 17 tests under `release/`, all `[PASS]`.

- [ ] **Step 5: Prove the cleanup test can fail**

In `pinCheckout`, temporarily change `if (!moved.ok && created) rmSync(...)` to `if (false) rmSync(...)` and rerun the suite. Expected: `a missing tag, a branch name and a raw commit are refused` and `a tag without bin/chamber.js is left unpinned` both FAIL with `left its clone behind`. Then temporarily change `const created = !existsSync(releaseDir);` to `const created = true;` and rerun. Expected: `a second pin moves the checkout to another tag` FAILS with `git remote add:`, because origin already exists. The refusal tests that pin v1 first FAIL with `removed an older checkout` or `HEAD moved`, because the existing-checkout checks are skipped and a failed run deletes the checkout. Revert both changes, rerun, and confirm all 17 pass.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

```bash
git add src/release_pin.ts tests/harness.ts
git commit -m "feat: keep a release checkout detached at a tag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Point the installed job at the release checkout

**Files:**
- Modify: `src/release_pin.ts` (one import line; append the agent half)
- Modify: `tests/harness.ts` (extend the `../src/release_pin.ts` import; append to the `release pin` section)

**Interfaces:**
- Consumes:
  - From Task 1: `JOB_LABEL`, `RELEASE_COMMAND`, `readJobPlist(xml): JobPlistRead`, `pinJobPlist(xml): string`, `jobPlistXml(script)` in the harness
  - From Task 2: `CheckoutOptions`, `pinCheckout(opts): CheckoutResult`, `ReleaseFixture`, `withReleaseFixture`, `headOf`
- Produces:
  - `interface LaunchctlResult { status: number | null; stdout: string; stderr: string }`
  - `type Launchctl = (args: readonly string[]) => LaunchctlResult`
  - `systemLaunchctl: Launchctl`, which spawns the real `launchctl`
  - `interface PinOptions extends CheckoutOptions { plistPath: string; launchctl: Launchctl }`
  - `interface PinOutcome { code: 0 | 1; out: string[]; err: string[] }`
  - `pinRelease(opts: PinOptions): PinOutcome`
  - Output phrases the tests match:
    - `is on <tag>`
    - `is already on <tag>`
    - `no LaunchAgent was installed at <plistPath>`
    - `reloaded com.chamber.verify`
    - `loaded com.chamber.verify`
    - `launchctl load failed`
    - `is not loaded`
  - Every `err` line starts `chamber pin: `.

- [ ] **Step 1: Write the failing tests**

Replace the `../src/release_pin.ts` import in `tests/harness.ts` with:

```typescript
import {
  BARE_SCRIPT,
  JOB_LABEL,
  PINNED_SCRIPT,
  RELEASE_COMMAND,
  pinCheckout,
  pinJobPlist,
  pinRelease,
  readJobPlist,
  type Launchctl,
  type LaunchctlResult,
  type PinOptions,
} from "../src/release_pin.ts";
```

Append to the `release pin` section:

```typescript
/**
 * A launchctl that records its calls and keeps one loaded flag. `load:
 * "fails"` exits non-zero; `load: "lies"` exits 0 and loads nothing, which is
 * what pin's `list` after `load` exists to catch.
 */
function fakeLaunchctl(start: { loaded: boolean; load?: "ok" | "fails" | "lies" }): {
  run: Launchctl;
  calls: string[];
} {
  let loaded = start.loaded;
  const calls: string[] = [];
  const done = (status: number, stderr = ""): LaunchctlResult => ({ status, stdout: "", stderr });
  const run: Launchctl = (args) => {
    calls.push(args.join(" "));
    switch (args[0]) {
      case "list":
        return loaded ? done(0) : done(113, `Could not find service "${JOB_LABEL}" in domain for port`);
      case "unload":
        loaded = false;
        return done(0);
      case "load":
        if (start.load === "fails") return done(5, "Load failed: 5: Input/output error");
        if (start.load !== "lies") loaded = true;
        return done(0);
      default:
        return done(64, `unexpected launchctl ${args.join(" ")}`);
    }
  };
  return { run, calls };
}

function pinOpts(fx: ReleaseFixture, tag: string, launchctl: Launchctl): PinOptions {
  return { tag, sourceRoot: fx.source, releaseDir: fx.releaseDir, plistPath: fx.plistPath, launchctl };
}

function writePlistFile(path: string, xml: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, xml);
}

function plistForm(path: string): string {
  const read = readJobPlist(readFileSync(path, "utf8"));
  return read.ok ? read.form : `refused: ${read.reason}`;
}

test("release", "pin points a loaded bare job at the release checkout and reloads it", () => {
  withReleaseFixture((fx) => {
    writePlistFile(fx.plistPath, jobPlistXml(BARE_SCRIPT));
    const lc = fakeLaunchctl({ loaded: true });
    const r = pinRelease(pinOpts(fx, "v1", lc.run));
    assert(r.code === 0, r.err.join("\n"));
    assert(headOf(fx.releaseDir) === fx.v1, "HEAD is not v1");
    assert(plistForm(fx.plistPath) === "pinned", plistForm(fx.plistPath));
    assert(
      JSON.stringify(lc.calls) ===
        JSON.stringify([`list ${JOB_LABEL}`, `unload ${fx.plistPath}`, `load ${fx.plistPath}`, `list ${JOB_LABEL}`]),
      lc.calls.join(" | "),
    );
    assert(r.out.some((l) => l.includes("is on v1")), r.out.join("\n"));
    assert(r.out.some((l) => l.includes(`reloaded ${JOB_LABEL}`)), r.out.join("\n"));
  });
});

test("release", "an agent that was not loaded is loaded, not unloaded", () => {
  withReleaseFixture((fx) => {
    writePlistFile(fx.plistPath, jobPlistXml(BARE_SCRIPT));
    const lc = fakeLaunchctl({ loaded: false });
    const r = pinRelease(pinOpts(fx, "v1", lc.run));
    assert(r.code === 0, r.err.join("\n"));
    assert(
      JSON.stringify(lc.calls) === JSON.stringify([`list ${JOB_LABEL}`, `load ${fx.plistPath}`, `list ${JOB_LABEL}`]),
      lc.calls.join(" | "),
    );
    assert(r.out.some((l) => l.includes(`loaded ${JOB_LABEL}`)), r.out.join("\n"));
  });
});

test("release", "pinning the tag already checked out still checks the plist", () => {
  withReleaseFixture((fx) => {
    writePlistFile(fx.plistPath, jobPlistXml(BARE_SCRIPT));
    assert(pinRelease(pinOpts(fx, "v1", fakeLaunchctl({ loaded: true }).run)).code === 0, "first pin failed");

    // The bare template was copied over the pinned job again.
    writePlistFile(fx.plistPath, jobPlistXml(BARE_SCRIPT));
    const again = fakeLaunchctl({ loaded: true });
    const r = pinRelease(pinOpts(fx, "v1", again.run));
    assert(r.code === 0, r.err.join("\n"));
    assert(r.out.some((l) => l.includes("is already on v1")), r.out.join("\n"));
    assert(plistForm(fx.plistPath) === "pinned", plistForm(fx.plistPath));
    assert(again.calls.includes(`load ${fx.plistPath}`), again.calls.join(" | "));

    // A pinned, loaded job is left exactly as it is.
    const before = readFileSync(fx.plistPath, "utf8");
    const idle = fakeLaunchctl({ loaded: true });
    const r2 = pinRelease(pinOpts(fx, "v1", idle.run));
    assert(r2.code === 0, r2.err.join("\n"));
    assert(readFileSync(fx.plistPath, "utf8") === before, "a pinned plist was rewritten");
    assert(JSON.stringify(idle.calls) === JSON.stringify([`list ${JOB_LABEL}`]), idle.calls.join(" | "));
  });
});

test("release", "a job with another script stops pin before HEAD moves", () => {
  withReleaseFixture((fx) => {
    assert(pinRelease(pinOpts(fx, "v1", fakeLaunchctl({ loaded: false }).run)).code === 0, "first pin failed");
    const edited = jobPlistXml(`${BARE_SCRIPT}\necho extra`);
    writePlistFile(fx.plistPath, edited);
    const lc = fakeLaunchctl({ loaded: true });
    const r = pinRelease(pinOpts(fx, "v2", lc.run));
    assert(r.code === 1, "pin accepted an edited job");
    assert(r.err.some((l) => l.startsWith("chamber pin: ") && l.includes(fx.plistPath)), r.err.join("\n"));
    assert(headOf(fx.releaseDir) === fx.v1, "HEAD moved before the plist was checked");
    assert(readFileSync(fx.plistPath, "utf8") === edited, "the edited plist was changed");
    assert(lc.calls.length === 0, lc.calls.join(" | "));

    rmSync(fx.releaseDir, { recursive: true, force: true });
    const fresh = pinRelease(pinOpts(fx, "v1", lc.run));
    assert(fresh.code === 1, "pin accepted an edited job on a first pin");
    assert(!existsSync(fx.releaseDir), "a first pin cloned before the plist was checked");
  });
});

test("release", "a missing plist still pins the checkout and exits 0", () => {
  withReleaseFixture((fx) => {
    const lc = fakeLaunchctl({ loaded: false });
    const r = pinRelease(pinOpts(fx, "v1", lc.run));
    assert(r.code === 0, r.err.join("\n"));
    assert(headOf(fx.releaseDir) === fx.v1, "HEAD is not v1");
    assert(r.out.some((l) => l.includes(`no LaunchAgent was installed at ${fx.plistPath}`)), r.out.join("\n"));
    assert(lc.calls.length === 0, lc.calls.join(" | "));
    assert(!existsSync(fx.plistPath), "pin created a plist");
  });
});

test("release", "a failed reload exits non-zero and keeps the checkout and the plist", () => {
  withReleaseFixture((fx) => {
    writePlistFile(fx.plistPath, jobPlistXml(BARE_SCRIPT));
    const r = pinRelease(pinOpts(fx, "v1", fakeLaunchctl({ loaded: true, load: "fails" }).run));
    assert(r.code === 1, "a failed load exited 0");
    assert(r.err.some((l) => l.includes("launchctl load failed")), r.err.join("\n"));
    assert(headOf(fx.releaseDir) === fx.v1, "the checkout was rolled back");
    assert(plistForm(fx.plistPath) === "pinned", "the plist was rolled back");
  });
});

test("release", "a load that exits 0 without loading the agent is a failure", () => {
  withReleaseFixture((fx) => {
    writePlistFile(fx.plistPath, jobPlistXml(BARE_SCRIPT));
    const r = pinRelease(pinOpts(fx, "v1", fakeLaunchctl({ loaded: false, load: "lies" }).run));
    assert(r.code === 1, "an agent that never loaded was reported loaded");
    assert(r.err.some((l) => l.includes("is not loaded")), r.err.join("\n"));
  });
});

test("release", "a pin that fails writes no plist and calls no launchctl", () => {
  withReleaseFixture((fx) => {
    const bare = jobPlistXml(BARE_SCRIPT);
    writePlistFile(fx.plistPath, bare);
    const missing = fakeLaunchctl({ loaded: true });
    const r = pinRelease(pinOpts(fx, "nope", missing.run));
    assert(r.code === 1, "a missing tag was pinned");
    assert(readFileSync(fx.plistPath, "utf8") === bare, "a failed pin wrote the plist");
    assert(missing.calls.length === 0, missing.calls.join(" | "));
    assert(!existsSync(fx.releaseDir), "a failed first pin left its clone behind");

    rmSync(fx.plistPath);
    assert(pinRelease(pinOpts(fx, "v1", fakeLaunchctl({ loaded: false }).run)).code === 0, "v1 failed");
    writeFileSync(join(fx.releaseDir, "CHANGES.md"), "mine\n");
    writePlistFile(fx.plistPath, bare);
    const blocked = fakeLaunchctl({ loaded: true });
    const r2 = pinRelease(pinOpts(fx, "v2", blocked.run));
    assert(r2.code === 1 && r2.err.join("\n").includes("CHANGES.md"), r2.err.join("\n"));
    assert(readFileSync(fx.plistPath, "utf8") === bare, "git refused the checkout and the plist was still written");
    assert(blocked.calls.length === 0, blocked.calls.join(" | "));
    assert(headOf(fx.releaseDir) === fx.v1, "HEAD moved");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=release`
Expected: the run fails at import. `pinRelease` is not exported.

- [ ] **Step 3: Implement the agent half**

In `src/release_pin.ts`, change the `node:fs` import to:

```typescript
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
```

Append:

```typescript
export interface LaunchctlResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Launchctl = (args: readonly string[]) => LaunchctlResult;

export const systemLaunchctl: Launchctl = (args) => {
  const r = spawnSync("launchctl", [...args], { encoding: "utf8" });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.error !== undefined ? String(r.error) : (r.stderr ?? ""),
  };
};

export interface PinOptions extends CheckoutOptions {
  plistPath: string;
  launchctl: Launchctl;
}

export interface PinOutcome {
  code: 0 | 1;
  out: string[];
  err: string[];
}

/**
 * Rewrite a bare job to the release command and make sure the agent is
 * loaded. A reload is checked with `launchctl list` afterwards: `load` has
 * exited 0 on macOS without loading anything. Nothing here is rolled back.
 * The checkout and the plist stay as written, and a failure exits 1.
 */
function pinAgent(plistPath: string, launchctl: Launchctl, out: string[], err: string[]): 0 | 1 {
  // Read again at the moment of writing, not trusted from the check made
  // before the checkout moved.
  const xml = readFileSync(plistPath, "utf8");
  const read = readJobPlist(xml);
  if (!read.ok) {
    err.push(`chamber pin: ${plistPath}: ${read.reason}; the checkout is pinned and the job was not changed`);
    return 1;
  }
  const rewritten = read.form === "bare";
  if (rewritten) {
    writeFileSync(plistPath, pinJobPlist(xml));
    out.push(`${plistPath} now runs config show, ingest and verify with ${RELEASE_COMMAND}`);
  } else {
    out.push(`${plistPath} already runs ${RELEASE_COMMAND}`);
  }
  const wasLoaded = launchctl(["list", JOB_LABEL]).status === 0;
  if (wasLoaded && !rewritten) {
    out.push(`${JOB_LABEL} is loaded`);
    return 0;
  }
  if (wasLoaded) {
    const unload = launchctl(["unload", plistPath]);
    if (unload.status !== 0) {
      err.push(`chamber pin: launchctl unload failed (${unload.status}): ${unload.stderr.trim()}`);
      return 1;
    }
  }
  const load = launchctl(["load", plistPath]);
  if (load.status !== 0) {
    err.push(`chamber pin: launchctl load failed (${load.status}): ${load.stderr.trim()}`);
    return 1;
  }
  if (launchctl(["list", JOB_LABEL]).status !== 0) {
    err.push(`chamber pin: launchctl load exited 0 but ${JOB_LABEL} is not loaded`);
    return 1;
  }
  out.push(`${wasLoaded ? "reloaded" : "loaded"} ${JOB_LABEL}`);
  return 0;
}

/**
 * `chamber pin <tag>`. The installed job is checked before the checkout
 * moves, and written only after the checkout is on the tag with
 * bin/chamber.js on disk. With no job installed, the checkout is still
 * pinned and the run exits 0.
 */
export function pinRelease(opts: PinOptions): PinOutcome {
  const out: string[] = [];
  const err: string[] = [];
  if (existsSync(opts.plistPath)) {
    const read = readJobPlist(readFileSync(opts.plistPath, "utf8"));
    if (!read.ok) {
      err.push(`chamber pin: ${opts.plistPath}: ${read.reason}. Nothing was moved.`);
      return { code: 1, out, err };
    }
  }
  const moved = pinCheckout(opts);
  if (!moved.ok) {
    err.push(`chamber pin: ${moved.reason}`);
    return { code: 1, out, err };
  }
  const short = moved.commit.slice(0, 12);
  out.push(
    moved.already
      ? `${opts.releaseDir} is already on ${opts.tag} (${short})`
      : `${opts.releaseDir} is on ${opts.tag} (${short})`,
  );
  if (!existsSync(opts.plistPath)) {
    out.push(`no LaunchAgent was installed at ${opts.plistPath}; nothing else was changed`);
    return { code: 0, out, err };
  }
  return { code: pinAgent(opts.plistPath, opts.launchctl, out, err), out, err };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=release`
Expected: 25 tests under `release/`, all `[PASS]`.

- [ ] **Step 5: Prove the ordering tests can fail**

Move the `existsSync(opts.plistPath)` / `readJobPlist` block in `pinRelease` to after the `pinCheckout` call, and rerun. Expected: `a job with another script stops pin before HEAD moves` FAILS with `HEAD moved before the plist was checked`. Revert. Then delete the final `launchctl(["list", JOB_LABEL])` check in `pinAgent` and rerun. Expected: `a load that exits 0 without loading the agent is a failure` FAILS. Revert, rerun, and confirm all 25 pass.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

```bash
git add src/release_pin.ts tests/harness.ts
git commit -m "feat: point the installed job at the release checkout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `chamber pin`, the scheduling docs, and the real path

**Files:**
- Modify: `src/cli.ts` (one import, a `cmdPin` function after `cmdConfig`, a dispatch line after the `config` dispatch, one `help()` line)
- Modify: `tests/harness.ts` (append two CLI tests to the `release pin` section)
- Modify: `deploy/SCHEDULING.md` (the `## Prerequisite` section, the `## macOS (launchd)` steps, the cron line)
- Modify: `CHANGELOG.md` (an `## Unreleased` section)

**Interfaces:**
- Consumes from Tasks 1–3: `JOB_LABEL`, `RELEASE_SUBDIR`, `pinRelease(opts: PinOptions): PinOutcome`, `systemLaunchctl`
- Produces: `chamber pin <tag>`. Exit 0 when the checkout is on the tag and the job, if installed, is pinned and loaded. Otherwise exit 1. A usage error prints `usage: chamber pin <tag>`.

- [ ] **Step 1: Write the failing CLI tests**

Append to the `release pin` section of `tests/harness.ts`. This section sits before `CLI_PATH` is declared, so it names the entrypoint itself:

```typescript
const PIN_CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// CHAMBER_DB and CHAMBER_CONFIG point into the throwaway HOME as well. Before
// `pin` is routed, the CLI falls through to config load and opens a database,
// and that run must not reach the real one through an inherited variable.
function runPinCli(home: string, args: readonly string[]): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", PIN_CLI, "pin", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      CHAMBER_DB: join(home, "never.sqlite"),
      CHAMBER_CONFIG: join(home, "never.json"),
    },
  });
  assert(r.error === undefined, `launch failed: ${r.error}`);
  return { status: r.status, stderr: r.stderr ?? "" };
}

test("release", "chamber pin takes exactly one tag", () => {
  const home = mkdtempSync(join(tmpdir(), "chamber-pin-home-"));
  try {
    for (const args of [[], ["v1", "v2"]]) {
      const r = runPinCli(home, args);
      assert(r.status === 1, `pin ${args.join(" ")}: status ${r.status}\n${r.stderr}`);
      assert(r.stderr.includes("usage: chamber pin <tag>"), r.stderr);
    }
    assert(!existsSync(join(home, ".local")), "a usage error created a directory under HOME");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("release", "chamber pin refuses a flag-shaped tag before touching HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "chamber-pin-home-"));
  try {
    const r = runPinCli(home, ["-x"]);
    assert(r.status === 1, `status ${r.status}\n${r.stderr}`);
    assert(r.stderr.includes('chamber pin: the tag name "-x" starts with "-"'), r.stderr);
    assert(!existsSync(join(home, ".local")), "a refused pin created the release directory");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=release`
Expected: the two new tests FAIL. `pin` is not a command yet, so the CLI falls through to config load and the switch, and stderr lacks the expected text. The 25 earlier tests still pass.

- [ ] **Step 3: Wire `pin` into the CLI**

In `src/cli.ts`, add after `import { runAsk, stubDisclosure } from "./ask.ts";`:

```typescript
import { JOB_LABEL, RELEASE_SUBDIR, pinRelease, systemLaunchctl } from "./release_pin.ts";
```

Add after the closing brace of `function cmdConfig`:

```typescript
/**
 * `chamber pin <tag>`: keep ~/.local/share/chamber-release detached at a
 * release tag and point the 08:30 job at it. See src/release_pin.ts. Like
 * `init` and `config show`, this runs before config load and never opens the
 * database. It touches neither, and it must work when either is broken.
 */
function cmdPin(rest: string[]): number {
  const tag = rest[0];
  if (rest.length !== 1 || tag === undefined) {
    console.error("usage: chamber pin <tag>");
    return 1;
  }
  const r = pinRelease({
    tag,
    sourceRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
    releaseDir: join(homedir(), RELEASE_SUBDIR),
    plistPath: join(homedir(), "Library", "LaunchAgents", `${JOB_LABEL}.plist`),
    launchctl: systemLaunchctl,
  });
  for (const line of r.out) console.log(line);
  for (const line of r.err) console.error(line);
  return r.code;
}
```

In `main()`, add after the block `if (cmd === "config") { cmdConfig(rest); return; }`:

```typescript
  if (cmd === "pin") {
    process.exitCode = cmdPin(rest);
    return;
  }
```

In `help()`, add a line directly after the `config show` line. Pad with spaces so the description starts in the same column as the lines around it. Do not use a backtick: this text is inside a template literal.

```
  pin <tag>                          run the 08:30 job from a release checkout at that tag
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=release`
Expected: 27 tests under `release/`, all `[PASS]`.

Run: `node --experimental-strip-types src/cli.ts help | grep -n "pin <tag>"`
Expected: one line, aligned with `config show`.

- [ ] **Step 5: Update `deploy/SCHEDULING.md`**

Replace everything from `## Prerequisite` up to, but not including, `## macOS (launchd)` with:

````markdown
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
the release checkout, and reloads it. Pin refuses before it moves anything in
these cases:

- the installed script is not the one Chamber ships
- the release checkout has tracked changes or a `dist/` folder
- the tag has no `bin/chamber.js`

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

````

Replace the numbered steps under `## macOS (launchd)`, from `1. Copy the plist` through the `tail -f` block, with:

````markdown
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
````

Leave `To run it once immediately` and `To remove it` as they are.

Under `## Linux (cron)`, replace the cron line with:

```cron
30 8 * * * /bin/sh -lc 'echo "=== chamber $(date -Is) ==="; node "$HOME/.local/share/chamber-release/bin/chamber.js" ingest || echo "!! ingest FAILED (exit $?) - verifying against the corpus as it stands, which may be stale"; node "$HOME/.local/share/chamber-release/bin/chamber.js" verify' >> "$HOME/.local/state/chamber-verify.log" 2>&1
```

Add this paragraph directly after the cron block, before `Two things that will bite you`:

```markdown
Run `chamber pin <tag>` first. Pin does not edit your crontab, so a line
written before pin existed keeps calling the `chamber` on `PATH` until you
replace it.
```

Leave the other sections unchanged.

- [ ] **Step 6: Add the changelog entry**

In `CHANGELOG.md`, insert directly before `## 0.1.9 — 2026-10-03`:

```markdown
## Unreleased

### Added

- `chamber pin <tag>` keeps a release checkout at
  `~/.local/share/chamber-release`, detached at that tag, and points the 08:30
  LaunchAgent at it. The job used to call the `chamber` on `PATH`, which
  `npm link` points at the development checkout, so it ran whatever branch was
  checked out. It now runs
  `node "$HOME/.local/share/chamber-release/bin/chamber.js"` and never fetches.
  Pin refuses before moving anything when the installed job's script is not
  the shipped one, when the release checkout has tracked changes or `dist/`,
  or when the tag has no `bin/chamber.js`.

```

- [ ] **Step 7: Run the real path without the real agent**

This fetches from the real `origin` over SSH. HOME points at a scratch directory, so the real `~/.local/share` and the real LaunchAgent are not touched. If the fetch is blocked by the sandbox or the network, quote the error verbatim and stop. Do not report this step as passed.

```bash
S=$(mktemp -d)
HOME="$S" node bin/chamber.js pin v0.1.9; echo "pin exit $?"
```

Expected:

```
<S>/.local/share/chamber-release is on v0.1.9 (bf5e10289878)
no LaunchAgent was installed at <S>/Library/LaunchAgents/com.chamber.verify.plist; nothing else was changed
pin exit 0
```

```bash
test ! -e "$S/.local/share/chamber-release/dist" && echo "no dist"
node "$S/.local/share/chamber-release/bin/chamber.js" --version
```

Expected: `no dist`, then `0.1.9`.

Run the pinned job script itself against that checkout. `env -i` keeps `CHAMBER_DB`, `CHAMBER_CONFIG` and every other variable in this shell from pointing the job at the real database:

```bash
node --experimental-strip-types --input-type=module -e '
import { PINNED_SCRIPT } from "./src/release_pin.ts";
process.stdout.write(PINNED_SCRIPT);
' > "$S/job.sh"
env -i HOME="$S" PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" /bin/sh "$S/job.sh"; echo "job exit $?"
```

Expected, in this order:
- an `=== chamber <timestamp> ===` banner
- a `database = <S>/.local/share/chamber/chamber.sqlite` line
- the `ingest: no path given and no roots configured` block
- `!! ingest FAILED (exit 1) - verifying against the corpus as it stands, which may be stale`
- `0 belief(s) checked, 0 with no verified support left`
- `=== verify exit 0 ===`
- `job exit 0`

A `node: command not found` or `Permission denied` line means the job's command line is wrong. Stop and report it.

```bash
rm -rf "$S"
```

- [ ] **Step 8: Full gate**

Run: `npm run typecheck && npm run lint && npm test && npm run probes`
Expected: all four exit 0. Report any failure with its file and line. Do not mark the task done on a red gate.

- [ ] **Step 9: Commit**

```bash
git add src/cli.ts tests/harness.ts deploy/SCHEDULING.md CHANGELOG.md
git commit -m "feat: add chamber pin for the scheduled job

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After merge (owner only, not part of the tasks)

Pinning this machine changes the real LaunchAgent, so it is the owner's step.

1. `chamber` on `PATH` runs the development checkout. That checkout must contain `pin`, which means `main` after merge. From any other branch, run `node <worktree>/bin/chamber.js pin <tag>` instead.
2. `chamber pin v0.1.9`. Nothing under `sql/` or `src/db.ts` has changed since `v0.1.9`, so that release opens the existing database. Expected output:
   - `.../chamber-release is on v0.1.9`
   - `.../com.chamber.verify.plist now runs config show, ingest and verify with node "$HOME/.local/share/chamber-release/bin/chamber.js"`
   - `reloaded com.chamber.verify`
3. `launchctl list com.chamber.verify` exits 0. After the next 08:30 run, `tail ~/Library/Logs/chamber-verify.log` shows `=== verify exit 0 ===` and no `command not found` line.
