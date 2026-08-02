/**
 * Hermes-style scheduled jobs — runs prompts through Chamber turn path.
 * Execution is local; delivery channel recorded for spend/audit.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./hash.ts";
import { appendAudit } from "./audit.ts";
import { recordSpend } from "./spend.ts";

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
}

/** Parse simple schedules: interval:Nh / interval:Nm / cron-like "0 * * * *" (hour-ish). */
export function computeNextRun(schedule: string, from = new Date()): Date {
  const m = schedule.match(/^interval:(\d+)([mhd])$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    const ms =
      unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return new Date(from.getTime() + ms);
  }
  // Default hourly
  return new Date(from.getTime() + 3_600_000);
}

export function addCronJob(
  db: DatabaseSync,
  input: { name: string; schedule: string; prompt: string },
): string {
  const id = newId("cron");
  const next = computeNextRun(input.schedule).toISOString();
  db.prepare(
    `INSERT INTO cron_job (id, name, schedule, prompt, next_run_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.schedule, input.prompt, next);
  appendAudit(db, {
    category: "system",
    action: "cron_add",
    actor: "human",
    subjectId: id,
    detail: { name: input.name, schedule: input.schedule },
  });
  return id;
}

export function listCronJobs(db: DatabaseSync): CronJob[] {
  return db
    .prepare(
      `SELECT id, name, schedule, prompt, enabled,
              last_run_at AS lastRunAt, next_run_at AS nextRunAt, last_status AS lastStatus
       FROM cron_job ORDER BY name`,
    )
    .all() as CronJob[];
}

export function setCronEnabled(db: DatabaseSync, id: string, enabled: boolean): void {
  db.prepare(`UPDATE cron_job SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

/**
 * Run due jobs. handler receives prompt; returns status string.
 * Spend recorded on channel cron.
 */
export function runDueCronJobs(
  db: DatabaseSync,
  handler: (prompt: string, job: CronJob) => string,
  now = new Date(),
): { ran: number; results: { id: string; status: string }[] } {
  const iso = now.toISOString();
  const due = db
    .prepare(
      `SELECT id, name, schedule, prompt, enabled,
              last_run_at AS lastRunAt, next_run_at AS nextRunAt, last_status AS lastStatus
       FROM cron_job
       WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)`,
    )
    .all(iso) as CronJob[];

  const results: { id: string; status: string }[] = [];
  for (const job of due) {
    let status: string;
    try {
      status = handler(job.prompt, job);
    } catch (e) {
      status = `error: ${String(e).slice(0, 120)}`;
    }
    const next = computeNextRun(job.schedule, now).toISOString();
    db.prepare(
      `UPDATE cron_job
       SET last_run_at = ?, next_run_at = ?, last_status = ?
       WHERE id = ?`,
    ).run(iso, next, status.slice(0, 200), job.id);
    recordSpend(db, {
      channel: "cron",
      model: "cron-runner",
      modelFamily: "local",
      inputTokens: Math.ceil(job.prompt.length / 4),
      outputTokens: Math.ceil(status.length / 4),
      costUsd: 0,
      detail: { jobId: job.id, name: job.name },
    });
    appendAudit(db, {
      category: "system",
      action: "cron_run",
      actor: "system",
      subjectId: job.id,
      detail: { status: status.slice(0, 100) },
    });
    results.push({ id: job.id, status });
  }
  return { ran: results.length, results };
}
