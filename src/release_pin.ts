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

import { spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";

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
}

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

function tagNameRefusal(tag: string): string | null {
  if (tag === "") return "the tag name is empty";
  if (tag.startsWith("-")) return `the tag name ${JSON.stringify(tag)} starts with "-"`;
  if (tag.includes(" ") || tag.includes("\n")) {
    return `the tag name ${JSON.stringify(tag)} contains a space or a newline`;
  }
  // git's own grammar for a ref name, not a hand-written list of bad characters.
  const format = spawnSync("git", ["check-ref-format", `refs/tags/${tag}`], {
    encoding: "utf8",
    env: gitEnv(),
    timeout: gitTimeouts.otherMs,
  });
  if (format.error !== undefined) return `git did not run: ${String(format.error)}`;
  if (format.status !== 0) return `${JSON.stringify(tag)} is not a valid tag name`;
  return null;
}

/**
 * Whether anything is at `path`, a dangling symlink included. existsSync
 * follows symlinks and calls a dangling one absent, and a directory "created"
 * over it would be removed along with the user's link.
 */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * True only when `dir` is the top of its own checkout. Asking whether `git -C`
 * succeeds is not enough: inside another repository it succeeds and answers
 * for that repository instead.
 */
function isCheckoutRoot(dir: string): boolean {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return false;
  try {
    return realpathSync(top.out) === realpathSync(dir);
  } catch {
    return false;
  }
}

function existingCheckoutRefusal(dir: string, originUrl: string): string | null {
  if (!isCheckoutRoot(dir)) return `${dir} exists and is not a git checkout; left alone`;
  const origin = git(dir, ["remote", "get-url", "origin"]);
  if (!origin.ok || origin.out !== originUrl) {
    const found = origin.ok ? redactUserinfo(origin.out) : "no origin";
    return `${dir} fetches from ${found}, not ${redactUserinfo(originUrl)}; left alone`;
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
    // `--`: the URL comes from another repository's config, and one that starts
    // with "-" must be a URL here, not an option.
    const remote = git(dir, ["remote", "add", "--", "origin", originUrl]);
    if (!remote.ok) return { ok: false, reason: `git remote add: ${remote.message}` };
  }
  // Only refs/tags/<tag>, so a branch or a raw commit is simply not found.
  // No `+`: a tag that moved on origin is git's refusal, not a silent move.
  const fetch = git(
    dir,
    ["fetch", "--quiet", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
    gitTimeouts.fetchMs,
  );
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
    // The parser rejects some http(s) URLs git still accepts (a port out of
    // range, a fragment before the host), and userinfo can hide in those. Only
    // what is not http(s) at all is a path or an scp-like user@host:path.
    return /^https?:/i.test(url)
      ? "the origin URL could not be parsed, so it cannot be checked for credentials; use a plain URL and a credential helper"
      : null;
  }
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && (parsed.username !== "" || parsed.password !== "")) {
    return "the origin URL carries credentials; use a credential helper instead";
  }
  return null;
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
  if (!created) {
    const kept = existingCheckoutRefusal(releaseDir, origin.out);
    if (kept !== null) return { ok: false, reason: kept };
  }
  const moved = moveCheckout(releaseDir, created, origin.out, tag);
  if (!moved.ok && created) rmSync(releaseDir, { recursive: true, force: true });
  return moved;
}

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
  /**
   * The environment the proof run gets (its HOME decides which login profile
   * the shell reads). Defaults to process.env.
   */
  env?: NodeJS.ProcessEnv;
}

export interface PinOutcome {
  code: 0 | 1;
  out: string[];
  err: string[];
}

/**
 * Rewrite a bare job to the release command and make sure the agent runs it.
 * A loaded agent is always reloaded, even when its plist is already pinned:
 * launchd keeps the definition it loaded, so "loaded" does not mean "runs the
 * pinned script". The exit codes of the legacy `launchctl load` and `unload`
 * are not trusted either: both have exited 0 on macOS while changing nothing.
 * What is trusted is `launchctl list <label>`, which exits non-zero for an
 * agent that is not loaded and otherwise prints the ProgramArguments launchd
 * actually holds. So an unload is followed by a `list` that must say "not
 * loaded", and a load by a `list` that must show the pinned script. Nothing
 * here is rolled back. The checkout and the plist stay as written, and a
 * failure exits 1.
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
    try {
      writeFileAtomic(plistPath, pinJobPlist(xml));
    } catch (e) {
      err.push(
        `chamber pin: could not write ${plistPath}: ${e instanceof Error ? e.message : String(e)}; ` +
          `the checkout is pinned and the job was not changed`,
      );
      return 1;
    }
    out.push(`${plistPath} now runs config show, ingest and verify with ${RELEASE_COMMAND}`);
  } else {
    out.push(`${plistPath} already runs ${RELEASE_COMMAND}`);
  }
  const wasLoaded = launchctl(["list", JOB_LABEL]).status === 0;
  if (wasLoaded) {
    const unload = launchctl(["unload", plistPath]);
    if (unload.status !== 0) {
      err.push(`chamber pin: launchctl unload failed (${unload.status}): ${unload.stderr.trim()}`);
      return 1;
    }
    if (launchctl(["list", JOB_LABEL]).status === 0) {
      err.push(`chamber pin: launchctl unload exited 0 but ${JOB_LABEL} is still loaded`);
      err.push(`${plistPath} is pinned; reload it by hand: launchctl unload ${plistPath} && launchctl load ${plistPath}`);
      return 1;
    }
  }
  const load = launchctl(["load", plistPath]);
  if (load.status !== 0) {
    err.push(`chamber pin: launchctl load failed (${load.status}): ${load.stderr.trim()}`);
    if (wasLoaded) {
      err.push(
        `chamber pin: the agent is now unloaded and will not run at 08:30; load it with: launchctl load ${plistPath}`,
      );
    }
    return 1;
  }
  const listed = launchctl(["list", JOB_LABEL]);
  if (listed.status !== 0) {
    err.push(
      `chamber pin: launchctl load exited 0 but ${JOB_LABEL} is not loaded, so the 08:30 job will not run; ` +
        `load it with: launchctl load ${plistPath}`,
    );
    return 1;
  }
  if (!listed.stdout.includes(PINNED_SCRIPT)) {
    err.push(`chamber pin: ${JOB_LABEL} is loaded but launchd is not running the pinned script`);
    err.push(`${plistPath} is pinned; reload it by hand: launchctl unload ${plistPath} && launchctl load ${plistPath}`);
    return 1;
  }
  out.push(`${wasLoaded ? "reloaded" : "loaded"} ${JOB_LABEL}`);
  return 0;
}

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
 * moves, and written only after the checkout is on the tag with
 * bin/chamber.js on disk and after that release has run once, `--version`,
 * under the job's own login shell. With no job installed, the checkout is
 * still pinned and, if the release runs, the run exits 0.
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
  const proof = proveReleaseRuns(opts.releaseDir, opts.env ?? process.env);
  if (!proof.ok) {
    err.push(`chamber pin: the release at ${opts.tag} did not run: ${proof.reason}`);
    err.push(`${opts.releaseDir} stays on ${opts.tag}; the job and its plist were not changed`);
    return { code: 1, out, err };
  }
  out.push(`the release runs: node bin/chamber.js --version printed ${proof.version}`);
  if (!existsSync(opts.plistPath)) {
    out.push(`no LaunchAgent was installed at ${opts.plistPath}; nothing else was changed`);
    return { code: 0, out, err };
  }
  return { code: pinAgent(opts.plistPath, opts.launchctl, out, err), out, err };
}
