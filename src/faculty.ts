/**
 * Faculty parliament — narrow multi-agent with blocking power.
 *
 * Faculties:
 *   mind_consciousness | epistemology | applied_ethics |
 *   language_logic | philosophy_of_tech
 *
 * Law: no silent pass. Timeout → parked (or epistemology-only for routine).
 * Votes are durable rows. Heuristic voters by default; model votes optional later.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./hash.ts";
import { appendAudit } from "./audit.ts";
import { recordSpend } from "./spend.ts";
import { completeSync } from "./model.ts";

export type Faculty =
  | "mind_consciousness"
  | "epistemology"
  | "applied_ethics"
  | "language_logic"
  | "philosophy_of_tech";

export type FacultyVoteValue = "approve" | "reject" | "abstain" | "defer";

export const FACULTIES: Faculty[] = [
  "mind_consciousness",
  "epistemology",
  "applied_ethics",
  "language_logic",
  "philosophy_of_tech",
];

export const FACULTY_LABEL: Record<Faculty, string> = {
  mind_consciousness: "Mind & Consciousness",
  epistemology: "Epistemology",
  applied_ethics: "Applied Ethics",
  language_logic: "Language & Logic",
  philosophy_of_tech: "Philosophy of Technology",
};

export interface DeliberationInput {
  subjectKind: "skill" | "belief" | "memory" | "tool" | "constitution" | "other";
  subjectId: string;
  question: string;
  stakes?: "routine" | "elevated" | "consequential";
  /** seconds until timeout */
  timeoutSec?: number;
  requiredQuorum?: number;
  /** context for heuristic voters */
  context?: {
    hasSources?: boolean;
    openDebts?: number;
    riskTags?: string[];
    isSkillMutation?: boolean;
    isMemoryPromote?: boolean;
  };
}

export interface DeliberationResult {
  id: string;
  status: "open" | "passed" | "rejected" | "parked" | "timed_out";
  outcome: string;
  votes: { faculty: Faculty; vote: FacultyVoteValue; rationale: string }[];
}

/** Heuristic faculty voters — deterministic, auditable, not LLM cosplay. */
function heuristicVote(
  faculty: Faculty,
  input: DeliberationInput,
): { vote: FacultyVoteValue; rationale: string } {
  const ctx = input.context ?? {};
  const stakes = input.stakes ?? "routine";

  switch (faculty) {
    case "epistemology":
      if (ctx.openDebts && ctx.openDebts > 0) {
        return {
          vote: "reject",
          rationale: "Open citation debts — claim not warranted yet",
        };
      }
      if (ctx.hasSources === false && input.subjectKind === "belief") {
        return {
          vote: "defer",
          rationale: "No sources attached; defer until evidence",
        };
      }
      return { vote: "approve", rationale: "Epistemic checks clear" };

    case "applied_ethics":
      if (ctx.riskTags?.includes("harm") || ctx.riskTags?.includes("deception")) {
        return { vote: "reject", rationale: "Ethics: harm/deception risk tag" };
      }
      if (stakes === "consequential") {
        return {
          vote: "defer",
          rationale: "Consequential stakes — prefer human confirmation",
        };
      }
      return { vote: "approve", rationale: "No ethics red flags" };

    case "language_logic":
      if (!input.question || input.question.length < 8) {
        return { vote: "reject", rationale: "Ill-formed question" };
      }
      return { vote: "approve", rationale: "Question well-formed" };

    case "philosophy_of_tech":
      if (ctx.isSkillMutation && stakes !== "routine") {
        return {
          vote: "defer",
          rationale: "Skill mutation under elevated stakes — slow path",
        };
      }
      if (ctx.riskTags?.includes("network") || ctx.riskTags?.includes("shell")) {
        return {
          vote: "reject",
          rationale: "High-capability tool surface without extra review",
        };
      }
      return { vote: "approve", rationale: "Tech surface acceptable" };

    case "mind_consciousness":
      // Prefer abstention over forced certainty when evidence thin
      if (ctx.hasSources === false && ctx.openDebts) {
        return {
          vote: "abstain",
          rationale: "Negative capability: abstain under uncertainty",
        };
      }
      return { vote: "approve", rationale: "No consciousness/agency conflict" };

    default:
      return { vote: "abstain", rationale: "Unknown faculty" };
  }
}

export function openDeliberation(
  db: DatabaseSync,
  input: DeliberationInput,
): DeliberationResult {
  const id = newId("del");
  const stakes = input.stakes ?? "routine";
  const quorum =
    input.requiredQuorum ??
    (stakes === "consequential" ? 4 : stakes === "elevated" ? 3 : 2);
  const timeoutSec = input.timeoutSec ?? (stakes === "consequential" ? 3600 : 30);
  const timeoutAt = new Date(Date.now() + timeoutSec * 1000).toISOString();

  db.prepare(
    `INSERT INTO deliberation (
       id, subject_kind, subject_id, question, stakes,
       status, required_quorum, timeout_at
     ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(
    id,
    input.subjectKind,
    input.subjectId,
    input.question,
    stakes,
    quorum,
    timeoutAt,
  );

  const votes: DeliberationResult["votes"] = [];
  const mode = (process.env.CHAMBER_FACULTY_MODE ?? "heuristic").toLowerCase();
  for (const faculty of FACULTIES) {
    let vote: FacultyVoteValue;
    let rationale: string;
    let modelFamily: string | null = null;

    if (mode === "model") {
      try {
        const hv = heuristicVote(faculty, input);
        // Model may only refine; heuristic reject still wins (safety)
        const completion = completeSync(db, {
          messages: [
            {
              role: "system",
              content: `You are the ${FACULTY_LABEL[faculty]} faculty of Chamber. Reply with exactly one line: VOTE=<approve|reject|abstain|defer> REASON=<short>`,
            },
            {
              role: "user",
              content: `Subject: ${input.subjectKind}:${input.subjectId}\nStakes: ${input.stakes ?? "routine"}\nQuestion: ${input.question}\nContext: ${JSON.stringify(input.context ?? {})}`,
            },
          ],
          channel: "faculty",
          turnId: id,
        });
        modelFamily = completion.modelFamily;
        const m = completion.text.match(
          /VOTE\s*=\s*(approve|reject|abstain|defer)/i,
        );
        const reasonM = completion.text.match(/REASON\s*=\s*(.+)/i);
        if (m) {
          vote = m[1]!.toLowerCase() as FacultyVoteValue;
          rationale = (reasonM?.[1] ?? completion.text).slice(0, 240);
          // Safety: heuristic reject cannot be overturned by model approve
          if (hv.vote === "reject" && vote === "approve") {
            vote = "reject";
            rationale = `heuristic veto: ${hv.rationale}`;
          }
        } else {
          vote = hv.vote;
          rationale = `model parse failed; heuristic: ${hv.rationale}`;
        }
      } catch {
        const hv = heuristicVote(faculty, input);
        vote = hv.vote;
        rationale = `model unavailable; heuristic: ${hv.rationale}`;
      }
    } else {
      const hv = heuristicVote(faculty, input);
      vote = hv.vote;
      rationale = hv.rationale;
    }

    db.prepare(
      `INSERT INTO faculty_vote (
         id, deliberation_id, faculty, vote, rationale, model_family
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(newId("fv"), id, faculty, vote, rationale, modelFamily);
    votes.push({ faculty, vote, rationale });
  }

  const result = closeDeliberation(db, id);
  recordSpend(db, {
    channel: "faculty",
    model: "heuristic-v0",
    modelFamily: "local",
    inputTokens: 50,
    outputTokens: 50,
    costUsd: 0,
    detail: { deliberation_id: id, status: result.status },
  });
  return result;
}

/** Tally votes and set terminal status. */
export function closeDeliberation(
  db: DatabaseSync,
  deliberationId: string,
): DeliberationResult {
  const delib = db
    .prepare(`SELECT * FROM deliberation WHERE id = ?`)
    .get(deliberationId) as
    | {
        id: string;
        status: string;
        required_quorum: number;
        timeout_at: string | null;
        stakes: string;
        subject_kind: string;
        subject_id: string;
        question: string;
      }
    | undefined;

  if (!delib) {
    return {
      id: deliberationId,
      status: "parked",
      outcome: "not found",
      votes: [],
    };
  }

  const voteRows = db
    .prepare(
      `SELECT faculty, vote, rationale FROM faculty_vote WHERE deliberation_id = ?`,
    )
    .all(deliberationId) as {
    faculty: Faculty;
    vote: FacultyVoteValue;
    rationale: string;
  }[];

  const approves = voteRows.filter((v) => v.vote === "approve").length;
  const rejects = voteRows.filter((v) => v.vote === "reject").length;
  const timedOut =
    delib.timeout_at != null && delib.timeout_at <= new Date().toISOString();

  let status: DeliberationResult["status"];
  let outcome: string;

  if (rejects > 0) {
    // Any reject blocks (hard parliament)
    status = "rejected";
    outcome = `blocked by ${rejects} reject vote(s)`;
  } else if (approves >= delib.required_quorum) {
    status = "passed";
    outcome = `quorum met (${approves}/${delib.required_quorum})`;
  } else if (timedOut) {
    // Timeout: routine may pass on epistemology-only; else park
    const epi = voteRows.find((v) => v.faculty === "epistemology");
    if (delib.stakes === "routine" && epi?.vote === "approve") {
      status = "passed";
      outcome = "timeout → epistemology default approve (routine only)";
    } else {
      status = "parked";
      outcome = "timeout without quorum — parked (not silent pass)";
    }
  } else {
    status = "open";
    outcome = `awaiting quorum (${approves}/${delib.required_quorum})`;
  }

  if (status !== "open") {
    db.prepare(
      `UPDATE deliberation
       SET status = ?, outcome = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    ).run(status, outcome, deliberationId);
  }

  appendAudit(db, {
    category: "constitution",
    action: "faculty_deliberation",
    actor: "system",
    detail: {
      id: deliberationId,
      status,
      outcome,
      subject: `${delib.subject_kind}:${delib.subject_id}`,
    },
  });

  return {
    id: deliberationId,
    status,
    outcome,
    votes: voteRows.map((v) => ({
      faculty: v.faculty,
      vote: v.vote,
      rationale: v.rationale,
    })),
  };
}

export function getDeliberation(
  db: DatabaseSync,
  id: string,
): DeliberationResult | null {
  const delib = db
    .prepare(`SELECT id, status, outcome FROM deliberation WHERE id = ?`)
    .get(id) as { id: string; status: string; outcome: string | null } | undefined;
  if (!delib) return null;
  const voteRows = db
    .prepare(
      `SELECT faculty, vote, rationale FROM faculty_vote WHERE deliberation_id = ?`,
    )
    .all(id) as {
    faculty: Faculty;
    vote: FacultyVoteValue;
    rationale: string;
  }[];
  return {
    id: delib.id,
    status: delib.status as DeliberationResult["status"],
    outcome: delib.outcome ?? "",
    votes: voteRows,
  };
}

// ─── Shared workspace with lock ──────────────────────────────────────────────

export function workspaceGet(
  db: DatabaseSync,
  key: string,
): { value: unknown; version: number; lockedBy: string | null } | null {
  const row = db
    .prepare(
      `SELECT value_json, version, locked_by AS lockedBy FROM workspace_object WHERE key = ?`,
    )
    .get(key) as
    | { value_json: string; version: number; lockedBy: string | null }
    | undefined;
  if (!row) return null;
  return {
    value: JSON.parse(row.value_json),
    version: row.version,
    lockedBy: row.lockedBy,
  };
}

export function workspacePut(
  db: DatabaseSync,
  key: string,
  value: unknown,
  by: string,
  expectedVersion?: number,
): { ok: boolean; version?: number; reason?: string } {
  const cur = db
    .prepare(
      `SELECT version, locked_by FROM workspace_object WHERE key = ?`,
    )
    .get(key) as { version: number; locked_by: string | null } | undefined;

  if (cur?.locked_by && cur.locked_by !== by) {
    return { ok: false, reason: `locked by ${cur.locked_by}` };
  }
  if (
    expectedVersion != null &&
    cur &&
    cur.version !== expectedVersion
  ) {
    return {
      ok: false,
      reason: `version conflict have=${cur.version} expected=${expectedVersion}`,
    };
  }

  if (!cur) {
    db.prepare(
      `INSERT INTO workspace_object (key, value_json, version, updated_by)
       VALUES (?, ?, 1, ?)`,
    ).run(key, JSON.stringify(value), by);
    return { ok: true, version: 1 };
  }

  const next = cur.version + 1;
  db.prepare(
    `UPDATE workspace_object
     SET value_json = ?, version = ?, updated_by = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE key = ?`,
  ).run(JSON.stringify(value), next, by, key);
  return { ok: true, version: next };
}

export function workspaceLock(
  db: DatabaseSync,
  key: string,
  by: string,
): boolean {
  const cur = db
    .prepare(`SELECT locked_by FROM workspace_object WHERE key = ?`)
    .get(key) as { locked_by: string | null } | undefined;
  if (cur?.locked_by && cur.locked_by !== by) return false;
  if (!cur) {
    db.prepare(
      `INSERT INTO workspace_object (key, value_json, version, locked_by, locked_at, updated_by)
       VALUES (?, '{}', 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`,
    ).run(key, by, by);
    return true;
  }
  db.prepare(
    `UPDATE workspace_object
     SET locked_by = ?, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE key = ?`,
  ).run(by, key);
  return true;
}

export function workspaceUnlock(db: DatabaseSync, key: string, by: string): boolean {
  const cur = db
    .prepare(`SELECT locked_by FROM workspace_object WHERE key = ?`)
    .get(key) as { locked_by: string | null } | undefined;
  if (!cur) return false;
  if (cur.locked_by && cur.locked_by !== by) return false;
  db.prepare(
    `UPDATE workspace_object SET locked_by = NULL, locked_at = NULL WHERE key = ?`,
  ).run(key);
  return true;
}
