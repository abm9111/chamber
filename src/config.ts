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

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

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
  if (process.env.CHAMBER_CONFIG) return process.env.CHAMBER_CONFIG;
  const xdg = process.env.XDG_CONFIG_HOME;
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

/** Absolute, tilde-expanded, symlinks resolved when the path exists. */
function canonical(p: string): string {
  const abs = resolve(expandTilde(p));
  try {
    return realpathSync(abs);
  } catch {
    return abs; // does not exist yet — reported per-root at ingest time
  }
}

function assertNoOverlap(roots: IngestRootConfig[], path: string): void {
  for (let i = 0; i < roots.length; i++) {
    for (let j = 0; j < roots.length; j++) {
      if (i === j) continue;
      const a = roots[i]!.root;
      const b = roots[j]!.root;
      // Compare on a separator boundary so "notes" does not swallow
      // "notes-archive".
      if (b === a || b.startsWith(a.endsWith(sep) ? a : a + sep)) {
        throw new Error(
          `config ${path}: ingest roots overlap — "${b}" is inside "${a}". ` +
            `Overlapping roots duplicate the same file and strand rows when one shrinks.`,
        );
      }
    }
  }
}

function parseIngest(raw: unknown, path: string): IngestRootConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`config ${path}: "ingest" must be an array`);
  const out: IngestRootConfig[] = [];
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
    out.push({ root: canonical(e.root), exclude });
  }
  assertNoOverlap(out, path);
  return out;
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
  if (m.base !== undefined && typeof m.base !== "string") {
    throw new Error(`config ${path}: "model.base" must be a string`);
  }
  if (m.name !== undefined && typeof m.name !== "string") {
    throw new Error(`config ${path}: "model.name" must be a string`);
  }
  return { base: m.base as string | undefined, name: m.name as string | undefined };
}

export function loadConfig(opts: { path?: string } = {}): ChamberConfig {
  const path = opts.path ?? configPath();
  const raw = readRaw(path);

  if (raw?.database !== undefined && typeof raw.database !== "string") {
    throw new Error(`config ${path}: "database" must be a string`);
  }

  const fileDb = raw?.database as string | undefined;
  const database = expandTilde(
    process.env.CHAMBER_DB ?? fileDb ?? defaultDatabase(),
  );

  const fileModel = parseModel(raw?.model, path);
  const model = {
    base: process.env.CHAMBER_API_BASE ?? fileModel.base,
    name: process.env.CHAMBER_API_MODEL ?? fileModel.name,
  };

  return { database, model, ingest: parseIngest(raw?.ingest, path) };
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
  const raw = readRaw(path);
  const fileModel = parseModel(raw?.model, path);
  const out: ResolvedSetting[] = [];

  const db = resolveOne(
    "database",
    process.env.CHAMBER_DB,
    raw?.database as string | undefined,
    defaultDatabase(),
  );
  if (db) out.push(db);

  const base = resolveOne("model.base", process.env.CHAMBER_API_BASE, fileModel.base, undefined);
  if (base) out.push(base);

  const name = resolveOne("model.name", process.env.CHAMBER_API_MODEL, fileModel.name, undefined);
  if (name) out.push(name);

  out.push({
    key: "config",
    value: existsSync(path) ? path : `${path} (not present)`,
    source: process.env.CHAMBER_CONFIG ? "env" : "default",
  });

  return out;
}
