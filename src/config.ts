/**
 * Settings resolution.
 *
 * Precedence: CLI flag > environment variable > config file > built-in default.
 * The file only fills gaps, so every existing CHAMBER_* variable keeps working.
 *
 * There is deliberately no field for an API key. CHAMBER_API_KEY is read from
 * the environment by src/model.ts and nowhere else, so a key cannot reach a
 * config file by accident.
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
 * operator actually wrote.
 */
function assertNoOverlap(
  roots: IngestRootConfig[],
  keys: string[],
  path: string,
): void {
  const why =
    `Overlapping roots duplicate the same file and strand rows when one shrinks.`;
  for (let i = 0; i < roots.length; i++) {
    for (let j = 0; j < roots.length; j++) {
      if (i === j) continue;
      const a = keys[i]!;
      const b = keys[j]!;
      if (b === a) {
        throw new Error(
          `config ${path}: ingest roots overlap — "${roots[j]!.root}" and ` +
            `"${roots[i]!.root}" are the same directory. ${why}`,
        );
      }
      // Compare on a separator boundary so "notes" does not swallow
      // "notes-archive".
      if (b.startsWith(a.endsWith(sep) ? a : a + sep)) {
        throw new Error(
          `config ${path}: ingest roots overlap — "${roots[j]!.root}" is inside "${roots[i]!.root}". ` +
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
  }
  assertNoOverlap(out, keys, path);
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

  const database = expandTilde(
    envSetting("CHAMBER_DB") ?? file.database ?? defaultDatabase(),
  );

  // NOTE — the config file cannot *hold* an API key, but `model.base` lets it
  // *steer* one. src/model.ts reads CHAMBER_API_KEY from the environment and
  // sends it as `Authorization: Bearer <key>` to whatever CHAMBER_API_BASE
  // names. The moment this resolved `model.base` is wired into that request,
  // a config file gains the power to redirect an environment-supplied key to
  // an arbitrary host — a file that is not itself a secret becomes able to
  // exfiltrate one. Whoever wires it in owes this a decision: either refuse a
  // file-sourced base while a key is present, restrict it to loopback, or
  // require an explicit opt-in. Do not let it default quietly.
  const model = {
    base: envSetting("CHAMBER_API_BASE") ?? file.model.base,
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
    envDb === undefined ? undefined : expandTilde(envDb),
    file.database === undefined ? undefined : expandTilde(file.database),
    defaultDatabase(),
  );
  if (db) out.push(db);

  const base = resolveOne(
    "model.base",
    envSetting("CHAMBER_API_BASE"),
    file.model.base,
    undefined,
  );
  if (base) out.push(base);

  const name = resolveOne(
    "model.name",
    envSetting("CHAMBER_API_MODEL"),
    file.model.name,
    undefined,
  );
  if (name) out.push(name);

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
