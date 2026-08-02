import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function isDiskError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; errstr?: string; message?: string };
  return (
    e.code === "ERR_SQLITE_ERROR" ||
    e.errstr === "disk I/O error" ||
    (typeof e.message === "string" && e.message.includes("disk I/O"))
  );
}

/** Open Chamber DB; on disk I/O failure fall back to /tmp then memory. */
export function openChamberDb(path = ":memory:"): DatabaseSync {
  const candidates =
    path === ":memory:"
      ? [":memory:"]
      : [path, "/tmp/chamber.sqlite", ":memory:"];

  let lastErr: unknown;
  for (const p of candidates) {
    try {
      const db = new DatabaseSync(p);
      applySchemas(db);
      return db;
    } catch (err) {
      lastErr = err;
      if (p === ":memory:" || !isDiskError(err)) throw err;
    }
  }
  throw lastErr;
}
