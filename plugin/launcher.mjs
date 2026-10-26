// What the Claude Code plugin runs to start the Chamber MCP server.
//
// plugin.json calls `node launch.mjs <npm spec> --notes <dir> --exclude <list>`.
// This file turns that into `npx -y <npm spec> mcp --notes <dir> [--exclude <x>]...`.
//
// Plain JavaScript on purpose: it has to parse on whatever `node` the user has,
// so that it can say what is wrong instead of dying on syntax.
//
// stdout is the MCP stream. Nothing in this file writes to it. Every message
// goes to stderr, and the child inherits both.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir, tmpdir, constants as osConstants } from "node:os";
import { posix, win32 } from "node:path";

const CONFIGURE = "/plugin configure chamber@chamber";
const USAGE = "usage: launch.mjs <npm spec> --notes <folder> [--exclude <a,b,c>]";

/**
 * @param {string} why
 * @returns {{ refuse: string }}
 */
function refuse(why) {
  return { refuse: `chamber: ${why}. Change it with ${CONFIGURE}.` };
}

/**
 * @param {string} value
 * @returns {string}
 */
function shown(value) {
  return JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}...` : value);
}

/**
 * The arguments Chamber itself gets, from the two values the plugin collects.
 * No shell is involved anywhere, so nothing here quotes or escapes: a value
 * goes through as one argument whatever characters it has.
 *
 * @param {{ notes: string, exclude: string, platform: string }} input
 * @returns {{ argv: string[] } | { refuse: string }}
 */
export function buildArgs({ notes, exclude, platform }) {
  if (typeof notes !== "string" || notes.trim() === "") {
    return refuse("no notes folder is set");
  }
  // Chamber expands `~` and `~/` only, and resolves anything else that is not
  // absolute against the directory Claude Code was started in.
  const home = notes === "~" || notes.startsWith("~/");
  const flavour = platform === "win32" ? win32 : posix;
  if (!home && !flavour.isAbsolute(notes)) {
    return refuse(`the notes folder ${shown(notes)} is not an absolute path`);
  }
  const items = String(exclude ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  for (const item of items) {
    // Chamber reads `--exclude -x` as a flag with no value.
    if (item.startsWith("-")) {
      return refuse(`the folder to skip ${shown(item)} starts with "-"`);
    }
  }
  /** @type {string[]} */
  const argv = ["mcp", "--notes", notes];
  for (const item of items) argv.push("--exclude", item);
  return { argv };
}

/**
 * Where npm's npx script is, for the node that is running this file. The
 * plugin runs it as `node npx-cli.js`, which is all the `npx` shim does, so no
 * shell and no PATH lookup of a `.cmd` file is needed.
 *
 *   Windows (zip, installer, nvm-windows):  <dir of node.exe>\node_modules\npm\bin\npx-cli.js
 *   macOS and Linux (tarball, nvm, fnm):    <prefix>/lib/node_modules/npm/bin/npx-cli.js
 *   Homebrew:                               <prefix>/libexec/lib/node_modules/npm/bin/npx-cli.js
 *
 * @param {string} execPath
 * @param {string} platform
 * @returns {string[]}
 */
export function npxCliCandidates(execPath, platform) {
  if (platform === "win32") {
    return [win32.join(win32.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js")];
  }
  const prefix = posix.dirname(posix.dirname(execPath));
  return [
    posix.join(prefix, "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    posix.join(prefix, "libexec", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
}

/**
 * @param {{ execPath: string, platform: string, isFile: (path: string) => boolean }} input
 * @returns {{ path: string } | { refuse: string }}
 */
export function findNpxCli({ execPath, platform, isFile }) {
  const candidates = npxCliCandidates(execPath, platform);
  const path = candidates.find((candidate) => isFile(candidate));
  if (path !== undefined) return { path };
  return {
    refuse:
      `chamber: npm is not installed next to this node (${shown(execPath)}). ` +
      `Looked for ${candidates.join(" and ")}. Use a node that ships with npm, such as the one from nodejs.org.`,
  };
}

/**
 * @param {string[]} args
 * @returns {{ spec: string, notes: string, exclude: string } | { refuse: string }}
 */
export function parseLauncherArgs(args) {
  const [spec, ...rest] = args;
  const bad = { refuse: `chamber: ${USAGE}` };
  if (spec === undefined || spec === "" || spec.startsWith("-")) return bad;
  let notes = "";
  let exclude = "";
  for (let i = 0; i < rest.length; i += 2) {
    // A last flag with nothing after it has an empty value. A host that dropped
    // the argument for an unset list would otherwise stop every server whose
    // user did not set one.
    const value = rest[i + 1] ?? "";
    if (rest[i] === "--notes") notes = value;
    else if (rest[i] === "--exclude") exclude = value;
    else return bad;
  }
  return { spec, notes, exclude };
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} message
 * @param {number} code
 * @returns {void}
 */
function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

/**
 * Start Chamber and become it: same stdio, same exit code. The options exist
 * for a test that imports this file; the file plugin.json runs passes none.
 *
 * @param {{ args?: string[], execPath?: string, platform?: string, npxCli?: string, cwd?: string }} [options]
 * @returns {void}
 */
export function main(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const parsed = parseLauncherArgs(options.args ?? process.argv.slice(2));
  if ("refuse" in parsed) return fail(parsed.refuse, 2);
  const built = buildArgs({ notes: parsed.notes, exclude: parsed.exclude, platform });
  if ("refuse" in built) return fail(built.refuse, 1);
  const npx = options.npxCli !== undefined ? { path: options.npxCli } : findNpxCli({ execPath, platform, isFile });
  if ("refuse" in npx) return fail(npx.refuse, 1);

  // From the home folder, not the session's working directory: inside a clone of
  // Chamber (or any folder whose package.json is @bu7umaid/chamber), npx runs that
  // local copy instead of the pinned version. The notes folder is absolute, so the
  // working directory changes nothing else. An empty HOME would make spawn keep
  // the session's directory, so it falls back to the temp folder instead.
  const cwd = options.cwd ?? (homedir() || tmpdir());
  const child = spawn(execPath, [npx.path, "-y", parsed.spec, ...built.argv], {
    stdio: "inherit",
    windowsHide: true,
    cwd,
  });
  child.once("error", (error) => {
    // A working directory that is missing or unreadable is reported by Node as
    // ENOENT or EACCES on the executable, so the folder is named too.
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    const where = code === "ENOENT" || code === "EACCES" ? ` (from the folder ${shown(cwd)}, which may be missing or unreadable)` : "";
    fail(`chamber: could not start npx with ${shown(execPath)}${where}: ${error.message}`, 1);
    process.exit();
  });
  // The host stops a server by signalling this process. The child is what
  // holds the notes database open, so it has to hear it too. npm passes on only
  // SIGINT and SIGTERM to the package it runs: a SIGHUP would end npx and leave
  // Chamber running with no parent, so a hangup reaches npx as SIGTERM.
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGHUP", () => child.kill("SIGTERM"));
  child.once("exit", (code, signal) => {
    process.exit(code ?? 128 + (signal === null ? 0 : (osConstants.signals[signal] ?? 0)));
  });
}
