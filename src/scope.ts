/**
 * Per-person / room / org scopes (QM-inspired isolation).
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./hash.ts";

export type ScopeKind = "user" | "room" | "org" | "system";
export type ScopePolicy = "strict" | "auto";

export function ensureDefaultScope(db: DatabaseSync): void {
  db.prepare(
    `INSERT OR IGNORE INTO scope (id, kind, title, policy)
     VALUES ('default', 'org', 'Default org scope', 'auto')`,
  ).run();
}

export function createScope(
  db: DatabaseSync,
  input: {
    kind: ScopeKind;
    title?: string;
    parentId?: string;
    policy?: ScopePolicy;
    id?: string;
  },
): string {
  ensureDefaultScope(db);
  const id = input.id ?? newId("scp");
  db.prepare(
    `INSERT INTO scope (id, kind, parent_id, title, policy)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.parentId ?? null,
    input.title ?? input.kind,
    input.policy ?? globalPosture(),
  );
  return id;
}

export function getScope(db: DatabaseSync, id: string) {
  ensureDefaultScope(db);
  return db
    .prepare(
      `SELECT id, kind, parent_id AS parentId, title, policy FROM scope WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        kind: string;
        parentId: string | null;
        title: string | null;
        policy: ScopePolicy;
      }
    | undefined;
}

export function listScopes(db: DatabaseSync) {
  ensureDefaultScope(db);
  return db
    .prepare(
      `SELECT id, kind, parent_id AS parentId, title, policy FROM scope ORDER BY kind, id`,
    )
    .all() as {
    id: string;
    kind: string;
    parentId: string | null;
    title: string | null;
    policy: ScopePolicy;
  }[];
}

/** Effective policy for a scope (inherits global floor: strict wins). */
export function effectivePolicy(db: DatabaseSync, scopeId: string): ScopePolicy {
  const global = globalPosture();
  const s = getScope(db, scopeId);
  const local = s?.policy ?? "auto";
  if (global === "strict" || local === "strict") return "strict";
  return "auto";
}

export function globalPosture(): ScopePolicy {
  const p = (process.env.CHAMBER_POSTURE ?? "auto").toLowerCase();
  return p === "strict" ? "strict" : "auto";
}

/** Whether tool/skill writes require human even at routine stakes. */
export function requiresHumanForRoutine(db: DatabaseSync, scopeId: string): boolean {
  return effectivePolicy(db, scopeId) === "strict";
}
