/**
 * Hermes-style profile docs: SOUL / USER / MEMORY — under Chamber gates.
 * soul = voice/constitution (high friction)
 * user = model of the human
 * memory = curated durable facts (capacity-capped like Hermes MEMORY.md)
 */

import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "./hash.ts";
import { proposeWrite } from "./approvals.ts";
import { appendAudit } from "./audit.ts";

export type ProfileKind = "soul" | "user" | "memory" | "custom";

const DEFAULTS: Record<
  "soul" | "user" | "memory",
  { title: string; body: string; maxChars: number }
> = {
  soul: {
    title: "SOUL",
    body: `# SOUL\n\nChamber default voice: precise, refuse when unwarranted, never silent-pass.\n`,
    maxChars: 4000,
  },
  user: {
    title: "USER",
    body: `# USER\n\n(empty — filled via remember / harvest)\n`,
    maxChars: 1375,
  },
  memory: {
    title: "MEMORY",
    body: `# MEMORY\n\n(empty — durable facts only after approval)\n`,
    maxChars: 2200,
  },
};

export function ensureDefaultProfiles(db: DatabaseSync): void {
  for (const kind of ["soul", "user", "memory"] as const) {
    const row = db
      .prepare(`SELECT id FROM profile_doc WHERE id = ?`)
      .get(kind) as { id: string } | undefined;
    if (row) continue;
    const d = DEFAULTS[kind];
    db.prepare(
      `INSERT INTO profile_doc (id, kind, title, body, content_hash, max_chars, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 'system')`,
    ).run(kind, kind, d.title, d.body, sha256(d.body), d.maxChars);
  }
}

export function getProfile(
  db: DatabaseSync,
  id: string,
): {
  id: string;
  kind: string;
  title: string;
  body: string;
  maxChars: number | null;
  version: number;
} | null {
  ensureDefaultProfiles(db);
  const row = db
    .prepare(
      `SELECT id, kind, title, body, max_chars AS maxChars, version FROM profile_doc WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        kind: string;
        title: string;
        body: string;
        maxChars: number | null;
        version: number;
      }
    | undefined;
  return row ?? null;
}

export function listProfiles(db: DatabaseSync) {
  ensureDefaultProfiles(db);
  return db
    .prepare(
      `SELECT id, kind, title, length(body) AS chars, max_chars AS maxChars, version
       FROM profile_doc ORDER BY kind`,
    )
    .all() as {
    id: string;
    kind: string;
    title: string;
    chars: number;
    maxChars: number | null;
    version: number;
  }[];
}

/**
 * Update profile. soul always queues approval; memory/user queue unless forceDirect for system.
 */
export function updateProfile(
  db: DatabaseSync,
  id: string,
  body: string,
  opts: { by?: string; direct?: boolean } = {},
): { ok: boolean; status: string; writeId?: string; reason?: string } {
  ensureDefaultProfiles(db);
  const cur = getProfile(db, id);
  if (!cur) return { ok: false, status: "missing", reason: "profile not found" };

  const max = cur.maxChars;
  let next = body;
  if (max && next.length > max) {
    next = next.slice(0, max);
  }

  const needsApproval =
    !opts.direct && (cur.kind === "soul" || cur.kind === "memory" || cur.kind === "user");

  if (needsApproval) {
    const q = proposeWrite(db, {
      target: "user_profile",
      action: "replace",
      subject: id,
      payload: {
        stakes: cur.kind === "soul" ? "consequential" : "routine",
        body: next,
        kind: cur.kind,
      },
      origin: "foreground",
      authorFamily: opts.by ?? "human",
      reason: `profile update ${id}`,
    });
    if (q.status === "queued") {
      return { ok: true, status: "queued", writeId: q.writeId };
    }
    if (q.status !== "applied_immediate") {
      return { ok: false, status: q.status, reason: "approval blocked" };
    }
  }

  const hash = sha256(next);
  db.prepare(
    `UPDATE profile_doc
     SET body = ?, content_hash = ?, version = version + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ?
     WHERE id = ?`,
  ).run(next, hash, opts.by ?? "human", id);

  appendAudit(db, {
    category: "ledger",
    action: "profile_update",
    actor: opts.by ?? "human",
    subjectKind: "profile",
    subjectId: id,
    detail: { version: cur.version + 1, chars: next.length },
  });

  return { ok: true, status: "active" };
}

/** Inject profiles into system prompt context (read-only). */
export function profileContext(db: DatabaseSync): string {
  ensureDefaultProfiles(db);
  const parts: string[] = [];
  for (const id of ["soul", "user", "memory"]) {
    const p = getProfile(db, id);
    if (p && p.body.trim()) {
      parts.push(`## ${p.title}\n${p.body.trim()}`);
    }
  }
  return parts.join("\n\n");
}
