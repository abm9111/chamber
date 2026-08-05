import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { formatErrorChain } from "./error_chain.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCHEMA_FILES = [
  "schema.sql",
  "schema_spend_approvals.sql",
  "schema_approval_workflows.sql",
  "schema_audit.sql",
  "schema_merkle.sql",
  "schema_merkle_inc.sql",
  "schema_vector.sql",
  "schema_memory.sql",
  "schema_faculty.sql",
  "schema_scip.sql",
  "schema_hermes_parity.sql",
  "schema_mcp_oauth.sql",
  "schema_mcp_pin.sql",
  "schema_qm_port.sql",
] as const;

function applySchemas(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON;");
  try {
    db.exec("ALTER TABLE session ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'default'");
  } catch {
    /* column exists */
  }
  for (const file of SCHEMA_FILES) {
    const sql = readFileSync(join(__dirname, "../sql", file), "utf8");
    db.exec(sql);
  }
}

/** SQLite result codes. `errcode` carries these; `errstr` is their text. */
const SQLITE_READONLY = 8;
const SQLITE_CANTOPEN = 14;

/**
 * Whether `err` means *this location cannot hold the database*, as opposed to
 * *this database is broken* or *this repo's SQL is wrong*.
 *
 * The predicate this replaces accepted `code === "ERR_SQLITE_ERROR"`, which is
 * the code node:sqlite puts on **every** error it throws — so it also matched
 * the ones `applySchemas` raises for a corrupt file (SQLITE_NOTADB, "file is
 * not a database") or a broken `sql/*.sql`. Neither is a storage failure, and
 * treating them as one turned a corrupt audit database, or a typo in a schema
 * file, into a silent relocation of the operator's data to `/tmp` — a bug
 * laundered into a fallback. Those cases now throw.
 *
 * What still qualifies:
 *
 *  - `SQLITE_CANTOPEN` — the file could not be opened at all. node:sqlite
 *    reports a missing directory, an unwritable directory and a path that is
 *    itself a directory with this one code and the identical message ("unable
 *    to open database file"), so the error cannot tell them apart; the missing
 *    directory is instead removed as a *cause* by `mkdirSync` below, before
 *    the open is attempted.
 *  - `SQLITE_READONLY` — the file exists but cannot be written.
 *  - A genuine "disk I/O error", the original intent of this predicate.
 *  - A libuv filesystem error (`errno` + `syscall`) from creating the parent
 *    directory: EACCES, ENOTDIR, EROFS. Failing to *make* the directory is the
 *    same class of problem as failing to open inside it, and is treated the
 *    same way — fall back, loudly.
 *
 * Every one of these still lands in a different database than the caller
 * asked for, so every one of them is announced by `warnRedirect`.
 */
function isLocationUnusable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    errcode?: number;
    errno?: number;
    errstr?: string;
    syscall?: string;
    message?: string;
  };
  if (e.code === "ERR_SQLITE_ERROR") {
    return (
      e.errcode === SQLITE_CANTOPEN ||
      e.errcode === SQLITE_READONLY ||
      // Fall back to the text for a node:sqlite build that omits `errcode`.
      e.errstr === "unable to open database file" ||
      e.errstr === "disk I/O error" ||
      (typeof e.message === "string" && e.message.includes("disk I/O"))
    );
  }
  // A libuv fs error from mkdirSync — errno + syscall together identify one
  // without matching an arbitrary object that happens to carry a `code`.
  return typeof e.errno === "number" && typeof e.syscall === "string";
}

/**
 * Say, on stderr, that data is going somewhere other than where it was asked
 * to go — naming both paths.
 *
 * Chamber reports its database path in the CLI banner and in `config show`.
 * A fallback that does not announce itself makes those reports lie: the
 * operator is told `~/.local/share/chamber/chamber.sqlite` while every row
 * lands in `/tmp`, survives exactly until the next reboot, and nothing
 * anywhere says so. `docs/NEXT_LEVEL_PLAN.md` Phase 1.4 puts it plainly — an
 * audit database that silently becomes amnesiac is worse than one that fails
 * to open. The fallback stays (callers and tests depend on the `:memory:`
 * leg); the silence does not.
 *
 * stderr, not stdout, so this cannot be swallowed by a caller piping output,
 * and cannot corrupt machine-readable stdout.
 */
function warnRedirect(requested: string, actual: string, cause: unknown): void {
  const why = formatErrorChain(cause).join("; ");
  process.stderr.write(
    `chamber: WARNING — could not open the database at ${requested}: ${why}\n` +
      `chamber: WARNING — storing data at ${actual} instead. ` +
      `Data written now will NOT be in ${requested}.\n`,
  );
}

/**
 * Open Chamber's database.
 *
 * The parent directory is created here, at the point of open, rather than
 * where the path is resolved: `src/config.ts` is deliberately pure — it reads
 * settings and touches nothing — and every caller that resolves a path
 * (`src/cli.ts`, `src/server.ts`, the gateway runners, the probes) funnels
 * through this one function, so this is the only place the directory can be
 * guaranteed to exist for all of them. `~/.local/share/chamber/` does not
 * exist on a fresh machine; without this, the open below failed, the fallback
 * chain read that failure as a disk error, and Chamber silently stored
 * everything in `/tmp/chamber.sqlite` while reporting the durable path.
 *
 * On failure it still falls back to `/tmp` then `:memory:` — but never
 * silently; see `warnRedirect`.
 *
 * `onRedirect` is called with the path actually opened whenever that is not
 * the path asked for, immediately after the warning. stderr told the truth
 * already; this is how a caller that *prints* a database path can tell it too.
 * `src/cli.ts` uses it to repoint the path its banner reports, which otherwise
 * kept naming the durable location while every row went to `/tmp` — so
 * `chamber status 2>/dev/null` read as a confident success. A callback rather
 * than a changed return type on purpose: ten call sites open this database and
 * exactly one of them prints a path.
 */
/**
 * Put a file-backed database into WAL mode, and say so if it will not go.
 *
 * The default journal mode is `delete`, under which a reader and a writer
 * exclude each other outright. Measured on this repository: a second process
 * opening the database during `chamber ingest` failed the *ingest* with
 * `database is locked` and lost ~40 minutes of embedding work. The scheduled
 * job at 08:30 runs `ingest` then `verify` unattended, so the window where a
 * casual `chamber ask` or `chamber status` can kill the run is minutes long
 * and nobody is watching when it happens.
 *
 * WAL lets readers proceed against the last committed snapshot while a writer
 * appends, which is the access pattern Chamber actually has: one long writer
 * and several short readers.
 *
 * Not fatal when it fails. WAL needs shared memory and cannot be used on some
 * network filesystems, and a vault on a synced volume is exactly where that
 * turns up. Falling back to the old mode is strictly no worse than before, so
 * this warns rather than refusing to open — but it does warn, because a
 * silent fallback would leave the operator believing in a concurrency
 * guarantee they do not have.
 *
 * `:memory:` is skipped: there is no file, and journal mode is meaningless.
 */
function enableWal(db: DatabaseSync, path: string): void {
  if (path === ":memory:") return;
  // Wait for a lock instead of failing on contact.
  //
  // WAL alone is not enough, and the reason is specific to this codebase:
  // `openChamberDb` runs `applySchemas` on *every* open, which is DDL and takes
  // a write lock. So even `chamber ask`, which only reads afterwards, contends
  // at open — and WAL's concurrency guarantee covers readers against a writer,
  // never writer against writer.
  //
  // SQLite's default busy timeout is 0: the second connection gets
  // SQLITE_BUSY immediately rather than waiting the moment it could have. Five
  // seconds is far longer than schema application needs and far shorter than a
  // person will sit staring at a prompt, so a command issued during an ingest
  // now waits its turn instead of failing the ingest.
  //
  // Set before the WAL pragma because that pragma itself needs the lock.
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch {
    /* an unsupported pragma is not worth failing an open over */
  }
  try {
    // The pragma *returns* the mode it settled on; it does not throw when it
    // declines. Reading the result is the only way to know it took.
    const row = db.prepare("PRAGMA journal_mode = WAL").get() as
      | { journal_mode?: string }
      | undefined;
    const mode = String(row?.journal_mode ?? "").toLowerCase();
    if (mode !== "wal") {
      console.warn(
        `chamber: could not enable WAL on ${path} (mode is "${mode}"). ` +
          `Readers and writers will block each other, so a command run during ` +
          `an ingest can fail it. Common on network or synced filesystems.`,
      );
    }
  } catch (err) {
    console.warn(
      `chamber: could not enable WAL on ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function openChamberDb(
  path = ":memory:",
  onRedirect?: (actual: string) => void,
): DatabaseSync {
  // A blank path is the one input that loses everything without saying so.
  //
  // `new DatabaseSync("")` does not fail. SQLite reads an empty filename as a
  // request for a *private temporary database*: it opens, `applySchemas`
  // applies, INSERTs succeed, and the entire thing is discarded when the
  // process exits. Measured, not assumed — an open, an INSERT and a SELECT
  // all succeed against `""`. And because the empty string is also the path
  // that was *asked for*, the `p !== path` test below is false, so neither
  // `warnRedirect` nor `onRedirect` fires. Total data loss, announced nowhere.
  //
  // The `/tmp` and `:memory:` legs below exist for a location that turned out
  // unusable at runtime — an environment failure the operator did not cause
  // and should not lose a command to. A blank path is not that. It is a
  // caller or configuration bug, there is no location to fall back *from*,
  // and so it throws instead. Three reasons, in order of weight:
  //
  //  - Falling back to `:memory:` with a warning would reproduce the exact
  //    failure this guard exists to stop. The process would still exit 0
  //    having stored nothing, and under the scheduled job a warning in a log
  //    nobody reads is indistinguishable from silence. A throw is the one
  //    signal a scheduler can act on.
  //  - No caller can mean it. In-memory is spelled `:memory:` and every real
  //    path is non-empty, so there is no blank-path behaviour to preserve and
  //    nothing that legitimately passes `""` to break.
  //  - The class is closed today only by convention. Every daemon and the CLI
  //    reach this function through `envSetting`'s blank-is-unset trim in
  //    src/config.ts — but ten call sites open this database, and an eleventh
  //    added tomorrow inherits none of that discipline. The rule belongs at
  //    the open, once, not at each place a path is resolved.
  //
  // Whitespace-only is refused on the same terms and for a second reason:
  // SQLite reads `"  "` as an ordinary relative filename and quietly creates
  // a file literally called `"  "` in the working directory. The value is
  // only *tested* trimmed, never used trimmed — a real path may legally carry
  // a trailing space, and silently rewriting it would be a different quiet
  // bug in place of this one.
  if (path.trim() === "") {
    throw new Error(
      `openChamberDb: refusing to open a blank database path (${JSON.stringify(path)}). ` +
        `SQLite accepts this and opens a private temporary database whose every row ` +
        `is discarded when the process exits — it does not fail, so nothing downstream ` +
        `would report the loss. Pass a filesystem path, or ":memory:" if a throwaway ` +
        `database is what you meant.`,
    );
  }

  const candidates =
    path === ":memory:"
      ? [":memory:"]
      : [path, "/tmp/chamber.sqlite", ":memory:"];

  let lastErr: unknown;
  for (const p of candidates) {
    try {
      // Not for `:memory:` — it names no file, and `dirname(":memory:")` is
      // the process's working directory, which has no business being touched.
      if (p !== ":memory:") mkdirSync(dirname(p), { recursive: true });
      const db = new DatabaseSync(p);
      enableWal(db, p);
      applySchemas(db);
      if (p !== path) {
        warnRedirect(path, p, lastErr);
        onRedirect?.(p);
      }
      return db;
    } catch (err) {
      lastErr = err;
      if (p === ":memory:" || !isLocationUnusable(err)) throw err;
    }
  }
  throw lastErr;
}

/**
 * Open the database Chamber's *settings* name — environment, then config file,
 * then the durable default — rather than one the caller chose for itself.
 *
 * Every entry point that is not a test or a probe belongs here. Four of them
 * did not: src/server.ts, src/gateway_runner.ts, src/slack_ops.ts and
 * src/discord_ops.ts each read `process.env.CHAMBER_DB ?? "/tmp/chamber.sqlite"`
 * and none imported loadConfig. So `chamber ask` and the HTTP server held two
 * unrelated corpora, and the daemons' one — the audit chain included — was
 * gone after a reboot. Durability was a property of the CLI, not of Chamber.
 *
 * The `??` was the second half of it: it falls through on nullish only, so
 * `export CHAMBER_DB="$UNSET"` resolved to "", beat both the config file and
 * the default, and opened a private temporary SQLite database that discards
 * every row at exit. `envSetting` in src/config.ts has treated blank as unset
 * since the CLI hit this; routing through it is what extends that rule here.
 *
 * `onRedirect` is passed straight through, because a daemon that *prints* its
 * database path has the same obligation the CLI banner does — see
 * `openChamberDb` above and `listenServer` in src/server.ts.
 *
 * A function, not a module-level constant: config is read at the moment of
 * opening, so a caller that opens twice in one process sees the settings as
 * they are, and importing this module still costs no filesystem access.
 */
export function openConfiguredDb(
  onRedirect?: (actual: string) => void,
): DatabaseSync {
  return openChamberDb(loadConfig().database, onRedirect);
}
