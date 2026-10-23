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
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

/** What a property-list parser made of a plist. */
export type PlistParse =
  | { kind: "unavailable" }
  | { kind: "rejected"; reason: string }
  | { kind: "parsed"; value: unknown };

export type PlistParser = (xml: string) => PlistParse;

const PLUTIL_TIMEOUT_MS = 15_000;

/** Where plutil is. Run by absolute path, so a `plutil` earlier on PATH is never what decides. */
export const PLUTIL_PATH = "/usr/bin/plutil";

/**
 * `plutil -convert json` on stdin. As far as we know launchd reads a plist with
 * the same Core Foundation parser plutil is built on; Apple does not document
 * that, and `launchctl list <label>` after a load, which pin checks, is what
 * shows the script launchd actually holds. What plutil prints is therefore the
 * best reading there is: every shape that hid a `Program` key from the text
 * reader was seen by plutil. No file at `path` (Linux, CI) is "unavailable", not
 * an error: the caller falls back to the text reader. A plist plutil cannot turn
 * into JSON (a `<data>` or `<date>` value, say) is refused, and so is a plutil
 * that fails to run.
 */
function parseWithPlutil(path: string, xml: string): PlistParse {
  if (!existsSync(path)) return { kind: "unavailable" };
  const r = spawnSync(path, ["-convert", "json", "-o", "-", "--", "-"], {
    input: xml,
    encoding: "utf8",
    timeout: PLUTIL_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.error !== undefined) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "unavailable" };
    return { kind: "rejected", reason: `plutil did not run: ${code ?? String(r.error)}` };
  }
  if (r.status !== 0) {
    const said = (r.stderr ?? "").trim().split("\n")[0] ?? "";
    return { kind: "rejected", reason: `plutil does not accept the plist${said !== "" ? `: ${said.slice(0, 200)}` : ""}` };
  }
  try {
    return { kind: "parsed", value: JSON.parse(r.stdout ?? "") as unknown };
  } catch {
    return { kind: "rejected", reason: "plutil's output was not JSON" };
  }
}

/** The parser for the plutil at `path`. Tests use it to stand in for a machine that has none. */
export function plutilParserAt(path: string): PlistParser {
  return (xml) => parseWithPlutil(path, xml);
}

export const plutilParser: PlistParser = plutilParserAt(PLUTIL_PATH);

/** A parser that is never there: the text reader decides. For tests and for callers that must not run plutil. */
export const noPlistParser: PlistParser = () => ({ kind: "unavailable" });

/**
 * The verdict on a parsed plist: no `Program` key (launchd runs it instead of
 * ProgramArguments[0]) and ProgramArguments exactly `/bin/sh`, `-lc`, one of the
 * two scripts Chamber ships. Nothing here looks at the text.
 */
function judgeParsedPlist(value: unknown): JobPlistRead {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "the plist is not a dictionary" };
  }
  const dict = value as Record<string, unknown>;
  if (Object.hasOwn(dict, "Program")) {
    return { ok: false, reason: "it has a Program key, which overrides ProgramArguments[0]" };
  }
  const args = dict["ProgramArguments"];
  if (!Array.isArray(args) || args.length !== 3 || args[0] !== "/bin/sh" || args[1] !== "-lc" || typeof args[2] !== "string") {
    return { ok: false, reason: "ProgramArguments is not /bin/sh -lc followed by one script" };
  }
  if (args[2] === BARE_SCRIPT) return { ok: true, form: "bare" };
  if (args[2] === PINNED_SCRIPT) return { ok: true, form: "pinned" };
  return {
    ok: false,
    reason: "its script is not the one Chamber ships, with bare chamber or with the release checkout",
  };
}

/**
 * The verdict for a plist `parsed` is the result of parsing: the parser's own
 * where it gave one, the text reader's where there was no parser. Taking the
 * parse as an argument lets a caller that has already parsed `xml` not parse it
 * again.
 */
function judgePlistParse(xml: string, parsed: PlistParse): JobPlistRead {
  if (parsed.kind === "rejected") return { ok: false, reason: parsed.reason };
  if (parsed.kind === "parsed") return judgeParsedPlist(parsed.value);
  return readJobPlistText(xml);
}

/**
 * Which shipped form an installed job plist holds, or why it holds neither.
 * Where plutil exists its reading decides. Without it, the text reader below
 * does, which is a regex over XML and refuses what it does not model.
 */
export function readJobPlist(xml: string, parse: PlistParser = plutilParser): JobPlistRead {
  return judgePlistParse(xml, parse(xml));
}

/**
 * The first three lines of deploy/launchd/com.chamber.verify.plist, character
 * for character: the XML declaration and the DOCTYPE. The text reader reads no
 * other prolog. A test holds this equal to the shipped file.
 */
export const SHIPPED_PROLOG = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"`,
  `  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
].join("\n");

/** The text reader: the whole check where there is no plutil, and the way to find the block to rewrite. */
export function readJobPlistText(xml: string): JobPlistRead {
  // The prolog is a closed set: exactly the declaration and DOCTYPE the shipped
  // plist has, with nothing before them. Both are markup this reader does not
  // model, and a `<!--` in either (`<?xml version="1.0" encoding="UTF-8" <!-- ?>`,
  // or a public id ending `<!--`) makes the comment stripper below pair it with
  // a later `-->` and swallow a Program key that plutil still reads. A plist
  // re-saved by a tool that writes the DOCTYPE on one line is refused here, and
  // is read by plutil on a Mac.
  if (!xml.startsWith(SHIPPED_PROLOG)) {
    return {
      ok: false,
      reason:
        "the job plist uses XML that Chamber does not read (an XML declaration or DOCTYPE other than the shipped one)",
    };
  }
  const live = stripXmlComments(xml);
  // The comment stripper is a regex, not an XML parser, so anything that could
  // make it and launchd disagree about what is a comment or what a key is named
  // is refused outright: a `<!--` left after stripping (an unterminated comment,
  // which plutil rejects, or one opened inside CDATA), CDATA itself, and an
  // entity in a key (`Progr&#97;m` is `Program` to launchd).
  if (live.includes("<!--") || live.includes("<![CDATA[") || /<key>[^<]*&[^<]*<\/key>/.test(live)) {
    return {
      ok: false,
      reason: "the job plist uses XML that Chamber does not read (CDATA, an unterminated comment, or an encoded key)",
    };
  }
  // Two more shapes plutil showed to hide a Program key from this reader. A
  // processing instruction can hold comment markers, so the stripper pairs the
  // `<!--` in one with the `-->` in another and swallows what lies between; the
  // prolog is checked above, so any `<?` after it is such an instruction. And a
  // key tag may carry whitespace or an attribute (`<key >`, `</key\n>`,
  // `<key a="b">`), which the exact-text matches below do not see. Closed set
  // again: refuse what is not modelled.
  if (xml.slice(SHIPPED_PROLOG.length).includes("<?") || /<\/?key(?!>)/.test(live)) {
    return {
      ok: false,
      reason:
        "the job plist uses XML that Chamber does not read (a processing instruction, or a key tag with extra characters)",
    };
  }
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The rewrite is validated, not only the input. The splice works on text, so a
 * plist the parser reads differently from the splice (a second ProgramArguments
 * block, one the regex mistook for the live one) can be rewritten without
 * changing what launchd will run. So the rewritten file is parsed again: it must
 * read as the pinned form and, where there is a parser, be the same plist with
 * only the script changed. `was` is the parse of the original that pinJobPlist
 * already made. If a parser answered for one text and not for the other, the
 * comparison cannot be made, and the rewrite is refused instead of waved
 * through. With no parser for either (Linux, CI) only the text reader's reading
 * of the rewrite remains, and that is what is checked.
 */
function checkRewrite(was: PlistParse, after: string, parse: PlistParser): void {
  const now = parse(after);
  const read = judgePlistParse(after, now);
  if (!read.ok) throw new Error(`the rewritten plist is not accepted: ${read.reason}`);
  if (read.form !== "pinned") throw new Error("the rewrite did not change the script launchd will run");
  if (was.kind === "unavailable" && now.kind === "unavailable") return;
  if (was.kind !== "parsed" || now.kind !== "parsed") {
    throw new Error(
      "the plist parser read the original and the rewrite differently (one was parsed, the other was not), " +
        "so the rewrite cannot be compared with the original",
    );
  }
  const expected = { ...(was.value as Record<string, unknown>), ProgramArguments: ["/bin/sh", "-lc", PINNED_SCRIPT] };
  if (canonicalJson(expected) !== canonicalJson(now.value)) throw new Error("the rewrite changed more than the script");
}

/**
 * The same plist with its script in the pinned form. Throws unless readJobPlist
 * accepts it and the rewritten plist reads back as pinned.
 */
export function pinJobPlist(xml: string, parse: PlistParser = plutilParser): string {
  const was = parse(xml);
  const read = judgePlistParse(xml, was);
  if (!read.ok) throw new Error(read.reason);
  if (read.form === "pinned") return xml;
  const m = findProgramArguments(xml);
  if (m === null) throw new Error("ProgramArguments is valid, but not in the plain form Chamber rewrites in place");
  // Spliced by position, not with String.prototype.replace: the script is full
  // of `$`, which replace reads as a pattern, and the match to rewrite is the
  // live block, which need not be the first one in the text.
  const head = m[1] ?? "";
  const tail = m[5] ?? "";
  const rewritten =
    xml.slice(0, m.index) + head + encodeXmlText(PINNED_SCRIPT) + tail + xml.slice(m.index + m[0].length);
  checkRewrite(was, rewritten, parse);
  return rewritten;
}

export interface CheckoutOptions {
  tag: string;
  sourceRoot: string;
  releaseDir: string;
}

export type CheckoutResult = { ok: true; commit: string; already: boolean } | { ok: false; reason: string };

/** What running a release once found. */
export type RunProof = { ok: true; version: string } | { ok: false; reason: string };

/**
 * Called with the commit a pin is about to move to, after it is fetched and
 * before anything is checked out. A failure ends the pin with the checkout
 * exactly where it was.
 */
export type ProveBeforeMove = (commit: string) => RunProof;

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

/**
 * `text` as one POSIX shell word. A word made only of characters the shell
 * never treats specially is returned as it is; anything else, the empty string
 * included, goes inside single quotes with each `'` written as `'\''`. Pin
 * prints a command for the owner to paste, and both the directory (a home
 * directory can hold a space or a quote) and the tag (git allows `$`, `;`, `&`
 * and `'` in one) come from outside this file.
 */
export function shellQuote(text: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'\\''`)}'`;
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

function moveCheckout(
  dir: string,
  created: boolean,
  originUrl: string,
  tag: string,
  prove: ProveBeforeMove | undefined,
): CheckoutResult {
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
  // Whether the tag was here before decides what a refusal below leaves behind.
  const hadTag = git(dir, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).ok;
  const fetch = git(
    dir,
    ["fetch", "--quiet", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
    gitTimeouts.fetchMs,
  );
  if (!fetch.ok) {
    // `--quiet` hides git's own "would clobber existing tag", so a tag that
    // moved arrives here as "git fetch exited 1". Say what git did not, and how
    // to accept the move on purpose.
    const moved = hadTag
      ? `; ${dir} already has a tag ${tag}, and git does not move a tag it has. ` +
        `If ${tag} was moved on origin on purpose, delete the local one and pin again: ` +
        `git -C ${shellQuote(dir)} tag -d ${shellQuote(tag)}`
      : "";
    return { ok: false, reason: `git fetch: ${fetch.message}${moved}` };
  }
  // A refusal from here to the checkout leaves HEAD and the files alone, and
  // must leave the tag as it found it too. A ref this call added and then
  // refused would stop a tag re-pointed on origin from ever being fetched
  // again, because git will not move it. A tag that was here before stays. The
  // checkout's own failure keeps the ref: its repair command needs it. Best
  // effort: a ref that cannot be removed is met by the message above next time.
  const forgetTag = (): void => {
    if (!hadTag) git(dir, ["update-ref", "-d", `refs/tags/${tag}`]);
  };
  const commit = git(dir, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  if (!commit.ok) {
    forgetTag();
    return { ok: false, reason: `${tag} does not point at a commit` };
  }
  if (!git(dir, ["cat-file", "-e", `${commit.out}:bin/chamber.js`]).ok) {
    forgetTag();
    return { ok: false, reason: `${tag} has no bin/chamber.js; left unpinned` };
  }
  const head = git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const attached = git(dir, ["symbolic-ref", "--quiet", "HEAD"]);
  const already = head.ok && head.out === commit.out && !attached.ok;
  // The release is tried before the checkout moves. The job's command is this
  // checkout's bin/chamber.js, so a checkout moved onto a release that turns
  // out not to run is a job that does not run: for as long as the proof takes
  // (up to a minute), and for good if the pin is interrupted meanwhile. A
  // failed proof returns here, with HEAD and the files untouched.
  if (prove !== undefined) {
    const proof = prove(commit.out);
    if (!proof.ok) {
      forgetTag();
      const where = created
        ? `no release checkout was left at ${dir}`
        : head.ok
          ? `${dir} was not moved: it is still at ${head.out.slice(0, 12)}`
          : `${dir} was not moved`;
      return {
        ok: false,
        reason: `the release at ${tag} did not run: ${proof.reason}; ${where}; the job and its plist were not changed`,
      };
    }
  }
  if (!already) {
    const checkout = git(dir, ["checkout", "--quiet", "--detach", commit.out]);
    if (!checkout.ok) {
      // A first pin's directory is removed by the caller, so there is nothing to
      // repair there; an existing checkout may have been left half-moved.
      // The command goes last, so a line pasted whole into a shell is the command.
      const repair = created
        ? ""
        : `; --force overwrites changes in that checkout; if the checkout left ${dir} half-moved, ` +
          `finish the move with: git -C ${shellQuote(dir)} checkout --force --detach ${shellQuote(tag)}`;
      return { ok: false, reason: `git checkout: ${checkout.message}${repair}` };
    }
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
 * detached at it. Every refusal before the checkout, `prove`'s included,
 * leaves an existing release checkout exactly as it was (the fetch adds the
 * tag's objects to its .git, and the tag's ref too unless the tag was there
 * already, in which case it is the same one; HEAD and the files stay). A
 * directory this call created is removed when the checkout fails to reach the tag.
 */
export function pinCheckout(opts: CheckoutOptions, prove?: ProveBeforeMove): CheckoutResult {
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
  const moved = moveCheckout(releaseDir, created, origin.out, tag, prove);
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
  /**
   * Where the throwaway clone the release is tried in is made (default: the
   * system temp directory). A pin killed while the release runs leaves that
   * clone here, named chamber-pin-proof-*.
   */
  workDir?: string;
  /** How long the release may take to print its version, in ms (default 60 s). */
  proofTimeoutMs?: number;
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
function proveReleaseRuns(releaseDir: string, env: NodeJS.ProcessEnv, timeoutMs: number): RunProof {
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
    timeout: timeoutMs,
  });
  if (r.error !== undefined) {
    const timedOut = (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return { ok: false, reason: timedOut ? `it did not finish in ${timeoutMs / 1000}s` : String(r.error) };
  }
  if (r.status !== 0) {
    const said = (r.stderr ?? "").trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    return { ok: false, reason: `it exited ${r.status ?? `from signal ${r.signal}`}${said !== "" ? `: ${said}` : ""}` };
  }
  // A login profile may print before the command does (a banner, a fortune),
  // and the job's output only lands in a log. The version is the last line.
  const printed = (r.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1) ?? "";
  if (printed !== version) {
    return {
      ok: false,
      reason: `--version printed ${JSON.stringify(printed.slice(0, 80))}, but its package.json says ${JSON.stringify(version)}`,
    };
  }
  return { ok: true, version };
}

/**
 * Try `commit` the way the job will run it, in a throwaway clone of the release
 * checkout, so that nothing the release does while it runs can touch the
 * checkout the job uses. The clone comes from the checkout (the commit was
 * fetched into it a moment ago), not from origin, so it needs no network. It is
 * removed afterwards; if it cannot be, pin says on stderr which directory it
 * left and the result is the one the release earned. A pin that is killed while
 * the release runs cannot remove it: it stays in `workDir`, named
 * chamber-pin-proof-*, and costs disk space.
 */
function proveInClone(
  releaseDir: string,
  commit: string,
  workDir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): RunProof {
  let scratch: string;
  try {
    mkdirSync(workDir, { recursive: true });
    scratch = mkdtempSync(join(workDir, "chamber-pin-proof-"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? String(e);
    return { ok: false, reason: `cannot make a scratch directory in ${workDir}: ${code}` };
  }
  try {
    const clone = join(scratch, "release");
    const cloned = git(scratch, ["clone", "--quiet", "--no-checkout", "--", releaseDir, clone]);
    if (!cloned.ok) return { ok: false, reason: `could not clone ${releaseDir} to try the release: ${cloned.message}` };
    const checkout = git(clone, ["checkout", "--quiet", "--detach", commit]);
    if (!checkout.ok) return { ok: false, reason: `could not check the release out to try it: ${checkout.message}` };
    return proveReleaseRuns(clone, env, timeoutMs);
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch (e) {
      // The release has already run and its verdict is the result. A directory
      // that will not go away (a release that locked a folder in its clone) must
      // not replace that verdict with a thrown error, and must not skip the
      // cleanup of a first pin's checkout, which runs after this returns.
      const code = (e as NodeJS.ErrnoException).code ?? String(e);
      process.stderr.write(
        `chamber pin: could not remove the throwaway clone ${scratch} (${code}); it was left in place, delete it\n`,
      );
    }
  }
}

/**
 * `chamber pin <tag>`. The installed job is checked first, rewrite included: the
 * rewrite is done once as a dry run, so a plist pin can read but not rewrite is
 * refused before anything is fetched or moved. Then the tag is
 * fetched into the release checkout (HEAD and the files stay) and the release
 * is run once, `--version` under the job's own login shell, in a throwaway
 * clone. Only if that passes does the release checkout move to the tag and the
 * plist get written. A release that does not run therefore changes nothing the
 * job uses, and neither does a pin that is interrupted while it runs. What is
 * left open is the move itself: a `git checkout`, normally well under a second,
 * during which a job that starts sees neither release. With no job installed,
 * the checkout is still pinned and, if the release runs, the run exits 0.
 */
export function pinRelease(opts: PinOptions): PinOutcome {
  const out: string[] = [];
  const err: string[] = [];
  if (existsSync(opts.plistPath)) {
    const xml = readFileSync(opts.plistPath, "utf8");
    const read = readJobPlist(xml);
    if (!read.ok) {
      err.push(`chamber pin: ${opts.plistPath}: ${read.reason}. Nothing was moved.`);
      return { code: 1, out, err };
    }
    // A plist can be one the reader accepts and the splice still cannot rewrite
    // (the script in CDATA, a JSON plist, a second ProgramArguments the reader
    // skips). That is only found by doing the rewrite, so it is done here as a
    // dry run, with the same parser and the result thrown away. Found in pinAgent
    // it would be found after the checkout had moved.
    try {
      pinJobPlist(xml);
    } catch (e) {
      err.push(`chamber pin: ${opts.plistPath}: ${e instanceof Error ? e.message : String(e)}. Nothing was moved.`);
      return { code: 1, out, err };
    }
  }
  let version = "";
  const moved = pinCheckout(opts, (commit) => {
    const proof = proveInClone(
      opts.releaseDir,
      commit,
      opts.workDir ?? tmpdir(),
      opts.env ?? process.env,
      opts.proofTimeoutMs ?? RUN_PROOF_TIMEOUT_MS,
    );
    if (proof.ok) version = proof.version;
    return proof;
  });
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
  out.push(`the release runs: node bin/chamber.js --version printed ${version} (tried in a throwaway clone before the checkout moved)`);
  if (!existsSync(opts.plistPath)) {
    out.push(`no LaunchAgent was installed at ${opts.plistPath}; nothing else was changed`);
    return { code: 0, out, err };
  }
  return { code: pinAgent(opts.plistPath, opts.launchctl, out, err), out, err };
}
