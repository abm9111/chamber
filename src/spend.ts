/**
 * Spend meter — Hermes field P0: background token tax must be visible.
 * Costs stored as USD micros (integer) to avoid float money.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./hash.ts";

export type SpendChannel =
  | "chat"
  | "memory_fork"
  | "dream"
  | "cron"
  | "subagent"
  | "critic"
  | "faculty"
  | "other";

export interface RecordSpendInput {
  channel: SpendChannel;
  model?: string;
  modelFamily?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** USD as float for convenience; stored as micros */
  costUsd?: number;
  costUsdMicros?: number;
  turnId?: string;
  sessionId?: string;
  profileId?: string;
  detail?: Record<string, unknown>;
}

export interface ChannelBreakdown {
  channel: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  costUsd: number;
}

export interface SpendWindowReport {
  windowHours: number;
  since: string;
  totalCostUsdMicros: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byChannel: ChannelBreakdown[];
  alert: null | { thresholdUsdMicros: number; message: string };
}

function toMicros(input: RecordSpendInput): number {
  if (typeof input.costUsdMicros === "number") {
    return Math.max(0, Math.floor(input.costUsdMicros));
  }
  if (typeof input.costUsd === "number") {
    return Math.max(0, Math.round(input.costUsd * 1_000_000));
  }
  return 0;
}

export function recordSpend(db: DatabaseSync, input: RecordSpendInput): string {
  const id = newId("sp");
  db.prepare(
    `INSERT INTO spend_event (
       id, channel, model, model_family, input_tokens, output_tokens,
       cost_usd_micros, turn_id, session_id, profile_id, detail_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.channel,
    input.model ?? null,
    input.modelFamily ?? null,
    input.inputTokens ?? 0,
    input.outputTokens ?? 0,
    toMicros(input),
    input.turnId ?? null,
    input.sessionId ?? null,
    input.profileId ?? null,
    input.detail ? JSON.stringify(input.detail) : null,
  );
  return id;
}

/** Last-N-hours breakdown by channel — the meter Hermes users wished was default. */
export function spendLastHours(
  db: DatabaseSync,
  hours = 24,
): SpendWindowReport {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  const rows = db
    .prepare(
      `SELECT channel,
              COUNT(*) AS events,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cost_usd_micros), 0) AS cost_usd_micros
       FROM spend_event
       WHERE created_at >= ?
       GROUP BY channel
       ORDER BY cost_usd_micros DESC`,
    )
    .all(since) as {
    channel: string;
    events: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd_micros: number;
  }[];

  const byChannel: ChannelBreakdown[] = rows.map((r) => ({
    channel: r.channel,
    events: r.events,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsdMicros: r.cost_usd_micros,
    costUsd: r.cost_usd_micros / 1_000_000,
  }));

  const totalCostUsdMicros = byChannel.reduce((s, c) => s + c.costUsdMicros, 0);
  const totalInputTokens = byChannel.reduce((s, c) => s + c.inputTokens, 0);
  const totalOutputTokens = byChannel.reduce((s, c) => s + c.outputTokens, 0);

  const thresholdRow = db
    .prepare(
      `SELECT value FROM approval_policy WHERE key = 'spend_alert_usd_micros_24h'`,
    )
    .get() as { value: string } | undefined;
  const threshold = thresholdRow ? parseInt(thresholdRow.value, 10) : 5_000_000;

  let alert: SpendWindowReport["alert"] = null;
  if (hours >= 24 && totalCostUsdMicros >= threshold) {
    alert = {
      thresholdUsdMicros: threshold,
      message: `24h spend $${(totalCostUsdMicros / 1_000_000).toFixed(2)} ≥ alert threshold $${(threshold / 1_000_000).toFixed(2)}`,
    };
  }

  return {
    windowHours: hours,
    since,
    totalCostUsdMicros,
    totalCostUsd: totalCostUsdMicros / 1_000_000,
    totalInputTokens,
    totalOutputTokens,
    byChannel,
    alert,
  };
}

/** One-line summary for turn UI / Telegram footer. */
export function formatSpendFooter(report: SpendWindowReport): string {
  const parts = report.byChannel
    .filter((c) => c.costUsdMicros > 0 || c.inputTokens > 0)
    .map(
      (c) =>
        `${c.channel}:${c.inputTokens + c.outputTokens}tok/$${c.costUsd.toFixed(3)}`,
    );
  const head = `24h $${report.totalCostUsd.toFixed(3)}`;
  return parts.length ? `${head} [${parts.join(" · ")}]` : head;
}


/** Fail-closed spend cap for a turn. CHAMBER_SPEND_CAP_USD (24h window). */
export function assertSpendBudget(
  db: DatabaseSync,
  opts: { hours?: number } = {},
): { ok: true; report: SpendWindowReport } | { ok: false; reason: string; report: SpendWindowReport } {
  const report = spendLastHours(db, opts.hours ?? 24);
  const capRaw = process.env.CHAMBER_SPEND_CAP_USD;
  if (capRaw == null || capRaw === "") {
    return { ok: true, report };
  }
  const cap = Number(capRaw);
  if (!Number.isFinite(cap) || cap < 0) {
    return { ok: true, report };
  }
  if (report.totalCostUsd >= cap) {
    return {
      ok: false,
      reason: `24h spend $${report.totalCostUsd.toFixed(3)} ≥ cap $${cap.toFixed(3)} (CHAMBER_SPEND_CAP_USD)`,
      report,
    };
  }
  return { ok: true, report };
}
