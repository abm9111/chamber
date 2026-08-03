# Durable Daily Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chamber survive a reboot and run unattended, so its drift-detection capability is reachable without typing five environment variables.

**Architecture:** One new pure module (`src/config.ts`) resolves settings from flags, environment, a JSON config file, and defaults. `src/cli.ts` calls it once before opening the database. A `bin` entry makes `chamber` a real command. A launchd plist runs `chamber verify` on a schedule.

**Tech Stack:** TypeScript on `node:sqlite`, run natively by Node (v26 on the development machine strips types without a flag). Zero runtime dependencies. Existing modules touched: `src/cli.ts`, `src/ingest.ts` (consumed unchanged), `tests/harness.ts`.

## Global Constraints

- **Zero runtime dependencies.** `package.json` `dependencies` must stay absent/empty. `node:` builtins only.
- **No API key may be readable from a config file.** The loader has no field for one; `CHAMBER_API_KEY` is read from the environment and nowhere else.
- **Precedence is CLI flag → environment variable → config file → built-in default.** Every existing `CHAMBER_*` variable keeps working unchanged.
- **Fail closed and loud.** A malformed config is a hard error, never partially applied. An unknown top-level key is rejected, not ignored.
- **No new `sql/*.sql` files.** If that ever changes, the file must be appended to `SCHEMA_FILES` in `src/db.ts` or it will never load.
- **Do not change** retrieval, the pin hash formula, `sourceRef` semantics, or the gate.
- `npm run test` currently passes 217/217 and must stay green.
- The test runner is strict: a test returning a Promise without being declared `async` fails outright, and every registered test must produce a result. Write synchronous tests.
- Tests must use a temp `CHAMBER_CONFIG` and never read or write a real user config.
- Commit format: `type: description`, with body, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/config.ts` | create | Resolve one merged settings object: read file, expand `~`, validate, reject unknown keys and overlapping roots, apply precedence. Pure apart from one file read. |
| `src/cli.ts` | modify | Call `loadConfig()` once before `open()`; replace the `/tmp` database default; seed model env vars where unset; add `init` and `config` commands; make `ingest` work with no positional argument. |
| `package.json` | modify | `bin` entry so `chamber` is a command; raise the `engines` floor. |
| `deploy/launchd/com.chamber.verify.plist` | create | Scheduled `chamber verify` with logging. |
| `deploy/SCHEDULING.md` | create | How to install the plist, and the crontab equivalent for Linux. |
| `tests/harness.ts` | modify | New `config` suite; two subprocess tests in the existing `cli` suite. |

`src/config.ts` is deliberately separate from `src/cli.ts` — `cli.ts` is already ~1400 lines, and config resolution needs unit tests that never spawn a process.

---

### Task 1: `src/config.ts` — resolution, validation, precedence

**Files:**
- Create: `src/config.ts`
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```typescript
  export interface IngestRootConfig { root: string; exclude: string[] }
  export interface ChamberConfig {
    database: string;
    model: { base?: string; name?: string };
    ingest: IngestRootConfig[];
  }
  export interface ResolvedSetting {
    key: string;
    value: string;
    source: "env" | "config" | "default";
    conflict?: string;
  }
  export function expandTilde(p: string): string;
  export function configPath(): string;
  export function loadConfig(opts?: { path?: string }): ChamberConfig;
  export function explainConfig(): ResolvedSetting[];
  ```

- [ ] **Step 1: Add the `config` suite name to the runner**

In `tests/harness.ts`, add `"config"` to the `Suite` union and to the validation array inside `suiteFromArg()`, exactly as `"pins"` and `"cli"` already appear in both places. Missing either one leaves `--suite=config` silently unfiltered.

- [ ] **Step 2: Write the failing tests**

Add these to `tests/harness.ts`. `mkdtempSync`, `writeFileSync`, `tmpdir` and `join` are already imported there.

```typescript
function withConfig<T>(json: string | null, fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "chamber-cfg-"));
  const p = join(dir, "config.json");
  if (json !== null) writeFileSync(p, json);
  const prevCfg = process.env.CHAMBER_CONFIG;
  const prevDb = process.env.CHAMBER_DB;
  const prevBase = process.env.CHAMBER_API_BASE;
  process.env.CHAMBER_CONFIG = p;
  delete process.env.CHAMBER_DB;
  delete process.env.CHAMBER_API_BASE;
  try {
    return fn();
  } finally {
    if (prevCfg === undefined) delete process.env.CHAMBER_CONFIG;
    else process.env.CHAMBER_CONFIG = prevCfg;
    if (prevDb === undefined) delete process.env.CHAMBER_DB;
    else process.env.CHAMBER_DB = prevDb;
    if (prevBase === undefined) delete process.env.CHAMBER_API_BASE;
    else process.env.CHAMBER_API_BASE = prevBase;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config", "expandTilde resolves a leading tilde to the home directory", () => {
  const out = expandTilde("~/x/y.sqlite");
  assert(out.startsWith(homedir()), `expected home prefix, got ${out}`);
  assert(!out.includes("~"), `tilde survived: ${out}`);
  assert(expandTilde("/abs/path") === "/abs/path", "absolute paths must pass through");
  assert(expandTilde("rel/path") === "rel/path", "relative paths must pass through");
});

test("config", "a missing config file yields defaults without throwing", () => {
  withConfig(null, () => {
    const cfg = loadConfig();
    assert(cfg.database.length > 0, "database must have a default");
    assert(cfg.ingest.length === 0, "ingest defaults to empty");
  });
});

test("config", "config supplies the database when no env var is set", () => {
  withConfig(`{"database":"/tmp/from-config.sqlite"}`, () => {
    assert(
      loadConfig().database === "/tmp/from-config.sqlite",
      "config value must win over the default",
    );
  });
});

test("config", "env beats config and the disagreement is reported", () => {
  withConfig(`{"database":"/tmp/from-config.sqlite"}`, () => {
    process.env.CHAMBER_DB = "/tmp/from-env.sqlite";
    try {
      assert(loadConfig().database === "/tmp/from-env.sqlite", "env must win");
      const row = explainConfig().find((r) => r.key === "database");
      assert(row?.source === "env", `expected source=env, got ${row?.source}`);
      assert(
        row?.conflict === "/tmp/from-config.sqlite",
        `expected the losing value reported, got ${row?.conflict}`,
      );
    } finally {
      delete process.env.CHAMBER_DB;
    }
  });
});

test("config", "identical env and config values report no conflict", () => {
  withConfig(`{"database":"/tmp/same.sqlite"}`, () => {
    process.env.CHAMBER_DB = "/tmp/same.sqlite";
    try {
      const row = explainConfig().find((r) => r.key === "database");
      assert(row?.conflict === undefined, `expected no conflict, got ${row?.conflict}`);
    } finally {
      delete process.env.CHAMBER_DB;
    }
  });
});

test("config", "an unknown top-level key is rejected", () => {
  withConfig(`{"database":"/tmp/x.sqlite","excludes":["oops"]}`, () => {
    let msg = "";
    try { loadConfig(); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    assert(msg.includes("excludes"), `error must name the unknown key, got: ${msg}`);
  });
});

test("config", "malformed JSON throws and names the file", () => {
  withConfig(`{ not json`, () => {
    let msg = "";
    try { loadConfig(); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    assert(msg.includes("config.json"), `error must name the file, got: ${msg}`);
  });
});

test("config", "overlapping ingest roots are rejected, naming both", () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-roots-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  const json = JSON.stringify({ ingest: [{ root: dir }, { root: join(dir, "sub") }] });
  withConfig(json, () => {
    let msg = "";
    try { loadConfig(); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    assert(msg.includes("sub"), `error must name the nested root, got: ${msg}`);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("config", "sibling roots that share a name prefix are not treated as overlapping", () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-sib-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  mkdirSync(join(dir, "notes-archive"), { recursive: true });
  const json = JSON.stringify({
    ingest: [{ root: join(dir, "notes") }, { root: join(dir, "notes-archive") }],
  });
  withConfig(json, () => {
    const cfg = loadConfig();
    assert(cfg.ingest.length === 2, "sibling roots must both survive");
  });
  rmSync(dir, { recursive: true, force: true });
});

test("config", "no config field can supply an API key", () => {
  withConfig(`{"database":"/tmp/x.sqlite"}`, () => {
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    assert(!("apiKey" in cfg), "ChamberConfig must not carry an apiKey field");
    assert(
      JSON.stringify(cfg).toLowerCase().includes("key") === false,
      "no resolved config value may look like a key field",
    );
  });
});
```

Add to the imports at the top of `tests/harness.ts`:

```typescript
import { homedir } from "node:os";
import {
  expandTilde,
  loadConfig,
  explainConfig,
} from "../src/config.ts";
```

`mkdirSync` and `rmSync` must also be present in the existing `node:fs` import — add whichever is missing.

- [ ] **Step 3: Run and watch them fail**

Run: `npm run test -- --suite=config`
Expected: FAIL — cannot find module `../src/config.ts`

- [ ] **Step 4: Write `src/config.ts`**

```typescript
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
```

- [ ] **Step 5: Run and watch them pass**

Run: `npm run test -- --suite=config`
Expected: 10 passed, 0 failed

- [ ] **Step 6: Run the whole suite**

Run: `npm run test`
Expected: 227/227 passed, 0 failed

- [ ] **Step 7: Commit**

```bash
git add src/config.ts tests/harness.ts
git commit -m "feat: resolve settings from a config file, env, and defaults

Chamber had no file-based configuration — 25 CHAMBER_* variables and
nothing that reads a file, so nothing survived a shell session.

Precedence is flag > env > config > default, so every existing variable
keeps working and the file only fills gaps. There is no field for an API
key: CHAMBER_API_KEY is read from the environment and nowhere else.

Unknown keys are rejected rather than ignored — a typo'd \"excludes\" for
\"exclude\" would otherwise silently ingest a deny-listed folder. Overlapping
ingest roots are rejected at load, because they duplicate the same file and
strand rows when one shrinks. A leading tilde is expanded explicitly;
nothing else expands it, and an unexpanded path creates a directory
literally named \"~\".

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire config into the CLI

**Files:**
- Modify: `src/cli.ts` — the `dbPath()` function (around line 160) and `main()`
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `loadConfig`, `ChamberConfig` from Task 1
- Produces: `main()` resolves settings once before `open()`; `process.env.CHAMBER_API_BASE` and `CHAMBER_API_MODEL` are seeded from config only where unset.

- [ ] **Step 1: Write the failing test**

```typescript
test("cli", "cli_uses_the_configured_database", () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-cliCfg-"));
  const dbFile = join(dir, "configured.sqlite");
  const cfgFile = join(dir, "config.json");
  writeFileSync(cfgFile, JSON.stringify({ database: dbFile }));
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI_PATH, "status"],
    {
      encoding: "utf8",
      env: { ...process.env, CHAMBER_CONFIG: cfgFile, CHAMBER_DB: "" },
    },
  );
  assert(r.status === 0, `status failed: ${r.stderr}`);
  assert(
    r.stdout.includes(dbFile),
    `status should report the configured db path, got:\n${r.stdout}`,
  );
  rmSync(dir, { recursive: true, force: true });
});
```

`CLI_PATH` is an existing module-level constant in `tests/harness.ts` (defined just above the `cli` suite tests) holding the absolute path to `src/cli.ts`. Reuse it; do not redefine it. Match the existing smoke tests by also passing `timeout: 15_000` in the `spawnSync` options.

Note the test sets `CHAMBER_DB: ""`. An empty string must not count as "set" — see Step 3.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -- --suite=cli`
Expected: FAIL — status reports `/tmp/chamber.sqlite`, not the configured path

- [ ] **Step 3: Replace the database default**

In `src/cli.ts`, add the import:

```typescript
import { loadConfig, type ChamberConfig } from "./config.ts";
```

Add a module-level holder next to `resolvedDbPath`:

```typescript
let loadedConfig: ChamberConfig | null = null;
```

Replace the body of `dbPath()`:

```typescript
/** Config-resolved path. Precedence: CHAMBER_DB > config file > default. */
function dbPath(): string {
  if (resolvedDbPath) return resolvedDbPath;
  // An empty CHAMBER_DB is not a setting — a wrapper that exports it unset
  // must fall through to the config file, not to an empty path.
  if (process.env.CHAMBER_DB === "") delete process.env.CHAMBER_DB;
  loadedConfig ??= loadConfig();
  resolvedDbPath = loadedConfig.database;
  return resolvedDbPath;
}
```

- [ ] **Step 4: Seed model settings from config where unset**

At the top of `main()`, before the `switch (cmd)`, add:

```typescript
  // The model layer reads CHAMBER_API_BASE / CHAMBER_API_MODEL from the
  // environment directly. Seeding only-where-unset preserves precedence by
  // construction, since env already outranks config. This is a seam, not an
  // architecture: close it when complete() takes explicit options.
  loadedConfig ??= loadConfig();
  if (!process.env.CHAMBER_API_BASE && loadedConfig.model.base) {
    process.env.CHAMBER_API_BASE = loadedConfig.model.base;
  }
  if (!process.env.CHAMBER_API_MODEL && loadedConfig.model.name) {
    process.env.CHAMBER_API_MODEL = loadedConfig.model.name;
  }
```

A malformed config now throws out of `main()`, which the existing `main().catch` handler prints via `formatErrorChain` and exits non-zero. That is the intended fail-closed behaviour.

- [ ] **Step 5: Run and watch it pass**

Run: `npm run test -- --suite=cli`
Expected: all `cli` tests pass, including the new one

Run: `npm run test`
Expected: 228/228 passed, 0 failed

- [ ] **Step 6: Verify by hand**

```bash
node --experimental-strip-types src/cli.ts status
```
Expected: exits 0, and the `db:` line shows the default `~/.local/share/chamber/chamber.sqlite` (not `/tmp/chamber.sqlite`), since no config exists yet.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts tests/harness.ts
git commit -m "feat: resolve the database and model from config in the CLI

The database defaulted to /tmp/chamber.sqlite, so a corpus did not survive
a reboot. It now comes from the config file, with CHAMBER_DB still winning.

An empty CHAMBER_DB is treated as unset: a wrapper exporting it blank must
fall through to the config, not to an empty path.

Model settings are seeded into the environment only where unset, which
preserves precedence by construction. That is a seam, documented at the
call site, and the place to close it is when complete() takes options.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `chamber init` and `chamber config show`

**Files:**
- Modify: `src/cli.ts` — new `case "init"` and `case "config"`, plus two `help()` lines
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `loadConfig`, `explainConfig`, `configPath` from Task 1
- Produces: two commands. `init` writes a starter config; `config show` prints resolved settings with sources.

- [ ] **Step 1: Write the failing tests**

```typescript
test("config", "init writes a config that loadConfig accepts", () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-init-"));
  const cfgFile = join(dir, "config.json");
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI_PATH, "init"],
    { encoding: "utf8", env: { ...process.env, CHAMBER_CONFIG: cfgFile } },
  );
  assert(r.status === 0, `init failed: ${r.stderr}`);
  assert(existsSync(cfgFile), "init must write the config file");
  const parsed = JSON.parse(readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
  assert("database" in parsed, "starter config must set a database");
  rmSync(dir, { recursive: true, force: true });
});

test("config", "init refuses to overwrite without --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-init2-"));
  const cfgFile = join(dir, "config.json");
  writeFileSync(cfgFile, `{"database":"/tmp/keep.sqlite"}`);
  const env = { ...process.env, CHAMBER_CONFIG: cfgFile };
  const bin = ["--experimental-strip-types", CLI_PATH];
  const refused = spawnSync(process.execPath, [...bin, "init"], { encoding: "utf8", env });
  assert(refused.status !== 0, "init must refuse to overwrite");
  assert(
    readFileSync(cfgFile, "utf8").includes("keep.sqlite"),
    "the existing config must be untouched",
  );
  const forced = spawnSync(process.execPath, [...bin, "init", "--force"], {
    encoding: "utf8",
    env,
  });
  assert(forced.status === 0, `init --force failed: ${forced.stderr}`);
  rmSync(dir, { recursive: true, force: true });
});

test("config", "config show reports the source of each setting", () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-show-"));
  const cfgFile = join(dir, "config.json");
  writeFileSync(cfgFile, `{"database":"/tmp/from-config.sqlite"}`);
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI_PATH, "config", "show"],
    {
      encoding: "utf8",
      env: { ...process.env, CHAMBER_CONFIG: cfgFile, CHAMBER_DB: "/tmp/from-env.sqlite" },
    },
  );
  assert(r.status === 0, `config show failed: ${r.stderr}`);
  assert(r.stdout.includes("from-env.sqlite"), "must show the winning value");
  assert(r.stdout.includes("env"), "must name the source");
  assert(r.stdout.includes("from-config.sqlite"), "must show the losing value on conflict");
  rmSync(dir, { recursive: true, force: true });
});
```

Ensure `existsSync` and `readFileSync` are in the `node:fs` import in `tests/harness.ts`.

- [ ] **Step 2: Run and watch them fail**

Run: `npm run test -- --suite=config`
Expected: FAIL — `init` is not a known command

- [ ] **Step 3: Add both commands**

In `src/cli.ts`, extend the import from `./config.ts`:

```typescript
import {
  loadConfig,
  explainConfig,
  configPath,
  type ChamberConfig,
} from "./config.ts";
```

Add to the `switch (cmd)` block:

```typescript
    case "init": {
      const target = configPath();
      const force = rest.includes("--force");
      if (existsSync(target) && !force) {
        console.error(`config already exists: ${target}`);
        console.error("  pass --force to overwrite it");
        process.exitCode = 1;
        break;
      }
      mkdirSync(dirname(target), { recursive: true });
      const starter = {
        database: join(homedir(), ".local", "share", "chamber", "chamber.sqlite"),
        model: { base: "http://127.0.0.1:8087/v1", name: "" },
        ingest: [] as { root: string; exclude: string[] }[],
      };
      writeFileSync(target, `${JSON.stringify(starter, null, 2)}\n`);
      console.log(`wrote ${target}`);
      console.log("  set model.name, then add ingest roots with their excludes");
      console.log("  API keys are read from CHAMBER_API_KEY, never from this file");
      console.log("  run `chamber config show` to see what is in effect");
      break;
    }
    case "config": {
      const sub = rest[0];
      if (sub !== "show") {
        console.error("usage: chamber config show");
        process.exitCode = 1;
        break;
      }
      for (const row of explainConfig()) {
        const conflict = row.conflict ? `  (config says ${row.conflict})` : "";
        console.log(`  ${row.key} = ${row.value}   [from ${row.source}]${conflict}`);
      }
      break;
    }
```

`writeFileSync`, `existsSync`, `mkdirSync`, `dirname` and `homedir` must be imported in `src/cli.ts`. `mkdirSync` and `readFileSync` are already imported from `node:fs`; add `writeFileSync` and `existsSync` to that import, `dirname` is already imported from `node:path`, and add `homedir` from `node:os`.

Add to the `help()` text — note these lines go inside an existing template literal, so **do not use backticks** in them:

```
  init [--force]                     write a starter config file
  config show                        print every setting and where it came from
```

- [ ] **Step 4: Run and watch them pass**

Run: `npm run test -- --suite=config`
Expected: all pass

Run: `npm run test`
Expected: 231/231 passed, 0 failed

- [ ] **Step 5: Verify the CLI still starts**

Run: `node --experimental-strip-types src/cli.ts help`
Expected: exits 0 and prints the two new lines. If this fails with a `SyntaxError`, a backtick reached the help template literal — that exact bug has shipped twice.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/harness.ts
git commit -m "feat: add chamber init and chamber config show

init writes a starter config and refuses to overwrite one without --force.
config show prints every resolved setting with its source, and names the
losing value when an environment variable and the file disagree.

That visibility is the point: a stale exported CHAMBER_DB silently
redirects Chamber to a different corpus, and ask then answers from the
wrong evidence while looking healthy.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `chamber ingest` with no arguments

**Files:**
- Modify: `src/cli.ts` — the `case "ingest"` block (around line 743)
- Test: `tests/harness.ts`

**Interfaces:**
- Consumes: `loadConfig` from Task 1; `ingestDirectory` and `parseIngestArgs` from `src/ingest.ts`, both unchanged
- Produces: `chamber ingest` with no positional path ingests every configured root with its configured excludes

- [ ] **Step 1: Write the failing test**

```typescript
test("config", "ingest with no path uses the configured roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-cfging-"));
  const vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "a.md"), "alpha body\n");
  const dbFile = join(dir, "c.sqlite");
  const cfgFile = join(dir, "config.json");
  writeFileSync(
    cfgFile,
    JSON.stringify({ database: dbFile, ingest: [{ root: vault, exclude: [] }] }),
  );
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI_PATH, "ingest"],
    { encoding: "utf8", env: { ...process.env, CHAMBER_CONFIG: cfgFile, CHAMBER_DB: "" } },
  );
  assert(r.status === 0, `ingest failed: ${r.stderr}`);
  assert(r.stdout.includes("a.md") || r.stdout.includes("1 file"), `unexpected output:\n${r.stdout}`);
  rmSync(dir, { recursive: true, force: true });
});

test("config", "ingest with no path and no configured roots explains itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-noroots-"));
  const cfgFile = join(dir, "config.json");
  writeFileSync(cfgFile, JSON.stringify({ database: join(dir, "c.sqlite") }));
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI_PATH, "ingest"],
    { encoding: "utf8", env: { ...process.env, CHAMBER_CONFIG: cfgFile, CHAMBER_DB: "" } },
  );
  assert(r.status !== 0, "no roots configured must be an error, not a silent no-op");
  assert(
    (r.stderr + r.stdout).includes("ingest"),
    "the message must point at how to configure roots",
  );
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm run test -- --suite=config`
Expected: FAIL — `ingest` with no path prints the usage error

- [ ] **Step 3: Extract the per-root body, then branch**

In `src/cli.ts`, replace the `case "ingest"` block with the following. The per-root work moves into a local helper so the configured-roots loop and the explicit-path call share one implementation.

```typescript
    case "ingest": {
      const runOne = (
        path: string,
        opts: { exclude: string[]; includeDotted: boolean; requireExcludeMatch: boolean },
      ): boolean => {
        const r = ingestDirectory(db, path, opts);
        if (r.aborted) {
          console.error(`ingest refused: ${r.abortReason}`);
          console.error(
            r.abortKind === "unmatched_exclude"
              ? "  nothing was ingested. Fix the pattern, or pass --allow-unmatched-exclude to proceed anyway."
              : "  nothing was ingested. Fix the pattern.",
          );
          return false;
        }
        console.log(
          `ingested ${r.ingested} file(s) as ${r.passages} passage(s) from ${path}`,
        );
        return true;
      };

      const hasPath = rest.some((a) => !a.startsWith("--"));
      if (!hasPath) {
        const cfg = loadConfig();
        if (cfg.ingest.length === 0) {
          console.error("ingest: no path given and no roots configured");
          console.error("  add roots to the config file, or pass a path");
          console.error("  run `chamber config show` to find the config file");
          process.exitCode = 1;
          break;
        }
        let allOk = true;
        for (const entry of cfg.ingest) {
          if (!existsSync(entry.root)) {
            console.error(`  skipped ${entry.root}: does not exist`);
            allOk = false;
            continue;
          }
          if (
            !runOne(entry.root, {
              exclude: entry.exclude,
              includeDotted: false,
              requireExcludeMatch: true,
            })
          ) {
            allOk = false;
          }
        }
        if (!allOk) process.exitCode = 1;
        break;
      }

      const parsed = parseIngestArgs(rest);
      if (!parsed.ok) {
        console.error(`ingest: ${parsed.error}`);
        console.error(INGEST_USAGE);
        process.exitCode = 1;
        break;
      }
      if (
        !runOne(parsed.path, {
          exclude: parsed.exclude,
          includeDotted: parsed.includeDotted,
          requireExcludeMatch: !parsed.allowUnmatchedExclude,
        })
      ) {
        process.exitCode = 1;
      }
      break;
    }
```

Keep whatever skip-reporting the existing block printed after a successful run — move those lines inside `runOne`, after the `ingested …` line, so both paths report skips identically.

A missing root is reported and the run continues: one moved folder must not cost the whole scheduled ingest. The overall exit is non-zero so a scheduled run surfaces it.

- [ ] **Step 4: Run and watch them pass**

Run: `npm run test -- --suite=config`
Expected: all pass

Run: `npm run test`
Expected: 233/233 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/harness.ts
git commit -m "feat: ingest every configured root when no path is given

chamber ingest with no positional path now ingests each configured root
with its configured excludes, which is what makes scheduled re-ingest
possible and makes the deny-list a durable artifact instead of something
retyped correctly every run.

A root that no longer exists is reported and skipped rather than aborting
the run — one moved folder must not cost a whole scheduled ingest — but
the command still exits non-zero so the failure is visible in a log.

No configured roots and no path is an error, not a silent no-op.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `bin` entry and the engines floor

**Files:**
- Modify: `package.json`
- Test: manual verification (an `npm link` cannot run inside the test suite)

**Interfaces:**
- Consumes: nothing
- Produces: `chamber` as a command after `npm link`

- [ ] **Step 1: Confirm the shebang is already correct**

Run: `head -1 src/cli.ts`
Expected: `#!/usr/bin/env node`

If it is anything else, stop and report — the `bin` entry depends on it.

- [ ] **Step 2: Confirm this Node runs TypeScript natively**

```bash
printf 'const x: number = 1; console.log("native-ts-ok", x);\n' > /tmp/_ts_check.ts
node /tmp/_ts_check.ts; rm -f /tmp/_ts_check.ts
```
Expected: `native-ts-ok 1`

If this fails, stop and report: the `bin` entry would need `--experimental-strip-types`, which this plan deliberately refuses to put in a shipped shebang.

- [ ] **Step 3: Add the bin entry and raise the engines floor**

In `package.json`, add a `bin` field alongside `"scripts"`:

```json
  "bin": {
    "chamber": "src/cli.ts"
  },
```

and change the `engines` block:

```json
  "engines": {
    "node": ">=23.6"
  }
```

Node 23.6 is where type stripping became the default. Raising the floor is deliberate: a shipped shebang whose startup depends on an experimental flag is a scheduled outage. The cost — anyone on an older LTS cannot install Chamber — is recorded in the design doc.

- [ ] **Step 4: Verify the command works**

```bash
chmod +x src/cli.ts
npm link
chamber help
chamber config show
```
Expected: both exit 0. `chamber help` prints the command list; `chamber config show` prints settings with sources.

Report the output of `which chamber`.

- [ ] **Step 5: Verify the suite is unaffected**

Run: `npm run test`
Expected: 233/233 passed, 0 failed

- [ ] **Step 6: Commit**

```bash
git add package.json src/cli.ts
git commit -m "feat: ship chamber as a real command

A bin entry makes \`chamber\` available after npm link, instead of every
invocation being node --experimental-strip-types src/cli.ts.

The engines floor rises to Node 23.6, where type stripping is the default.
That locks out older LTS releases, which is a real cost for an MIT project
— but the alternative is a shipped shebang carrying an experimental flag,
which is an outage scheduled for whenever that flag is removed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Scheduled `verify` via launchd

**Files:**
- Create: `deploy/launchd/com.chamber.verify.plist`
- Create: `deploy/SCHEDULING.md`

**Interfaces:**
- Consumes: the `chamber` command from Task 5; `verify`'s exit-code contract (non-zero exactly when a belief has no verified support left)
- Produces: documented scheduling for macOS and Linux

- [ ] **Step 1: Write the plist**

Create `deploy/launchd/com.chamber.verify.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.chamber.verify</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>chamber ingest &amp;&amp; chamber verify</string>
  </array>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>8</integer>
    <key>Minute</key><integer>30</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>REPLACE_WITH_HOME/Library/Logs/chamber-verify.log</string>
  <key>StandardErrorPath</key>
  <string>REPLACE_WITH_HOME/Library/Logs/chamber-verify.log</string>

  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

`/bin/sh -lc` is deliberate: a login shell picks up the PATH that `npm link` wrote `chamber` into. launchd jobs otherwise run with a minimal PATH and would not find it.

The job re-ingests before verifying, so drift is detected against the current state of the notes rather than a stale corpus. Without that, `verify` would only ever confirm what the last manual ingest saw.

- [ ] **Step 2: Write the scheduling doc**

Create `deploy/SCHEDULING.md`:

```markdown
# Scheduling `chamber verify`

`chamber verify` re-checks every stored citation pin against the corpus as it
is now. It exits non-zero exactly when a belief has no verified support left,
which makes it usable as an unattended check.

It never mutates a belief or the corpus. It only reports.

## macOS (launchd)

1. Copy the plist and substitute your home directory:

   ```bash
   mkdir -p ~/Library/LaunchAgents
   sed "s|REPLACE_WITH_HOME|$HOME|g" \
     deploy/launchd/com.chamber.verify.plist \
     > ~/Library/LaunchAgents/com.chamber.verify.plist
   ```

2. Load it:

   ```bash
   launchctl load ~/Library/LaunchAgents/com.chamber.verify.plist
   ```

3. Watch it:

   ```bash
   tail -f ~/Library/Logs/chamber-verify.log
   ```

To run it once immediately rather than waiting for the schedule:

```bash
launchctl start com.chamber.verify
```

To remove it:

```bash
launchctl unload ~/Library/LaunchAgents/com.chamber.verify.plist
```

## Linux (cron)

```cron
30 8 * * * /bin/sh -lc 'chamber ingest && chamber verify' >> ~/.local/state/chamber-verify.log 2>&1
```

## What you will see

On a healthy corpus:

```
0 belief(s) checked, 0 with no verified support left
```

When a note behind a conclusion has changed:

```
blf_89d7be12  0/1 pins verified
  "Client records are kept for 90 days after the engagement ends."
  hash_mismatch: committed against retention.md#p0, which now holds: …
```

That is the signal worth scheduling for: a conclusion you recorded months ago,
resting on a note you have since edited, surfaced without you remembering it
existed.

## Expect a burst on the first run

The first scheduled run against an existing corpus may report drift on
everything at once, because a corpus ingested before the current pin formula
recomputes differently. That is correct, not a fault. Re-ingest once and the
baseline settles.
```

- [ ] **Step 3: Verify the plist parses**

Run: `plutil -lint deploy/launchd/com.chamber.verify.plist`
Expected: `OK`

- [ ] **Step 4: Verify the documented install works end to end**

```bash
mkdir -p ~/Library/LaunchAgents
sed "s|REPLACE_WITH_HOME|$HOME|g" deploy/launchd/com.chamber.verify.plist \
  > ~/Library/LaunchAgents/com.chamber.verify.plist
launchctl load ~/Library/LaunchAgents/com.chamber.verify.plist
launchctl start com.chamber.verify
sleep 20
cat ~/Library/Logs/chamber-verify.log
```

Expected: the log contains a `belief(s) checked` line. Report exactly what it contains.

Then leave it loaded — that is the deliverable.

- [ ] **Step 5: Commit**

```bash
git add deploy/launchd/com.chamber.verify.plist deploy/SCHEDULING.md
git commit -m "feat: schedule chamber verify with launchd

verify re-checks stored citation pins against the corpus and exits non-zero
exactly when a belief has lost all verified support, which is what makes it
usable unattended.

The job re-ingests first, so drift is measured against the notes as they
are now rather than against whatever the last manual ingest saw.

/bin/sh -lc is deliberate: launchd runs with a minimal PATH and would not
otherwise find the chamber that npm link installed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| `chamber init`, refuses overwrite without `--force`, prints path | 3 |
| `chamber ask` works with no `CHAMBER_*` set | 2 (db) + 5 (`bin`) |
| `chamber ingest` no-arg over configured roots, idempotent | 4 |
| Overlapping roots rejected at load, naming both | 1 |
| `chamber config show` prints source, flags disagreement | 3 |
| Leading `~` resolves to home | 1 |
| Scheduled `verify` from launchd with a log | 6 |
| Suite stays green; CLI smoke tests still pass | every task |
| No API key readable from config | 1 (test 10) |
| Malformed config is a hard error naming the file | 1 |
| Unknown top-level key rejected | 1 |
| Missing root reported and skipped, others continue | 4 |
| Model seam documented at the call site | 2 |
| `engines` floor raised deliberately | 5 |

**Deliberately not implemented:** the `--config` CLI flag mentioned in the spec's precedence chain. `CHAMBER_CONFIG` covers the same need, is what the tests use, and adding a flag to every command for a case nobody has hit is scope the evidence does not justify. The precedence chain in `src/config.ts` still reads flag-first so the layer exists when a flag is added.
