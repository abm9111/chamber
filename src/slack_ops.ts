/**
 * Slack ↔ Chamber ops (in-process). Used by Bolt plugin / HTTP bridge.
 * Authority stays in decideWrite / turn gates — this is transport glue only.
 */

import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { openChamberDb } from "./db.ts";
import { newId, sha256 } from "./hash.ts";
import { appendAudit } from "./audit.ts";
import { startSession, appendMessage } from "./sessions.ts";
import { commitBelief } from "./commit_belief.ts";
import { completeSync } from "./model.ts";
import { enforceReplyContract } from "./contract.ts";
import { formatSpendFooter, spendLastHours } from "./spend.ts";
import { runExpiryJob } from "./expiry.ts";
import {
  decideWrite,
  markApplied,
  listPendingQueue,
  formatWriteConflict,
  onPendingWrite,
  pendingWhy,
  type DecideWriteResult,
} from "./approvals.ts";
import { ensureDefaultScope, globalPosture } from "./scope.ts";
import { listJobs } from "./job_queue.ts";
import {
  quarantineUntrustedText,
  stripInvisibleNoise,
  checkRateLimit,
  surfaceRateKey,
} from "./surface_harden.ts";

export function openSlackDb(): DatabaseSync {
  return openChamberDb(process.env.CHAMBER_DB ?? "/tmp/chamber.sqlite");
}

export function canSlackApprove(userId: string): boolean {
  const raw = process.env.CHAMBER_SLACK_APPROVERS ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (set.size === 0) return false; // fail closed
  return set.has(userId);
}

export function slackScopeId(channelId: string, userId?: string): string {
  if (channelId.startsWith("D")) {
    return `slack_dm_${userId ?? channelId}`;
  }
  return `slack_${channelId}`;
}

export function gatedSlackTurn(
  db: DatabaseSync,
  message: string,
  meta: { channelId: string; userId: string; threadTs?: string },
): string {
  runExpiryJob(db);
  ensureDefaultScope(db);
  const rate = checkRateLimit(
    surfaceRateKey("slack", meta.userId, meta.channelId),
  );
  if (!rate.ok) {
    return `Rate limited. Retry in ~${Math.ceil((rate.retryAfterMs ?? 60000) / 1000)}s.`;
  }
  const cleaned = stripInvisibleNoise(message);
  const turnId = newId("trn");
  const scopeId = slackScopeId(meta.channelId, meta.userId);
  const sessionId = startSession(db, {
    channel: "slack",
    title: `slack:${scopeId}`.slice(0, 80),
    scopeId,
  });
  appendMessage(db, sessionId, "user", message, turnId);

  appendAudit(db, {
    category: "session",
    action: "turn_start",
    actor: `slack:${meta.userId}`,
    turnId,
    sessionId,
    detail: {
      channel: "slack",
      channelId: meta.channelId,
      scopeId,
      message: message.slice(0, 200),
    },
  });

  commitBelief(db, {
    type: "observation",
    text: `user said: ${cleaned.slice(0, 240)}`,
    sources: [
      {
        kind: "transcript",
        refId: turnId,
        snapshotHash: sha256(cleaned),
        provenance: "transcript",
      },
    ],
    authorFamily: "slack",
    sessionId,
    path: "fast",
    turnId,
  });

  const completion = completeSync(db, {
    messages: [
      {
        role: "system",
        content:
          "You are Chamber. Prefer observations over assertions. Mark uncertainty explicitly.",
      },
      { role: "user", content: quarantineUntrustedText(cleaned, "slack") },
    ],
    channel: "chat",
    turnId,
    sessionId,
    userText: message,
  });

  const contract = enforceReplyContract(db, completion.text, {
    sessionId,
    turnId,
    strict: process.env.CHAMBER_STRICT_CONTRACT === "1",
  });

  appendMessage(db, sessionId, "assistant", completion.text, turnId);
  const spend = formatSpendFooter(spendLastHours(db, 24));
  const parts = [
    completion.text,
    "",
    spend,
    contract.results.some((r) => r.status === "DEBT" || r.status === "REFUSED")
      ? `(contract: ${contract.results.map((r) => r.status).join(",")})`
      : "",
    `scope=${scopeId} posture=${globalPosture()}`,
  ].filter(Boolean);
  return parts.join("\n").slice(0, 3900);
}

export function slackStatus(db: DatabaseSync): string {
  const spend = formatSpendFooter(spendLastHours(db, 24));
  const pending = listPendingQueue(db, 20);
  const jobs = listJobs(db, 5);
  return [
    `*Chamber status*`,
    spend,
    `posture: ${globalPosture()}`,
    `pending writes: ${pending.length}`,
    ...pending.slice(0, 5).map(
      (p) => `• \`${p.id}\` ${p.target}/${p.action} ${p.subject}`,
    ),
    jobs.length ? `recent jobs: ${jobs.map((j) => j.status).join(",")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function slackQueue(db: DatabaseSync): string {
  const pending = listPendingQueue(db, 30);
  if (!pending.length) return "Queue empty.";
  return [
    `*Pending writes (${pending.length})*`,
    ...pending.map(
      (p) =>
        `• \`${p.id}\` — ${p.target}/${p.action} — ${p.subject}\n  _${pendingWhy({
          target: p.target,
          action: p.action,
          origin: p.origin,
          reason: p.reason,
          expiresAt: p.expiresAt,
        })}_`,
    ),
  ].join("\n");
}

export function slackApprove(
  db: DatabaseSync,
  writeId: string,
  userId: string,
): { ok: boolean; text: string; decide: DecideWriteResult } {
  if (!canSlackApprove(userId)) {
    return {
      ok: false,
      text: "Not allowlisted (`CHAMBER_SLACK_APPROVERS`).",
      decide: {
        ok: false,
        code: "invalid_transition",
        reason: "approver not allowlisted",
      },
    };
  }
  const decide = decideWrite(db, {
    writeId,
    decision: "approved",
    decidedBy: `slack:${userId}`,
  });
  if (!decide.ok) {
    return {
      ok: false,
      text: formatWriteConflict(decide),
      decide,
    };
  }
  let appliedNote = "";
  if (decide.status === "approved" || decide.idempotent) {
    const m = markApplied(db, writeId);
    if (m.ok) {
      appliedNote = m.idempotent ? " (already applied)" : " (applied)";
    } else {
      appliedNote = ` (apply: ${m.reason})`;
    }
  }
  const prefix = decide.idempotent ? "Already settled" : "Approved";
  return {
    ok: true,
    text: `${prefix} \`${writeId}\`${appliedNote}`,
    decide,
  };
}

export function slackReject(
  db: DatabaseSync,
  writeId: string,
  userId: string,
  note?: string,
): { ok: boolean; text: string; decide: DecideWriteResult } {
  if (!canSlackApprove(userId)) {
    return {
      ok: false,
      text: "Not allowlisted (`CHAMBER_SLACK_APPROVERS`).",
      decide: {
        ok: false,
        code: "invalid_transition",
        reason: "approver not allowlisted",
      },
    };
  }
  const decide = decideWrite(db, {
    writeId,
    decision: "rejected",
    decidedBy: `slack:${userId}`,
    note: note ?? "slack reject",
  });
  if (!decide.ok) {
    return { ok: false, text: formatWriteConflict(decide), decide };
  }
  const prefix = decide.idempotent ? "Already rejected" : "Rejected";
  return { ok: true, text: `${prefix} \`${writeId}\``, decide };
}

/** Parse `/chamber` text → verb + args */
export function parseChamberSlash(text: string): {
  verb: string;
  args: string[];
} {
  const parts = (text ?? "").trim().split(/\s+/).filter(Boolean);
  const verb = (parts[0] ?? "help").toLowerCase();
  return { verb, args: parts.slice(1) };
}

export function handleChamberSlash(
  db: DatabaseSync,
  text: string,
  meta: { userId: string; channelId: string },
): { ephemeral: string; publicReply?: string } {
  const { verb, args } = parseChamberSlash(text);
  switch (verb) {
    case "status":
      return { ephemeral: slackStatus(db) };
    case "queue":
      return { ephemeral: slackQueue(db) };
    case "scope":
      return {
        ephemeral: `scope=\`${slackScopeId(meta.channelId, meta.userId)}\` posture=${globalPosture()}`,
      };
    case "approve": {
      const id = args[0];
      if (!id) return { ephemeral: "usage: /chamber approve <writeId>" };
      return { ephemeral: slackApprove(db, id, meta.userId).text };
    }
    case "reject": {
      const id = args[0];
      if (!id) return { ephemeral: "usage: /chamber reject <writeId>" };
      return {
        ephemeral: slackReject(db, id, meta.userId, args.slice(1).join(" ")).text,
      };
    }
    case "ask": {
      const msg = args.join(" ").trim();
      if (!msg) return { ephemeral: "usage: /chamber ask <message>" };
      const reply = gatedSlackTurn(db, msg, {
        channelId: meta.channelId,
        userId: meta.userId,
      });
      return { ephemeral: "answered in channel", publicReply: reply };
    }
    case "jobs": {
      const jobs = listJobs(db, 10);
      if (!jobs.length) return { ephemeral: "No jobs." };
      return {
        ephemeral: jobs
          .map(
            (j) =>
              `• ${j.kind} ${j.status} attempts=${j.attempts} \`${j.id.slice(0, 12)}\``,
          )
          .join("\n"),
      };
    }
    default:
      return {
        ephemeral:
          "usage: /chamber status|queue|approve <id>|reject <id>|ask <text>|scope|jobs|help",
      };
  }
}

/** Block Kit for a pending write (ops channel). */
export function pendingWriteBlocks(writeId: string, summary: string) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Pending write*\n\`${writeId}\`\n${summary.slice(0, 500)}`,
      },
    },
    {
      type: "actions",
      block_id: `pending_${writeId}`.slice(0, 255),
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "chamber_approve",
          value: writeId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: "chamber_reject",
          value: writeId,
        },
      ],
    },
  ];
}

/** Post Block Kit approve/reject card to ops channel (Web API; no Bolt required). */
export function postPendingWriteToOps(event: {
  writeId: string;
  target: string;
  action: string;
  subject: string;
  origin: string;
  reason?: string;
}): boolean {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.CHAMBER_SLACK_OPS_CHANNEL;
  if (!token || !channel) return false;

  const summary = `${event.target}/${event.action} — ${event.subject}` +
    (event.reason ? `\n_${event.reason}_` : "") +
    `\norigin: ${event.origin}`;
  const blocks = pendingWriteBlocks(event.writeId, summary);
  const payload = JSON.stringify({
    channel,
    text: `Pending: ${event.writeId}`,
    blocks,
  });
  const r = spawnSync(
    "curl",
    [
      "-s",
      "-m",
      "10",
      "-X",
      "POST",
      "https://slack.com/api/chat.postMessage",
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
    ],
    { encoding: "utf-8", maxBuffer: 1_000_000 },
  );
  const body = r.stdout || "";
  try {
    const j = JSON.parse(body) as { ok?: boolean; error?: string };
    return !!j.ok;
  } catch {
    return false;
  }
}

/** Register once: proposeWrite → ops channel card when env set. */
let _slackHookRegistered = false;
export function registerSlackPendingHook(): void {
  if (_slackHookRegistered) return;
  _slackHookRegistered = true;
  onPendingWrite((event) => {
    if (!process.env.CHAMBER_SLACK_OPS_CHANNEL || !process.env.SLACK_BOT_TOKEN) {
      return;
    }
    // fire-and-forget style (sync curl under the hood)
    postPendingWriteToOps(event);
  });
}
