/**
 * Automated approval workflows.
 *
 * evaluateWorkflows(pendingWriteId) runs enabled rules in priority order.
 * First match wins. No match → require_human (fail closed).
 *
 * Safety:
 * - constitution / consequential → never auto_approve (seeded rules)
 * - expire ≠ approve (handled in approvals.expireStalePending)
 * - auto_approve rate-limited per workflow per hour
 * - master switch workflows.auto_approve_enabled
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "./hash.ts";
import { decideWrite } from "./approvals.ts";

export type WorkflowOutcome =
  | "auto_approve"
  | "auto_reject"
  | "require_human"
  | "require_critic";

export interface WorkflowMatch {
  workflowId: string;
  name: string;
  outcome: WorkflowOutcome;
  rejectReason?: string;
}

export interface EvaluateResult {
  pendingWriteId: string;
  matched: WorkflowMatch | null;
  applied: "auto_approve" | "auto_reject" | "queued_human" | "queued_critic" | "rate_limited" | "disabled";
  detail?: string;
}

interface WorkflowRow {
  id: string;
  name: string;
  priority: number;
  match_target: string | null;
  match_action: string | null;
  match_origin: string | null;
  match_stakes: string | null;
  outcome: WorkflowOutcome;
  reject_reason: string | null;
  max_auto_per_hour: number | null;
  require_payload_keys: string | null;
}

interface PendingRow {
  id: string;
  target: string;
  action: string;
  subject: string;
  origin: string;
  status: string;
  reason: string | null;
  payload_json: string;
}

function policyOn(db: DatabaseSync, key: string): boolean {
  const row = db
    .prepare(`SELECT value FROM approval_policy WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return (row?.value ?? "on") === "on";
}

function payloadStakes(payloadJson: string): "routine" | "consequential" | null {
  try {
    const p = JSON.parse(payloadJson) as { stakes?: string };
    if (p.stakes === "consequential" || p.stakes === "routine") return p.stakes;
  } catch {
    /* ignore */
  }
  return null;
}

function matchesRule(rule: WorkflowRow, pending: PendingRow): boolean {
  if (rule.match_target && rule.match_target !== pending.target) return false;
  if (rule.match_action && rule.match_action !== pending.action) return false;
  if (rule.match_origin && rule.match_origin !== pending.origin) return false;
  if (rule.match_stakes) {
    const stakes = payloadStakes(pending.payload_json);
    // If rule requires stakes but payload has none, only match "routine" rules
    // when stakes absent (treat missing as routine for narrow auto paths).
    const effective = stakes ?? "routine";
    if (rule.match_stakes !== effective) return false;
  }
  if (rule.require_payload_keys) {
    try {
      const keys = JSON.parse(rule.require_payload_keys) as string[];
      const payload = JSON.parse(pending.payload_json) as Record<string, unknown>;
      for (const k of keys) {
        if (payload[k] === undefined || payload[k] === null || payload[k] === "") {
          return false;
        }
      }
    } catch {
      return false;
    }
  }
  // Special: reject_empty_background_reason style — if outcome auto_reject and
  // name implies reason required, check reason present for background.
  if (
    rule.outcome === "auto_reject" &&
    rule.id === "wf_reject_empty_reason" &&
    pending.origin === "background_review" &&
    pending.reason &&
    pending.reason.trim().length > 0
  ) {
    return false; // has reason → rule does not match
  }
  return true;
}

function autoApproveCountLastHour(db: DatabaseSync, workflowId: string): number {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM approval_workflow_event
       WHERE workflow_id = ?
         AND decision = 'auto_approve'
         AND created_at >= ?`,
    )
    .get(workflowId, since) as { c: number };
  return row?.c ?? 0;
}

function logEvent(
  db: DatabaseSync,
  workflowId: string,
  pendingWriteId: string,
  decision: string,
  detail?: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO approval_workflow_event (id, workflow_id, pending_write_id, decision, detail_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    newId("wfe"),
    workflowId,
    pendingWriteId,
    decision,
    detail ? JSON.stringify(detail) : null,
  );
}

function loadEnabledWorkflows(db: DatabaseSync): WorkflowRow[] {
  return db
    .prepare(
      `SELECT id, name, priority, match_target, match_action, match_origin,
              match_stakes, outcome, reject_reason, max_auto_per_hour, require_payload_keys
       FROM approval_workflow
       WHERE enabled = 1
       ORDER BY priority ASC, name ASC`,
    )
    .all() as unknown as WorkflowRow[];
}

/**
 * Evaluate workflows against one pending write and apply auto outcomes.
 * Safe to call immediately after proposeWrite returns queued.
 */
export function evaluateWorkflows(
  db: DatabaseSync,
  pendingWriteId: string,
): EvaluateResult {
  if (!policyOn(db, "workflows.enabled")) {
    return {
      pendingWriteId,
      matched: null,
      applied: "disabled",
      detail: "workflows.enabled=off",
    };
  }

  const pending = db
    .prepare(
      `SELECT id, target, action, subject, origin, status, reason, payload_json
       FROM pending_write WHERE id = ?`,
    )
    .get(pendingWriteId) as PendingRow | undefined;

  if (!pending) {
    return {
      pendingWriteId,
      matched: null,
      applied: "queued_human",
      detail: "pending write not found",
    };
  }
  if (pending.status !== "pending") {
    return {
      pendingWriteId,
      matched: null,
      applied: "queued_human",
      detail: `status=${pending.status}`,
    };
  }

  const rules = loadEnabledWorkflows(db);
  let matched: WorkflowRow | null = null;
  for (const rule of rules) {
    if (matchesRule(rule, pending)) {
      matched = rule;
      break;
    }
  }

  if (!matched) {
    // Fail closed — should not happen if default_require_human is seeded
    return {
      pendingWriteId,
      matched: null,
      applied: "queued_human",
      detail: "no workflow matched",
    };
  }

  const matchInfo: WorkflowMatch = {
    workflowId: matched.id,
    name: matched.name,
    outcome: matched.outcome,
    rejectReason: matched.reject_reason ?? undefined,
  };

  // ── Outcomes ───────────────────────────────────────────────────────────
  if (matched.outcome === "require_human") {
    logEvent(db, matched.id, pendingWriteId, "require_human");
    return { pendingWriteId, matched: matchInfo, applied: "queued_human" };
  }

  if (matched.outcome === "require_critic") {
    logEvent(db, matched.id, pendingWriteId, "require_critic");
    // Stay pending; external critic path sets decided_by=critic later
    db.prepare(
      `UPDATE pending_write SET decision_note = COALESCE(decision_note, '') || ' [awaiting critic]'
       WHERE id = ?`,
    ).run(pendingWriteId);
    return { pendingWriteId, matched: matchInfo, applied: "queued_critic" };
  }

  if (matched.outcome === "auto_reject") {
    const note = matched.reject_reason ?? "workflow auto_reject";
    decideWrite(db, pendingWriteId, "rejected", "auto_policy", note);
    logEvent(db, matched.id, pendingWriteId, "auto_reject", { note });
    return { pendingWriteId, matched: matchInfo, applied: "auto_reject", detail: note };
  }

  if (matched.outcome === "auto_approve") {
    if (!policyOn(db, "workflows.auto_approve_enabled")) {
      logEvent(db, matched.id, pendingWriteId, "skipped", {
        reason: "auto_approve_enabled=off",
      });
      return {
        pendingWriteId,
        matched: matchInfo,
        applied: "queued_human",
        detail: "auto_approve disabled by policy",
      };
    }

    // Hard safety: never auto-approve constitution even if misconfigured rule
    if (pending.target === "constitution") {
      logEvent(db, matched.id, pendingWriteId, "require_human", {
        reason: "constitution hard block",
      });
      return {
        pendingWriteId,
        matched: matchInfo,
        applied: "queued_human",
        detail: "constitution cannot auto-approve",
      };
    }

    if (matched.max_auto_per_hour != null) {
      const used = autoApproveCountLastHour(db, matched.id);
      if (used >= matched.max_auto_per_hour) {
        logEvent(db, matched.id, pendingWriteId, "rate_limited", {
          used,
          cap: matched.max_auto_per_hour,
        });
        return {
          pendingWriteId,
          matched: matchInfo,
          applied: "rate_limited",
          detail: `workflow ${matched.name} hit ${matched.max_auto_per_hour}/hour`,
        };
      }
    }

    decideWrite(
      db,
      pendingWriteId,
      "approved",
      "auto_policy",
      `workflow:${matched.name}`,
    );
    logEvent(db, matched.id, pendingWriteId, "auto_approve");
    return { pendingWriteId, matched: matchInfo, applied: "auto_approve" };
  }

  return { pendingWriteId, matched: matchInfo, applied: "queued_human" };
}

/**
 * After proposeWrite queues an item, run workflows.
 * Convenience for agent loop integration.
 */
export function proposeAndEvaluate(
  db: DatabaseSync,
  propose: () => { status: string; writeId?: string; reason?: string; expiresAt?: string },
): {
  propose: ReturnType<typeof propose>;
  workflow?: EvaluateResult;
} {
  const result = propose();
  if (result.status === "queued" && result.writeId) {
    const workflow = evaluateWorkflows(db, result.writeId);
    return { propose: result, workflow };
  }
  return { propose: result };
}

/** List workflows for admin UI */
export function listWorkflows(db: DatabaseSync): {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  outcome: string;
  matchTarget: string | null;
  matchOrigin: string | null;
}[] {
  const rows = db
    .prepare(
      `SELECT id, name, enabled, priority, outcome, match_target, match_origin
       FROM approval_workflow ORDER BY priority ASC`,
    )
    .all() as {
    id: string;
    name: string;
    enabled: number;
    priority: number;
    outcome: string;
    match_target: string | null;
    match_origin: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    priority: r.priority,
    outcome: r.outcome,
    matchTarget: r.match_target,
    matchOrigin: r.match_origin,
  }));
}

export function setWorkflowEnabled(
  db: DatabaseSync,
  workflowId: string,
  enabled: boolean,
): void {
  db.prepare(`UPDATE approval_workflow SET enabled = ? WHERE id = ?`).run(
    enabled ? 1 : 0,
    workflowId,
  );
}
