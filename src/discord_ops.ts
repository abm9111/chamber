/**
 * Discord ↔ Chamber ops. Same contract as Slack: transport only, gates decide.
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
import { parseChamberSlash } from "./slack_ops.ts";

export function openDiscordDb(): DatabaseSync {
  return openChamberDb(process.env.CHAMBER_DB ?? "/tmp/chamber.sqlite");
}

/** Fail-closed: empty allowlist → no approve. */
export function canDiscordApprove(userId: string): boolean {
  const raw =
    process.env.CHAMBER_DISCORD_APPROVERS ??
    process.env.CHAMBER_SLACK_APPROVERS ??
    "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (set.size === 0) return false;
  return set.has(userId);
}

/** Who may talk to the bot. Empty = allow all (pilot default). Set to restrict. */
export function canDiscordTalk(userId: string): boolean {
  const raw = process.env.CHAMBER_DISCORD_ALLOWED_USERS ?? process.env.DISCORD_ALLOWED_USERS ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (set.size === 0) return true; // open talk; approve still fail-closed
  return set.has(userId);
}

/** Free-response channels: bot replies without @mention. Empty = mention-only in guilds. */
export function isDiscordFreeResponseChannel(channelId: string): boolean {
  const raw = process.env.CHAMBER_DISCORD_FREE_CHANNELS ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return set.has(channelId);
}

/** Strip / refuse @everyone @here in outbound text (Hermes-style mention safety). */
export function sanitizeDiscordOutbound(text: string): string {
  // No length cap here — chunkDiscordMessage owns size limits
  return text
    .replace(/@everyone/gi, "`@everyone`")
    .replace(/@here/gi, "`@here`")
    .replace(/<@&\d+>/g, "[role-mention]");
}

/** Attachment metadata only — no download, no bytes into model. */
export function formatAttachmentMeta(
  attachments: { name?: string | null; contentType?: string | null; size?: number; url?: string }[],
): string {
  if (!attachments.length) return "";
  const lines = attachments.slice(0, 10).map((a) => {
    const name = a.name ?? "file";
    const type = a.contentType ?? "unknown";
    const size = a.size != null ? `${a.size}b` : "?";
    return `- ${name} (${type}, ${size}) [metadata only — not fetched]`;
  });
  return `\n\n[attachments]\n${lines.join("\n")}`;
}

/** Split long replies into <=1900 chunks. */
export function chunkDiscordMessage(text: string, limit = 1900): string[] {
  const clean = sanitizeDiscordOutbound(text);
  if (clean.length <= limit) return [clean];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return chunks.slice(0, 5); // hard cap spam
}


export function discordScopeId(channelId: string, isDm: boolean, userId?: string): string {
  if (isDm) return `discord_dm_${userId ?? channelId}`;
  return `discord_${channelId}`;
}

export function gatedDiscordTurn(
  db: DatabaseSync,
  message: string,
  meta: { channelId: string; userId: string; isDm?: boolean },
): string {
  runExpiryJob(db);
  ensureDefaultScope(db);

  const rate = checkRateLimit(
    surfaceRateKey("discord", meta.userId, meta.channelId),
  );
  if (!rate.ok) {
    return `Rate limited. Retry in ~${Math.ceil((rate.retryAfterMs ?? 60000) / 1000)}s.`;
  }

  const cleaned = stripInvisibleNoise(message);
  const turnId = newId("trn");
  const scopeId = discordScopeId(meta.channelId, !!meta.isDm, meta.userId);
  const sessionId = startSession(db, {
    channel: "discord",
    title: `discord:${scopeId}`.slice(0, 80),
    scopeId,
  });
  appendMessage(db, sessionId, "user", message, turnId);

  appendAudit(db, {
    category: "session",
    action: "turn_start",
    actor: `discord:${meta.userId}`,
    turnId,
    sessionId,
    detail: {
      channel: "discord",
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
    authorFamily: "discord",
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
      { role: "user", content: quarantineUntrustedText(cleaned, "discord") },
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
  return [
    completion.text,
    "",
    spend,
    contract.results.some((r) => r.status === "DEBT" || r.status === "REFUSED")
      ? `(contract: ${contract.results.map((r) => r.status).join(",")})`
      : "",
    `scope=${scopeId} posture=${globalPosture()}`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1900); // Discord message limit soft cap
}

export function discordStatus(db: DatabaseSync): string {
  const spend = formatSpendFooter(spendLastHours(db, 24));
  const pending = listPendingQueue(db, 20);
  return [
    `**Chamber status**`,
    spend,
    `posture: ${globalPosture()}`,
    `pending writes: ${pending.length}`,
    ...pending
      .slice(0, 5)
      .map((p) => `• \`${p.id}\` ${p.target}/${p.action} ${p.subject}`),
  ].join("\n");
}

export function discordQueue(db: DatabaseSync): string {
  const pending = listPendingQueue(db, 30);
  if (!pending.length) return "Queue empty.";
  return [
    `**Pending writes (${pending.length})**`,
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

export function discordApprove(
  db: DatabaseSync,
  writeId: string,
  userId: string,
): { ok: boolean; text: string; decide: DecideWriteResult } {
  if (!canDiscordApprove(userId)) {
    return {
      ok: false,
      text: "Not allowlisted (`CHAMBER_DISCORD_APPROVERS`).",
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
    decidedBy: `discord:${userId}`,
  });
  if (!decide.ok) {
    return { ok: false, text: formatWriteConflict(decide), decide };
  }
  let appliedNote = "";
  if (decide.status === "approved" || decide.idempotent) {
    const m = markApplied(db, writeId);
    if (m.ok) appliedNote = m.idempotent ? " (already applied)" : " (applied)";
    else appliedNote = ` (apply: ${m.reason})`;
  }
  const prefix = decide.idempotent ? "Already settled" : "Approved";
  return { ok: true, text: `${prefix} \`${writeId}\`${appliedNote}`, decide };
}

export function discordReject(
  db: DatabaseSync,
  writeId: string,
  userId: string,
  note?: string,
): { ok: boolean; text: string; decide: DecideWriteResult } {
  if (!canDiscordApprove(userId)) {
    return {
      ok: false,
      text: "Not allowlisted (`CHAMBER_DISCORD_APPROVERS`).",
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
    decidedBy: `discord:${userId}`,
    note: note ?? "discord reject",
  });
  if (!decide.ok) {
    return { ok: false, text: formatWriteConflict(decide), decide };
  }
  const prefix = decide.idempotent ? "Already rejected" : "Rejected";
  return { ok: true, text: `${prefix} \`${writeId}\``, decide };
}

export function handleDiscordSlash(
  db: DatabaseSync,
  text: string,
  meta: { userId: string; channelId: string; isDm?: boolean },
): { ephemeral: string; publicReply?: string } {
  const { verb, args } = parseChamberSlash(text);
  switch (verb) {
    case "status":
      return { ephemeral: discordStatus(db) };
    case "queue":
      return { ephemeral: discordQueue(db) };
    case "scope":
      return {
        ephemeral: `scope=\`${discordScopeId(meta.channelId, !!meta.isDm, meta.userId)}\` posture=${globalPosture()}`,
      };
    case "approve": {
      const id = args[0];
      if (!id) return { ephemeral: "usage: /chamber approve <writeId>" };
      return { ephemeral: discordApprove(db, id, meta.userId).text };
    }
    case "reject": {
      const id = args[0];
      if (!id) return { ephemeral: "usage: /chamber reject <writeId>" };
      return {
        ephemeral: discordReject(db, id, meta.userId, args.slice(1).join(" ")).text,
      };
    }
    case "ask": {
      const msg = args.join(" ").trim();
      if (!msg) return { ephemeral: "usage: /chamber ask <message>" };
      const reply = gatedDiscordTurn(db, msg, {
        channelId: meta.channelId,
        userId: meta.userId,
        isDm: meta.isDm,
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

/** Discord button rows for pending writes */
export function pendingWriteDiscordComponents(writeId: string) {
  return [
    {
      type: 1, // ACTION_ROW
      components: [
        {
          type: 2, // BUTTON
          style: 3, // SUCCESS
          label: "Approve",
          custom_id: `chamber_approve:${writeId}`,
        },
        {
          type: 2,
          style: 4, // DANGER
          label: "Reject",
          custom_id: `chamber_reject:${writeId}`,
        },
      ],
    },
  ];
}

export function postPendingWriteToDiscordOps(event: {
  writeId: string;
  target: string;
  action: string;
  subject: string;
  origin: string;
  reason?: string;
}): boolean {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channel = process.env.CHAMBER_DISCORD_OPS_CHANNEL;
  if (!token || !channel) return false;

  const content =
    `**Pending write** \`${event.writeId}\`\n` +
    `${event.target}/${event.action} — ${event.subject}` +
    (event.reason ? `\n_${event.reason}_` : "") +
    `\norigin: ${event.origin}`;

  const payload = JSON.stringify({
    content,
    components: pendingWriteDiscordComponents(event.writeId),
  });

  const r = spawnSync(
    "curl",
    [
      "-s",
      "-m",
      "10",
      "-X",
      "POST",
      `https://discord.com/api/v10/channels/${channel}/messages`,
      "-H",
      `Authorization: Bot ${token}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
    ],
    { encoding: "utf-8", maxBuffer: 1_000_000 },
  );
  try {
    const j = JSON.parse(r.stdout || "{}") as { id?: string; message?: string };
    return !!j.id;
  } catch {
    return false;
  }
}

let _discordHookRegistered = false;
export function registerDiscordPendingHook(): void {
  if (_discordHookRegistered) return;
  _discordHookRegistered = true;
  onPendingWrite((event) => {
    if (!process.env.CHAMBER_DISCORD_OPS_CHANNEL || !process.env.DISCORD_BOT_TOKEN) {
      return;
    }
    postPendingWriteToDiscordOps(event);
  });
}
