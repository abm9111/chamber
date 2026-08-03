# Chamber as a durable daily driver — design

**Date:** 2026-08-03
**Status:** approved, ready for planning
**Scope:** one implementation plan, roughly a day

## Why this, and why now

Chamber can do one thing no competitor was found to do. A belief committed today stores a content pin; when the note it rests on is later edited, `chamber verify` reports that the conclusion has lost its evidence. Verified end to end on 2026-08-03 with a local 122B: a claim committed `[ALLOWED]` against `retention.md#p0`, the note edited, and `verify` reporting `hash_mismatch` and exiting non-zero — naming the belief, the note, and what now occupies that position.

Six research passes and an adversarial audit found no prior art. Hermes cannot do it; neither can gbrain, Hindsight, Mnemosyne, or `microsoft/agent-governance-toolkit`. Not because it is hard, but because nobody stores content pins alongside claims.

**That capability currently cannot survive a reboot.** The corpus lives in a temp directory. Every invocation needs five environment variables typed correctly. Nothing runs unless invoked by hand. A capability nobody can run does not matter, so this spec is not setup work preceding the real work — it is the work that makes the differentiator reachable.

The goal it serves is specific: **catch one real stale conclusion in the owner's actual vault** — one that would otherwise have kept being trusted. That event is the proof and the story.

## Success criteria

Each is a runnable check.

1. `chamber init` writes a config to `$XDG_CONFIG_HOME/chamber/config.json` (or `~/.config/chamber/config.json`), refuses to overwrite without `--force`, and prints the path.
2. After `npm link`, `chamber ask "…"` works from any directory with **no `CHAMBER_*` variables set**, using the configured database and model.
3. `chamber ingest` with no arguments ingests every configured root with its configured excludes, and re-running it is a no-op (row count and hashes stable).
4. A config listing two overlapping roots is **rejected at load time** with a message naming both, and no command runs.
5. `chamber config show` prints every setting with its source, and when an environment variable and the config file disagree it prints both and which won.
6. A config path containing a leading `~` resolves to the home directory — not to a directory literally named `~`.
7. `chamber verify` runs unattended from launchd on a schedule, writes to a log, and its non-zero exit on drift is visible in that log.
8. `npm run test` stays green, and the CLI smoke tests still pass.

Criterion 7 is the one that matters; 1–6 exist to make it reachable.

## Architecture

Four pieces, one new module.

```
src/config.ts        resolve settings from flags, env, file, defaults — pure, no side effects
package.json bin     `chamber` becomes a real command after npm link
chamber init         write a starter config
chamber config show  print every setting with its source
deploy/launchd/      plist running `chamber verify`, plus a documented crontab line
```

### Config shape and location

```json
{
  "database": "~/.local/share/chamber/chamber.sqlite",
  "model": { "base": "http://127.0.0.1:8087/v1", "name": "…" },
  "ingest": [{ "root": "~/Vault/10 - Infrastructure", "exclude": ["private"] }]
}
```

Located at `$XDG_CONFIG_HOME/chamber/config.json`, falling back to `~/.config/chamber/config.json`, overridable by `CHAMBER_CONFIG` so tests never touch a real one.

**Strict JSON — no comment dialect.** `JSON.parse` rejects comments; discoverability comes from `chamber config show`, not from annotations in the file.

**There is no field for an API key.** The loader reads `CHAMBER_API_KEY` from the environment and nowhere else, so a key cannot reach a file by accident.

**A leading `~` is expanded by the loader**, explicitly and with a test. Nothing else expands it — shells do, and a config file never passes through one.

### Precedence, and making overrides loud

**CLI flag → environment variable → config file → built-in default.** Every existing `CHAMBER_*` variable keeps working unchanged; the file only fills gaps.

`CHAMBER_DB` is routinely exported by wrappers, plists and shells. With env outranking config, a stale export silently redirects Chamber to a different corpus, and `ask` answers from the wrong evidence while appearing healthy. For a tool whose value is knowing which evidence backed a claim, that is the worst available failure.

So precedence stays conventional and **disagreement becomes loud**: when an environment variable and the config file both specify a value *and the values differ*, Chamber prints which won. Only on genuine disagreement, so normal use stays quiet.

### Overlapping ingest roots are a config error

`chamber ingest` with no arguments ingests every configured root — that is what makes scheduled re-ingest possible.

But overlapping roots reactivate a documented hazard: two roots covering the same file duplicate it silently, and shrinking through one leaves the other's rows answering from deleted content. Roots are resolved with `realpath` and **rejected at load time if any is a prefix of another**, naming both. A config error caught once is far cheaper than the corpus it would otherwise produce.

### The model seam, named rather than hidden

`complete()` in `src/model.ts` reads `CHAMBER_API_BASE` and `CHAMBER_API_MODEL` from the environment directly. Threading config through would change its signature and every call site.

Instead `main()` writes config values into `process.env` **only where the variable is unset**, which is precedence-preserving by construction. Zero change to `model.ts` or its callers.

This is a compromise, not an architecture: config-as-environment-mutation is a seam. It is the right size today, and the place to close it is when the agent loop lands and `complete()` needs explicit options anyway.

## Components

### `src/config.ts` (new)

```ts
interface ChamberConfig {
  database: string;                               // absolute, ~ expanded
  model: { base?: string; name?: string };
  ingest: { root: string; exclude: string[] }[];  // realpath'd, non-overlapping
}
interface Resolved {
  key: string; value: string;
  source: "flag" | "env" | "config" | "default";
  conflict?: string;                              // the losing value, when they differ
}

loadConfig(opts?: { path?: string }): ChamberConfig   // throws on malformed / overlapping
explainConfig(cfg: ChamberConfig): Resolved[]
```

Pure apart from reading one file. No database, no network, no model. Depends on `node:fs`, `node:path`, `node:os`.

### `src/cli.ts` (modified)

`main()` calls `loadConfig()` once, before `open()`. The resolved `database` replaces today's `CHAMBER_DB ?? "/tmp/chamber.sqlite"`. `ingest` with no positional argument iterates the configured roots, passing each root and its excludes to the existing `ingestDirectory`, which is unchanged — it already takes exactly that pair.

Two new commands: `init` and `config show`.

### `package.json` (modified)

A `bin` entry mapping `chamber` to `src/cli.ts`, which already carries a `#!/usr/bin/env node` shebang.

**The `engines` floor must rise.** Node 22 cannot run TypeScript without `--experimental-strip-types`; the development machine runs Node 26, where type stripping is native. Raising the floor is deliberate: a shipped shebang whose startup depends on an experimental flag is a scheduled outage. The cost is real — anyone on an older LTS cannot install Chamber — and is recorded here as a decision, not a footnote.

### `deploy/launchd/` (new)

A `.plist` running `chamber verify` on a schedule with stdout and stderr to a log path, plus a documented `crontab` line for Linux. Both rely on the exit-code contract confirmed on 2026-08-03: non-zero exactly when a belief has no verified support left.

## Error handling

**A missing config file is not an error.** Env-only operation must keep working, so absence falls through to defaults.

**A malformed config is a hard error** naming the file and the parse failure. Never partial: a config half-applied is worse than none, because the operator believes settings took effect that did not.

**Overlapping roots** are rejected before any command runs, naming both roots.

**A configured root that does not exist** is reported per-root and skipped; other roots still ingest. One missing folder must not cost the whole scheduled run.

**An unknown top-level config key is rejected**, not ignored. A typo'd `"excludes"` where `"exclude"` was meant would silently ingest a deny-listed folder — the exact disaster the exclude hardening exists to prevent.

**`chamber init` refuses to overwrite** an existing config without `--force`.

## Testing

Added to `tests/harness.ts`, all synchronous, all against a temp `CHAMBER_CONFIG` — never a real config.

1. `~` in a path resolves to the home directory.
2. Precedence: flag beats env beats config beats default, asserted per layer.
3. A differing env value and config value produces a `conflict` in `explainConfig`; identical values produce none.
4. Overlapping roots throw at load, and the message names both.
5. An unknown top-level key throws.
6. A malformed JSON config throws and names the file.
7. A missing config file yields defaults without throwing.
8. No config field can supply an API key — asserted by construction on the parsed shape.
9. `chamber init` writes valid JSON that `loadConfig` accepts, and refuses to overwrite without `--force`.
10. A subprocess smoke test: `chamber config show` exits 0 against a temp config.

The existing CLI subprocess smoke tests must keep passing — they are what catches a `SyntaxError` behind a green suite, which has happened twice.

## Non-goals

- Extending `src/cron.ts` to run commands. launchd calls `chamber verify` directly; Chamber's own cron stays prompt-shaped and untouched.
- Config in the database. The `chamber_config` table exists, but the database path cannot be read from the database.
- Scheduling declared in config. launchd already has a declaration format; duplicating it grows the schema past what evidence justifies.
- A `chamber debt waive` escape hatch. Six real questions on 2026-08-03 minted zero debt, so the accretion worry has not materialised.
- Any change to retrieval, pin verification, or the gate.

## Open risks

- **Raising the `engines` floor narrows who can install Chamber.** Accepted deliberately; revisit if a user reports it.
- **Config changes leave no audit trail**, in a project whose thesis is auditability. Accepted because the config holds locations, not gates — but it is the seam where database-backed settings would eventually return.
- **The first scheduled `verify` on a real vault may produce a large batch of drift at once**, since the corpus predates the current pin formula. Expected and correct, but it will land all at once and should not be mistaken for a fault.
