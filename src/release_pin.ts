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
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
 * Rewrite a bare job to the release command and make sure the agent runs it.
 * A loaded agent is always reloaded, even when its plist is already pinned:
 * launchd keeps the definition it loaded, so "loaded" does not mean "runs the
 * pinned script". A reload is checked with `launchctl list` afterwards:
 * `load` has exited 0 on macOS without loading anything. Nothing here is
 * rolled back. The checkout and the plist stay as written, and a failure
 * exits 1.
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
