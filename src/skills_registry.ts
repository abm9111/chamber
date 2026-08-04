/**
 * Hermes-compatible skill registry with Chamber activation gates.
 * Learned skills always enter as pending/quarantine — never self-activate.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId, sha256 } from "./hash.ts";
import { proposeWrite } from "./approvals.ts";
import { appendAudit } from "./audit.ts";

export interface SkillRecord {
  id: string;
  name: string;
  description: string | null;
  triggerPattern: string | null;
  body: string;
  status: string;
  source: string;
  version: number;
}

export function registerSkill(
  db: DatabaseSync,
  input: {
    name: string;
    body: string;
    description?: string;
    triggerPattern?: string;
    source?: "human" | "learned" | "imported" | "synth";
    /** human source may go pending; learned always pending */
    activate?: boolean;
  },
): { ok: boolean; id?: string; status: string; writeId?: string } {
  const source = input.source ?? "human";
  const hash = sha256(input.body);
  const id = newId("skreg");

  const status =
    source === "learned" || source === "synth"
      ? "pending"
      : input.activate
        ? "pending"
        : "draft";

  db.prepare(
    `INSERT INTO skill_registry (
       id, name, description, trigger_pattern, body, content_hash, status, source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.description ?? null,
    input.triggerPattern ?? null,
    input.body,
    hash,
    status,
    source,
  );

  if (status === "pending" || input.activate) {
    const q = proposeWrite(db, {
      target: "skill",
      action: "create",
      subject: input.name,
      payload: {
        body: input.body,
        stakes: "routine",
        skill_registry_id: id,
      },
      origin: source === "learned" ? "dream" : "foreground",
      authorFamily: source,
      reason: `skill registry ${source}`,
    });
    appendAudit(db, {
      category: "skill",
      action: "skill_registered",
      actor: "system",
      subjectId: id,
      detail: { name: input.name, source, writeId: "writeId" in q ? q.writeId : null },
    });
    return {
      ok: true,
      id,
      status: "pending",
      writeId: "writeId" in q ? q.writeId : undefined,
    };
  }

  return { ok: true, id, status: "draft" };
}

export function listSkills(
  db: DatabaseSync,
  status?: string,
): SkillRecord[] {
  if (status) {
    return db
      .prepare(
        `SELECT id, name, description, trigger_pattern AS triggerPattern, body,
                status, source, version
         FROM skill_registry WHERE status = ? ORDER BY name`,
      )
      .all(status) as unknown as SkillRecord[];
  }
  return db
    .prepare(
      `SELECT id, name, description, trigger_pattern AS triggerPattern, body,
              status, source, version
       FROM skill_registry ORDER BY status, name`,
    )
    .all() as unknown as SkillRecord[];
}

export function activateSkillRegistry(
  db: DatabaseSync,
  id: string,
): boolean {
  const r = db
    .prepare(
      `UPDATE skill_registry
       SET status = 'active',
           activated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status IN ('pending','draft','quarantine')`,
    )
    .run(id);
  return Number(r.changes ?? 0) > 0;
}

export function matchSkills(db: DatabaseSync, utterance: string): SkillRecord[] {
  const active = listSkills(db, "active");
  return active.filter((s) => {
    if (!s.triggerPattern) return false;
    try {
      return new RegExp(s.triggerPattern, "i").test(utterance);
    } catch {
      return utterance.toLowerCase().includes(s.triggerPattern.toLowerCase());
    }
  });
}

/**
 * Learning loop v0: after a complex turn, propose a skill — never activate.
 */
export function proposeLearnedSkill(
  db: DatabaseSync,
  input: { name: string; body: string; evidence: string },
): { proposalId: string; writeId?: string } {
  const reg = registerSkill(db, {
    name: input.name,
    body: input.body,
    description: "Learned from session (pending human approve)",
    source: "learned",
  });
  const proposalId = newId("learn");
  db.prepare(
    `INSERT INTO learning_proposal (id, kind, title, payload_json, evidence, status, pending_write_id)
     VALUES (?, 'create_skill', ?, ?, ?, 'pending', ?)`,
  ).run(
    proposalId,
    input.name,
    JSON.stringify({ skillId: reg.id, body: input.body }),
    input.evidence,
    reg.writeId ?? null,
  );
  return { proposalId, writeId: reg.writeId };
}

export function listLearningProposals(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT id, kind, title, evidence, status, pending_write_id AS writeId, created_at AS createdAt
       FROM learning_proposal WHERE status = 'pending' ORDER BY created_at DESC`,
    )
    .all() as {
    id: string;
    kind: string;
    title: string;
    evidence: string | null;
    status: string;
    writeId: string | null;
    createdAt: string;
  }[];
}
