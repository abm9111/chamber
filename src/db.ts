import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 */
export function openChamberDb(path = ":memory:"): DatabaseSync {
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
      applySchemas(db);
      if (p !== path) warnRedirect(path, p, lastErr);
      return db;
    } catch (err) {
      lastErr = err;
      if (p === ":memory:" || !isLocationUnusable(err)) throw err;
    }
  }
  throw lastErr;
}
