/**
 * Synchronous HTTP through curl, with nothing secret on the command line.
 *
 * Every call here used to put its URL, its `Authorization` header and its body
 * into curl's argv. argv is world-readable for as long as the process lives
 * (`ps`, `/proc/<pid>/cmdline`), and agent hosts record the commands they run:
 * a bot token, a refresh token, an OAuth client secret and a Telegram token (it
 * is in the URL path) were all one `ps` away.
 *
 * So the argv is a constant, `CURL_FIXED_ARGV`, and everything that varies goes
 * to curl as a config file on stdin (`-K -`): the URL, the timeout, the headers
 * and the body. Verified with a local server that a header and a body holding
 * a double quote, a backslash, a newline, a carriage return, a tab, non-ASCII
 * text, a leading `@`, `%{http_code}` and `$HOME` arrive unchanged, 3 MB of it
 * included.
 *
 * Three details of curl's config format matter and are deliberate:
 *  - the body is `data-raw`, never `data`: a `data` value starting with `@`
 *    makes curl read that file and send its contents;
 *  - `globoff` turns off URL globbing, so `[::1]`, `[1]` and `{a}` in a URL are
 *    literal rather than a range or a set;
 *  - the status line is printed after the body by `write-out`, as it was by the
 *    `-w` this replaces.
 *
 * Values are double-quoted. Inside the quotes `\` becomes `\\`, `"` becomes
 * `\"`, LF `\n`, CR `\r` and TAB `\t`; nothing else is special. A NUL anywhere is
 * refused. A CR or LF in the URL, a header name or a header value is refused
 * rather than escaped: it could only be an attempt to add a header or to split
 * the config, and escaping would hide that. Header names must be HTTP tokens and
 * the URL must be http or https, so the set of things this can be asked to do is
 * closed rather than filtered.
 *
 * Errors name what was refused and never repeat the value.
 */

import { spawnSync } from "node:child_process";

/** The whole argv. Silent mode, then the config on stdin. Nothing else is ever passed. */
export const CURL_FIXED_ARGV: readonly string[] = ["-s", "-K", "-"];

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface HttpSyncRequest {
  url: string;
  /** Defaults to POST when there is a body, GET otherwise. */
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Sent exactly as written. Never interpreted by curl. */
  body?: string;
  /** Whole or fractional seconds for the entire transfer. Required: nothing here may wait forever. */
  timeoutSec: number;
  followRedirects?: boolean;
  /** Largest reply kept, in bytes. Default 8 MiB. */
  maxBytes?: number;
}

export interface HttpSyncResult {
  /** The HTTP status, or 0 when curl got no reply. */
  status: number;
  /** The reply body, without the status line `write-out` adds. */
  body: string;
  /** curl's exit code, or null if it could not be started or was killed. 28 means the timeout hit. */
  exitStatus: number | null;
  stderr: string;
}

function refuse(what: string): never {
  throw new Error(`http_sync: ${what}`);
}

function checkText(value: string, label: string, allowLineBreaks: boolean): void {
  if (value.includes("\0")) refuse(`${label} contains a NUL byte`);
  if (!allowLineBreaks && /[\r\n]/.test(value)) refuse(`${label} contains a line break`);
}

/** `value` as one double-quoted curl config string. */
export function quoteCurlConfigValue(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * The argv and the stdin config for `req`, or a thrown refusal. Pure: nothing is
 * spawned, so a test can inspect exactly what curl would be given.
 */
export function buildCurlInvocation(req: HttpSyncRequest): { argv: string[]; config: string } {
  checkText(req.url, "the URL", false);
  if (!/^https?:\/\//i.test(req.url)) refuse("the URL must start with http:// or https://");
  if (!Number.isFinite(req.timeoutSec) || req.timeoutSec <= 0) {
    refuse("timeoutSec must be a positive number of seconds");
  }
  const method = req.method ?? (req.body === undefined ? "GET" : "POST");
  if (method === "GET" && req.body !== undefined) refuse("a GET request cannot carry a body");

  const lines = [
    `url = ${quoteCurlConfigValue(req.url)}`,
    "globoff",
    `max-time = ${quoteCurlConfigValue(String(req.timeoutSec))}`,
    `write-out = ${quoteCurlConfigValue("\n%{http_code}")}`,
  ];
  if (req.followRedirects) lines.push("location");
  if (method === "POST") lines.push(`request = ${quoteCurlConfigValue("POST")}`);
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (!HEADER_NAME.test(name)) refuse("a header name is not an HTTP token");
    checkText(value, `the value of header ${name}`, false);
    lines.push(`header = ${quoteCurlConfigValue(`${name}: ${value}`)}`);
  }
  if (req.body !== undefined) {
    checkText(req.body, "the body", true);
    lines.push(`data-raw = ${quoteCurlConfigValue(req.body)}`);
  }
  return { argv: [...CURL_FIXED_ARGV], config: `${lines.join("\n")}\n` };
}

/** Run `req` through curl and wait for it. Throws only for a refused request. */
export function httpSync(req: HttpSyncRequest): HttpSyncResult {
  const { argv, config } = buildCurlInvocation(req);
  const r = spawnSync("curl", argv, {
    input: config,
    encoding: "utf-8",
    maxBuffer: req.maxBytes ?? DEFAULT_MAX_BYTES,
  });
  const out = r.stdout ?? "";
  const nl = out.lastIndexOf("\n");
  return {
    status: Number(out.slice(nl + 1)) || 0,
    body: nl >= 0 ? out.slice(0, nl) : out,
    exitStatus: r.status,
    stderr: r.stderr ?? "",
  };
}
