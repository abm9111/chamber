/**
 * Durable job queue (QM-inspired). Handlers call gated Chamber functions only.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./hash.ts";
import { appendAudit } from "./audit.ts";
import { runExpiryJob } from "./expiry.ts";
import { runDueCronJobs } from "./cron.ts";
import { runDreamCycle } from "./memory.ts";

export type JobKind = "expiry" | "cron" | "dream" | "oauth_refresh" | "custom";

export function enqueueJob(
  db: DatabaseSync,
  kind: JobKind,
  payload: Record<string, unknown> = {},
  opts: { runAfter?: string; maxAttempts?: number } = {},
): string {
  const id = newId("job");
  db.prepare(
    `INSERT INTO job_queue (id, kind, payload_json, run_after, max_attempts)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    kind,
    JSON.stringify(payload),
    opts.runAfter ?? new Date().toISOString(),
    opts.maxAttempts ?? 3,
  );
  return id;
}

export function claimNextJob(
  db: DatabaseSync,
  workerId: string,
): { id: string; kind: JobKind; payload: Record<string, unknown>; attempts: number } | null {
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `SELECT id, kind, payload_json AS payloadJson, attempts, max_attempts AS maxAttempts
       FROM job_queue
       WHERE status = 'pending' AND run_after <= ?
       ORDER BY run_after ASC
       LIMIT 1`,
    )
    .get(now) as
    | {
        id: string;
        kind: JobKind;
        payloadJson: string;
        attempts: number;
        maxAttempts: number;
      }
    | undefined;
  if (!row) return null;

  const r = db
    .prepare(
      `UPDATE job_queue
       SET status = 'running', locked_by = ?, locked_at = ?, attempts = attempts + 1
       WHERE id = ? AND status = 'pending'`,
    )
    .run(workerId, now, row.id);
  if (Number(r.changes ?? 0) === 0) return null;

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return { id: row.id, kind: row.kind, payload, attempts: row.attempts + 1 };
}

function finishJob(
  db: DatabaseSync,
  id: string,
  status: "done" | "failed",
  lastError?: string,
): void {
  db.prepare(
    `UPDATE job_queue
     SET status = ?, last_error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         locked_by = NULL
     WHERE id = ?`,
  ).run(status, lastError ?? null, id);
}

function requeueOrFail(
  db: DatabaseSync,
  id: string,
  attempts: number,
  maxAttempts: number,
  error: string,
): void {
  if (attempts >= maxAttempts) {
    finishJob(db, id, "failed", error.slice(0, 500));
    return;
  }
  const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 5));
  const runAfter = new Date(Date.now() + delayMs).toISOString();
  db.prepare(
    `UPDATE job_queue
     SET status = 'pending', run_after = ?, last_error = ?, locked_by = NULL, locked_at = NULL
     WHERE id = ?`,
  ).run(runAfter, error.slice(0, 500), id);
}

function runJobHandler(
  db: DatabaseSync,
  kind: JobKind,
  payload: Record<string, unknown>,
): string {
  switch (kind) {
    case "expiry": {
      const r = runExpiryJob(db);
      return `expired=${r.expired} tickets=${r.tickets}`;
    }
    case "cron": {
      const r = runDueCronJobs(db, (p) => `cron-handled: ${String(p).slice(0, 80)}`);
      return `ran=${r.ran}`;
    }
    case "dream": {
      const r = runDreamCycle(db);
      return `proposals=${r.proposals.length}`;
    }
    case "oauth_refresh": {
      // Payload may include resource; actual refresh is best-effort import
      return `oauth_refresh skipped_inline resource=${payload.resource ?? "—"}`;
    }
    case "custom":
      return `custom ok keys=${Object.keys(payload).join(",")}`;
    default:
      return `unknown kind`;
  }
}

/**
 * Process up to `limit` due jobs. Returns counts.
 */
export function processJobQueue(
  db: DatabaseSync,
  opts: { limit?: number; workerId?: string } = {},
): { processed: number; done: number; failed: number } {
  const workerId = opts.workerId ?? `w_${process.pid}`;
  const limit = opts.limit ?? 10;
  let processed = 0;
  let done = 0;
  let failed = 0;

  for (let i = 0; i < limit; i++) {
    const job = claimNextJob(db, workerId);
    if (!job) break;
    processed++;
    try {
      const result = runJobHandler(db, job.kind, job.payload);
      finishJob(db, job.id, "done");
      done++;
      appendAudit(db, {
        category: "system",
        action: "job_done",
        actor: "system",
        subjectId: job.id,
        detail: { kind: job.kind, result: result.slice(0, 120) },
      });
    } catch (e) {
      const msg = String(e).slice(0, 300);
      const maxRow = db
        .prepare(`SELECT max_attempts AS m FROM job_queue WHERE id = ?`)
        .get(job.id) as { m: number };
      requeueOrFail(db, job.id, job.attempts, maxRow?.m ?? 3, msg);
      if (job.attempts >= (maxRow?.m ?? 3)) failed++;
      appendAudit(db, {
        category: "system",
        action: "job_fail",
        actor: "system",
        subjectId: job.id,
        detail: { kind: job.kind, error: msg.slice(0, 120) },
      });
    }
  }
  return { processed, done, failed };
}

export function listJobs(db: DatabaseSync, limit = 20) {
  return db
    .prepare(
      `SELECT id, kind, status, attempts, run_after AS runAfter, last_error AS lastError
       FROM job_queue ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as {
    id: string;
    kind: string;
    status: string;
    attempts: number;
    runAfter: string;
    lastError: string | null;
  }[];
}
