/**
 * Settings resolution.
 *
 * Precedence: CLI flag > environment variable > config file > built-in default.
 * The file only fills gaps, so every existing CHAMBER_* variable keeps working.
 *
 * There is deliberately no field for an API key. CHAMBER_API_KEY is read from
 * the environment by src/model.ts and nowhere else, so a key cannot reach a
 * config file by accident — and `model.base`, the one field that could send
 * that key somewhere, is restricted to this machine when it comes from a file.
 * See `assertFileBaseIsLocal`.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface IngestRootConfig {
  root: string;
  exclude: string[];
}

export interface ChamberConfig {
  database: string;
  model: { base?: string; name?: string };
  ingest: IngestRootConfig[];
}

export interface ResolvedSetting {
  key: string;
  value: string;
  source: "env" | "config" | "default";
  /** The value that lost, when env and config disagree. */
  conflict?: string;
}

const KNOWN_TOP_LEVEL = new Set(["database", "model", "ingest"]);
const KNOWN_MODEL_KEYS = new Set(["base", "name"]);
const KNOWN_INGEST_KEYS = new Set(["root", "exclude"]);

function defaultDatabase(): string {
  return join(homedir(), ".local", "share", "chamber", "chamber.sqlite");
}

/**
 * Read an environment variable, treating blank as unset.
 *
 * A wrapper script that does `export CHAMBER_DB="$SOMETHING_UNSET"` exports the
 * name with an empty value. `??` only falls through on nullish, so an empty
 * export used to win the precedence race and resolve `database` to "" —
 * discarding both the config file and the default. That is not a visible
 * failure: `new DatabaseSync("")` succeeds, SQLite silently opens a private
 * temporary on-disk database, schemas apply, and every row written disappears
 * when the process exits. Empty is not a setting; it is the absence of one, and
 * it must fall through to the next layer.
 *
 * Whitespace-only counts as empty for the same reason. A non-blank value is
 * returned exactly as given — no trimming — because a path the operator
 * actually typed is theirs to get wrong, and silently rewriting it would be a
 * second, quieter kind of surprise.
 */
function envSetting(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

/**
 * Expand a leading `~`. Nothing else does this — shells expand tildes, and a
 * config file never passes through a shell, so an unexpanded path creates a
 * directory literally named "~".
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * The database setting as an absolute path — the same treatment `canonical()`
 * gives an ingest root, and what `ChamberConfig.database` has always claimed.
 *
 * `expandTilde` alone left a relative value relative, so `database` broke the
 * contract its own type states, and this module disagreed with itself: an
 * ingest root goes through `canonical()`, which resolves. Measured before this
 * existed — `{"database":"relative.sqlite"}` run from two directories opened
 * two unrelated databases while the banner reported the bare word
 * `relative.sqlite` for both, which names no file an operator can go and find.
 *
 * `resolve` is against the working directory, so it does not make a relative
 * value *safe* — under launchd (cwd `/`) it resolves to `/relative.sqlite`,
 * which nothing can write, and `openChamberDb` still redirects to `/tmp`. What
 * it does is make the value mean one nameable file per run instead of a
 * different one per caller, and make every report of it a path rather than a
 * fragment. The redirect itself is now reported honestly too; see `open()` in
 * src/cli.ts.
 *
 * `resolve` only, deliberately — not `realpathSync`. Roots need canonical
 * identity because they are compared against each other for overlap; a
 * database path is only ever opened, so resolving symlinks would buy nothing
 * and would report a path (`/private/var/…`) the operator never wrote.
 *
 * `:memory:` is a SQLite sentinel, not a path — `openChamberDb` already treats
 * it as one — so it passes through untouched rather than becoming a file
 * literally named `:memory:` in the working directory.
 */
function resolveDatabase(p: string): string {
  if (p === ":memory:") return p;
  return resolve(expandTilde(p));
}

export function configPath(): string {
  const explicit = envSetting("CHAMBER_CONFIG");
  if (explicit) return explicit;
  const xdg = envSetting("XDG_CONFIG_HOME");
  if (xdg) return join(xdg, "chamber", "config.json");
  return join(homedir(), ".config", "chamber", "config.json");
}

interface RawConfig {
  database?: unknown;
  model?: unknown;
  ingest?: unknown;
}

function readRaw(path: string): RawConfig | null {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read config ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `config ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config ${path} must be a JSON object`);
  }
  for (const key of Object.keys(parsed as object)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      throw new Error(
        `config ${path}: unknown key "${key}" (known: ${[...KNOWN_TOP_LEVEL].join(", ")})`,
      );
    }
  }
  return parsed as RawConfig;
}

/**
 * The deepest ancestor of `abs` that exists, canonicalised, plus the segments
 * below it that do not exist yet.
 *
 * `realpathSync` fails on the whole path when only the leaf is missing, so
 * giving up and returning the un-resolved path leaves every symlink in the
 * *prefix* unresolved too. That is how "<base>/notes" and "<base>/link/notyet"
 * (link -> notes) used to look like unrelated directories. Resolving as far as
 * the filesystem can and re-appending the rest keeps the prefix honest.
 */
function deepestExisting(abs: string): { real: string; rest: string[] } {
  let head = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return { real: realpathSync(head), rest };
    } catch {
      const parent = dirname(head);
      if (parent === head) return { real: head, rest }; // nothing on this path exists
      rest.unshift(basename(head));
      head = parent;
    }
  }
}

/** The same path with the case of its last cased letter flipped, or null. */
function flipLastLetter(p: string): string | null {
  for (let i = p.length - 1; i >= 0; i--) {
    const c = p[i]!;
    const lower = c.toLowerCase();
    const upper = c.toUpperCase();
    if (lower === upper) continue; // not a cased character
    const flipped = c === lower ? upper : lower;
    if (flipped.length !== 1) continue; // e.g. "ß" uppercases to "SS"
    return p.slice(0, i) + flipped + p.slice(i + 1);
  }
  return null;
}

/**
 * Whether the filesystem holding `existing` folds case — probed, not guessed.
 *
 * "<base>/Vault" and "<base>/VAULT" are one directory on macOS APFS and two on
 * ext4, and `realpathSync` case-canonicalises on neither. Comparing every path
 * case-insensitively would catch the macOS duplicate but wrongly merge two
 * genuinely distinct directories on a case-sensitive filesystem, so instead we
 * ask the filesystem: flip one letter of a path that exists and see whether the
 * flipped spelling lands on the same (device, inode). Same inode means the
 * volume folds case; a miss, or a different inode, means it does not.
 *
 * A path with no cased letters reports false, which is correct rather than
 * merely safe: folding case cannot change how such a path compares.
 *
 * Caveat: a directory entry lives in its *parent's* filesystem, so a root that
 * is itself a mount point is probed against the volume it is mounted on. That
 * can over-report folding for a case-sensitive volume mounted under a
 * case-insensitive one — which errs toward rejecting an overlap, the direction
 * this module already fails in.
 */
function foldsCase(existing: string): boolean {
  const flipped = flipLastLetter(existing);
  if (flipped === null) return false;
  try {
    const a = statSync(existing, { bigint: true });
    const b = statSync(flipped, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false; // the flipped spelling does not resolve — case matters here
  }
}

interface CanonicalPath {
  /** Absolute, tilde-expanded, symlinks resolved as far as they exist. */
  path: string;
  /** `path`, case-folded when and only when its filesystem folds case. */
  key: string;
}

function canonical(p: string): CanonicalPath {
  const abs = resolve(expandTilde(p));
  const { real, rest } = deepestExisting(abs);
  const full = rest.length === 0 ? real : join(real, ...rest);
  return { path: full, key: foldsCase(real) ? full.toLowerCase() : full };
}

/**
 * Reject roots that are the same directory or nested one inside the other.
 * Comparison runs on the canonical keys; the message names the paths the
 * operator actually wrote — plus, when a symlink or case-folding volume made
 * those differ from what they resolved to, what they resolved to as well.
 *
 * `roots[i].root` used to be what got named here, and by the time this runs
 * `parseIngest` has already overwritten it with the canonical path — so this
 * comment's claim was false whenever a symlink or case-folding was the actual
 * cause of the overlap: the message named two paths that appear nowhere in
 * the config file, leaving no way to tell which entry to remove. `written`
 * carries the string exactly as `parseIngest` read it from the file, parallel
 * to `roots` and `keys`, so both forms can be named.
 */
function assertNoOverlap(
  roots: IngestRootConfig[],
  keys: string[],
  written: string[],
  path: string,
): void {
  const why =
    `Overlapping roots duplicate the same file and strand rows when one shrinks.`;
  const name = (i: number): string =>
    written[i] === roots[i]!.root
      ? `"${written[i]}"`
      : `"${written[i]}" (resolved: "${roots[i]!.root}")`;
  for (let i = 0; i < roots.length; i++) {
    for (let j = 0; j < roots.length; j++) {
      if (i === j) continue;
      const a = keys[i]!;
      const b = keys[j]!;
      if (b === a) {
        throw new Error(
          `config ${path}: ingest roots overlap — ${name(j)} and ` +
            `${name(i)} are the same directory. ${why}`,
        );
      }
      // Compare on a separator boundary so "notes" does not swallow
      // "notes-archive".
      if (b.startsWith(a.endsWith(sep) ? a : a + sep)) {
        throw new Error(
          `config ${path}: ingest roots overlap — ${name(j)} is inside ${name(i)}. ` +
            why,
        );
      }
    }
  }
}

function parseIngest(raw: unknown, path: string): IngestRootConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`config ${path}: "ingest" must be an array`);
  const out: IngestRootConfig[] = [];
  const keys: string[] = [];
  const written: string[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`config ${path}: each "ingest" entry must be an object`);
    }
    for (const key of Object.keys(entry as object)) {
      if (!KNOWN_INGEST_KEYS.has(key)) {
        throw new Error(
          `config ${path}: unknown ingest key "${key}" (known: ${[...KNOWN_INGEST_KEYS].join(", ")})`,
        );
      }
    }
    const e = entry as { root?: unknown; exclude?: unknown };
    if (typeof e.root !== "string" || e.root.trim() === "") {
      throw new Error(`config ${path}: every "ingest" entry needs a non-empty "root"`);
    }
    let exclude: string[] = [];
    if (e.exclude !== undefined) {
      if (!Array.isArray(e.exclude) || e.exclude.some((x) => typeof x !== "string")) {
        throw new Error(`config ${path}: "exclude" must be an array of strings`);
      }
      exclude = e.exclude as string[];
    }
    const c = canonical(e.root);
    out.push({ root: c.path, exclude });
    keys.push(c.key);
    written.push(e.root);
  }
  assertNoOverlap(out, keys, written, path);
  return out;
}

/**
 * A blank string is not a value. `{"database":""}` and `{"database":"   "}` are
 * rejected here for the same reason `envSetting` drops a blank export: an empty
 * database path opens a throwaway temporary SQLite file that swallows every
 * write. An `ingest` entry's "root" has always been held to this rule.
 */
function parseDatabase(raw: unknown, path: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new Error(`config ${path}: "database" must be a string`);
  }
  if (raw.trim() === "") {
    throw new Error(`config ${path}: "database" must not be empty`);
  }
  return raw;
}

function parseModel(raw: unknown, path: string): { base?: string; name?: string } {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config ${path}: "model" must be an object`);
  }
  for (const key of Object.keys(raw as object)) {
    if (!KNOWN_MODEL_KEYS.has(key)) {
      throw new Error(
        `config ${path}: unknown model key "${key}" (known: ${[...KNOWN_MODEL_KEYS].join(", ")})`,
      );
    }
  }
  const m = raw as { base?: unknown; name?: unknown };
  for (const [key, value] of [
    ["base", m.base],
    ["name", m.name],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new Error(`config ${path}: "model.${key}" must be a string`);
    }
    if (value.trim() === "") {
      throw new Error(`config ${path}: "model.${key}" must not be empty`);
    }
  }
  return { base: m.base as string | undefined, name: m.name as string | undefined };
}

/**
 * Whether `base` names a server on this machine.
 *
 * The parse is left to WHATWG `URL`, which normalises every spelling of an
 * IPv4 literal to dotted-quad before this sees it — `127.1`, `0x7f.0.0.1` and
 * `2130706433` all arrive as `127.0.0.1`, so one regex covers the family
 * instead of the four it looks like. It also strips userinfo, so
 * `http://anything@127.0.0.1/` reports the host the request actually goes to,
 * and it does not confuse `127.0.0.1.evil.com` with a loopback address.
 *
 * Accepted: `http:`/`https:` to `localhost`, `[::1]`, or anything in
 * `127.0.0.0/8`. Everything else is refused, including forms that are
 * loopback-equivalent but rare enough not to be worth widening the rule for
 * (`[::ffff:127.0.0.1]`, `0.0.0.0`) — this predicate errs toward refusing, the
 * direction a gate is supposed to err in.
 *
 * `localhost` is accepted as written. It is resolver-dependent, so an attacker
 * who can already edit `/etc/hosts` can point it elsewhere — but that attacker
 * has root and does not need this route. Refusing the most common spelling of
 * a local endpoint would cost every honest operator something to buy nothing.
 */
export function isLoopbackBase(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname; // already lowercased by URL
  if (host === "localhost" || host === "[::1]") return true;
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!quad) return false;
  const octets = quad.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 127;
}

/**
 * Refuse a file-sourced `model.base` that names anything but this machine.
 *
 * This is the decision the NOTE in `loadConfig` used to defer. Of the three
 * options it named, loopback is the only one that satisfies both constraints
 * at once. "Refuse a file-sourced base while a key is present" would break the
 * documented local-first setup outright — `src/model.ts` *requires*
 * CHAMBER_API_KEY in `openai` mode even when the server is a local one that
 * ignores it, so a key is always present and the rule would refuse every
 * config `chamber init` writes. "Require an explicit opt-in" cannot take the
 * opt-in from the config file, because the file is the thing being gated; an
 * opt-in from outside the file is precisely what CHAMBER_API_BASE already is.
 *
 * So: the file may name a local server, and only the operator's own
 * environment may name a remote one. A stray or hostile mode-644 JSON file can
 * still redirect the request — but only to a listener on this machine, which
 * is a host the operator already controls, and never off the box.
 *
 * Enforced only when the file's value is the one that wins. An env-supplied
 * CHAMBER_API_BASE outranks the file, so the file's value never reaches a
 * request and refusing on it would break a working setup over a string with no
 * effect.
 */
function assertFileBaseIsLocal(base: string, path: string): void {
  if (isLoopbackBase(base)) return;
  throw new Error(
    `config ${path}: "model.base" from a config file must name this machine ` +
      `(http://127.0.0.1:PORT/…, http://localhost:PORT/…, http://[::1]:PORT/…) — ` +
      `got ${JSON.stringify(base)}. CHAMBER_API_KEY is read from the environment ` +
      `and sent as "Authorization: Bearer <key>" to whatever this names, so a ` +
      `config file naming a remote host can redirect your key to it. To use a ` +
      `remote base, say so yourself: export CHAMBER_API_BASE=${base}`,
  );
}

interface ParsedFile {
  database?: string;
  model: { base?: string; name?: string };
  ingest: IngestRootConfig[];
}

/**
 * Read and fully validate the config file. Both `loadConfig` and
 * `explainConfig` go through here, so they cannot disagree about what is
 * loadable. They used to: `explainConfig` skipped the `database` type check and
 * `parseIngest` entirely, so `config show` called a config healthy that
 * `loadConfig` refused, and handed a formatter a number where the type says
 * string.
 */
function parseFile(path: string): ParsedFile {
  const raw = readRaw(path);
  return {
    database: parseDatabase(raw?.database, path),
    model: parseModel(raw?.model, path),
    ingest: parseIngest(raw?.ingest, path),
  };
}

export function loadConfig(opts: { path?: string } = {}): ChamberConfig {
  const path = opts.path ?? configPath();
  const file = parseFile(path);

  const database = resolveDatabase(
    envSetting("CHAMBER_DB") ?? file.database ?? defaultDatabase(),
  );

  // The config file cannot *hold* an API key, but `model.base` lets it *steer*
  // one: src/model.ts reads CHAMBER_API_KEY from the environment and sends it
  // as `Authorization: Bearer <key>` to whatever CHAMBER_API_BASE names, and
  // src/cli.ts seeds CHAMBER_API_BASE from this value. A file that is not
  // itself a secret can therefore point an environment-supplied key at a host
  // of its choosing — proven by pointing a mode-644 config at a local listener
  // and watching the real key arrive on it.
  //
  // So a base that comes from the file is restricted to this machine, and only
  // an env-supplied CHAMBER_API_BASE may name a remote host. See
  // `assertFileBaseIsLocal` for why loopback rather than the alternatives, and
  // why the check runs only when the file's value is the one that wins.
  const envBase = envSetting("CHAMBER_API_BASE");
  if (envBase === undefined && file.model.base !== undefined) {
    assertFileBaseIsLocal(file.model.base, path);
  }
  const model = {
    base: envBase ?? file.model.base,
    name: envSetting("CHAMBER_API_MODEL") ?? file.model.name,
  };

  return { database, model, ingest: file.ingest };
}

function resolveOne(
  key: string,
  envValue: string | undefined,
  fileValue: string | undefined,
  defaultValue: string | undefined,
): ResolvedSetting | null {
  if (envValue !== undefined) {
    const conflict =
      fileValue !== undefined && fileValue !== envValue ? fileValue : undefined;
    return { key, value: envValue, source: "env", conflict };
  }
  if (fileValue !== undefined) return { key, value: fileValue, source: "config" };
  if (defaultValue !== undefined) return { key, value: defaultValue, source: "default" };
  return null;
}

export function explainConfig(): ResolvedSetting[] {
  const path = configPath();
  // Same validation as loadConfig — a config `config show` calls healthy must
  // be a config Chamber can actually load.
  const file = parseFile(path);
  const out: ResolvedSetting[] = [];

  // Report the path that will be used, not the one the file spells: loadConfig
  // expands `~`, so an unexpanded value here would name a directory Chamber
  // never opens.
  const envDb = envSetting("CHAMBER_DB");
  const db = resolveOne(
    "database",
    envDb === undefined ? undefined : resolveDatabase(envDb),
    file.database === undefined ? undefined : resolveDatabase(file.database),
    defaultDatabase(),
  );
  if (db) out.push(db);

  // Refused on exactly the terms loadConfig refuses it on, for the same reason
  // `parseFile` is shared: a config `config show` calls healthy must be a
  // config Chamber can actually load. `cmdConfig` catches this throw and names
  // the file, so the diagnosis path stays legible.
  const envBase = envSetting("CHAMBER_API_BASE");
  if (envBase === undefined && file.model.base !== undefined) {
    assertFileBaseIsLocal(file.model.base, path);
  }
  const base = resolveOne("model.base", envBase, file.model.base, undefined);
  if (base) out.push(base);

  const name = resolveOne(
    "model.name",
    envSetting("CHAMBER_API_MODEL"),
    file.model.name,
    undefined,
  );
  if (name) out.push(name);

  // Ingest roots and their excludes are the privacy boundary that keeps
  // `chamber ingest` out of restricted folders — the setting an operator
  // most needs to see without opening the file by hand, and the one
  // `explainConfig` used to omit entirely. There is no environment override
  // for `ingest`, so every row here is config-sourced; an empty list is
  // reported explicitly rather than by omission, so "print every setting"
  // includes "there are none" as an answer. `file.ingest` is already
  // canonicalised and overlap-checked by `parseFile`, so what is printed
  // here is exactly what `loadConfig().ingest` resolves to.
  if (file.ingest.length === 0) {
    out.push({ key: "ingest", value: "(none configured)", source: "default" });
  } else {
    file.ingest.forEach((entry, i) => {
      out.push({ key: `ingest[${i}].root`, value: entry.root, source: "config" });
      out.push({
        key: `ingest[${i}].exclude`,
        value: entry.exclude.length > 0 ? entry.exclude.join(", ") : "(none)",
        source: "config",
      });
    });
  }

  // XDG_CONFIG_HOME is an environment variable like any other: when it decides
  // where the config lives, the source is the environment, not a default.
  const fromEnv =
    envSetting("CHAMBER_CONFIG") !== undefined ||
    envSetting("XDG_CONFIG_HOME") !== undefined;
  out.push({
    key: "config",
    value: existsSync(path) ? path : `${path} (not present)`,
    source: fromEnv ? "env" : "default",
  });

  return out;
}
