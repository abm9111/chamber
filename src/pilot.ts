/**
 * Pilot friction logging — lightweight, optional.
 * CHAMBER_PILOT=1 enables; writes pilot_event rows + optional JSONL file.
 */

import { appendFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "./hash.ts";

export interface PilotEventInput {
  action: string;
  outcome: "ok" | "blocked" | "conflict" | "error";
  blockCode?: string;
  waitMs?: number;
  approvalsN?: number;
  felt?: number; // 1–5
  note?: string;
  actor?: string;
}

export function pilotEnabled(): boolean {
  return process.env.CHAMBER_PILOT === "1";
}

export function ensurePilotSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pilot_event (
      id          TEXT PRIMARY KEY,
      ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      action      TEXT NOT NULL,
      outcome     TEXT NOT NULL,
      block_code  TEXT,
      wait_ms     INTEGER,
      approvals_n INTEGER,
      felt        INTEGER,
      note        TEXT,
      actor       TEXT
    );
  `);
}

export function logPilotEvent(db: DatabaseSync, input: PilotEventInput): void {
  if (!pilotEnabled()) return;
  try {
    ensurePilotSchema(db);
    const id = newId("pil");
    db.prepare(
      `INSERT INTO pilot_event (
         id, action, outcome, block_code, wait_ms, approvals_n, felt, note, actor
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.action,
      input.outcome,
      input.blockCode ?? null,
      input.waitMs ?? null,
      input.approvalsN ?? null,
      input.felt ?? null,
      input.note ?? null,
      input.actor ?? null,
    );
    const path = process.env.CHAMBER_PILOT_LOG;
    if (path) {
      appendFileSync(
        path,
        JSON.stringify({ id, ts: new Date().toISOString(), ...input }) + "\n",
      );
    }
  } catch {
    /* never break product path */
  }
}

export function pilotSummary(db: DatabaseSync, limit = 50): string {
  try {
    ensurePilotSchema(db);
    const rows = db
      .prepare(
        `SELECT action, outcome, block_code AS blockCode, felt, note, ts
         FROM pilot_event ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit) as {
      action: string;
      outcome: string;
      blockCode: string | null;
      felt: number | null;
      note: string | null;
      ts: string;
    }[];
    if (!rows.length) return "No pilot events (set CHAMBER_PILOT=1).";
    const blocked = rows.filter((r) => r.outcome === "blocked").length;
    const feltVals = rows.map((r) => r.felt).filter((x): x is number => x != null);
    const avgFelt =
      feltVals.length > 0
        ? (feltVals.reduce((a, b) => a + b, 0) / feltVals.length).toFixed(1)
        : "—";
    return [
      `pilot events=${rows.length} blocked=${blocked} avg_felt=${avgFelt}`,
      ...rows.slice(0, 10).map(
        (r) =>
          `• ${r.ts.slice(11, 19)} ${r.action} ${r.outcome}` +
          (r.blockCode ? ` [${r.blockCode}]` : "") +
          (r.felt != null ? ` felt=${r.felt}` : ""),
      ),
    ].join("\n");
  } catch {
    return "pilot summary unavailable";
  }
}
