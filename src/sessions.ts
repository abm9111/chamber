/**
 * Cross-session transcript store + FTS5 search (Hermes session_search analog).
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./hash.ts";

export function startSession(
  db: DatabaseSync,
  opts: {
    profileId?: string;
    channel?: string;
    title?: string;
    scopeId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): string {
  const id = newId("ses");
  const meta = {
    ...(opts.metadata ?? {}),
    ...(opts.scopeId ? { scopeId: opts.scopeId } : {}),
  };
  const scopeId = opts.scopeId ?? "default";
  try {
    db.prepare(
      `INSERT INTO session (id, profile_id, channel, title, scope_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.profileId ?? "default",
      opts.channel ?? "cli",
      opts.title ?? null,
      scopeId,
      Object.keys(meta).length ? JSON.stringify(meta) : null,
    );
  } catch {
    // Pre-migration DBs without scope_id column
    db.prepare(
      `INSERT INTO session (id, profile_id, channel, title, metadata_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.profileId ?? "default",
      opts.channel ?? "cli",
      opts.title ?? null,
      Object.keys(meta).length ? JSON.stringify(meta) : null,
    );
  }
  return id;
}

export function endSession(db: DatabaseSync, sessionId: string): void {
  db.prepare(
    `UPDATE session SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
  ).run(sessionId);
}

export function appendMessage(
  db: DatabaseSync,
  sessionId: string,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
  turnId?: string,
): string {
  const id = newId("smsg");
  db.prepare(
    `INSERT INTO session_message (id, session_id, role, content, turn_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, sessionId, role, content, turnId ?? null);

  try {
    db.prepare(
      `INSERT INTO session_message_fts (content, message_id, session_id, role)
       VALUES (?, ?, ?, ?)`,
    ).run(content, id, sessionId, role);
  } catch {
    /* FTS optional if virtual table missing in odd envs */
  }
  return id;
}

export interface SessionHit {
  messageId: string;
  sessionId: string;
  role: string;
  snippet: string;
  rank: number;
}

export function searchSessions(
  db: DatabaseSync,
  query: string,
  limit = 10,
): SessionHit[] {
  try {
    const rows = db
      .prepare(
        `SELECT message_id AS messageId, session_id AS sessionId, role,
                snippet(session_message_fts, 0, '[', ']', '…', 16) AS snippet,
                rank
         FROM session_message_fts
         WHERE session_message_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as SessionHit[];
    return rows;
  } catch {
    // Fallback LIKE
    const rows = db
      .prepare(
        `SELECT id AS messageId, session_id AS sessionId, role,
                substr(content, 1, 120) AS snippet, 0 AS rank
         FROM session_message
         WHERE content LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(`%${query}%`, limit) as SessionHit[];
    return rows;
  }
}

export function listSessions(db: DatabaseSync, limit = 20) {
  return db
    .prepare(
      `SELECT id, profile_id AS profileId, channel, title, started_at AS startedAt, ended_at AS endedAt
       FROM session ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as {
    id: string;
    profileId: string;
    channel: string;
    title: string | null;
    startedAt: string;
    endedAt: string | null;
  }[];
}

export function getSessionMessages(db: DatabaseSync, sessionId: string, limit = 100) {
  return db
    .prepare(
      `SELECT id, role, content, turn_id AS turnId, created_at AS createdAt
       FROM session_message WHERE session_id = ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(sessionId, limit) as {
    id: string;
    role: string;
    content: string;
    turnId: string | null;
    createdAt: string;
  }[];
}
