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
import { posix, win32 } from "node:path";

const CONFIGURE = "/plugin configure chamber@chamber";

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
