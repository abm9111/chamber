/**
 * Chamber Slack Socket Mode runner (Bolt).
 *
 * Env:
 *   SLACK_BOT_TOKEN, SLACK_APP_TOKEN
 *   CHAMBER_DB, CHAMBER_SLACK_APPROVERS, CHAMBER_SLACK_OPS_CHANNEL
 *
 * npm i @slack/bolt   (required)
 */

import {
  openSlackDb,
  gatedSlackTurn,
  handleChamberSlash,
  slackApprove,
  slackReject,
  canSlackApprove,
  registerSlackPendingHook,
} from "./slack_ops.ts";
import { listPendingQueue } from "./approvals.ts";

async function main(): Promise<void> {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
    console.error(
      "Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN (Socket Mode). See deploy/SLACK.md",
    );
    process.exit(1);
  }

  let App: typeof import("@slack/bolt").App;
  try {
    const bolt = await import("@slack/bolt");
    App = bolt.App;
  } catch {
    console.error(
      "Missing dependency: npm install @slack/bolt\nThen: npm run gateway:slack",
    );
    process.exit(1);
  }

  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  const db = openSlackDb();
  registerSlackPendingHook();

  // ── Mentions → gated turn ─────────────────────────────────────────
  app.event("app_mention", async ({ event, say }) => {
    if ((event as { bot_id?: string }).bot_id) return;
    const text = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
    if (!text) return;
    try {
      const reply = gatedSlackTurn(db, text, {
        channelId: event.channel,
        userId: event.user ?? "unknown",
        threadTs: event.thread_ts,
      });
      await say({
        text: reply,
        thread_ts: event.thread_ts ?? event.ts,
      });
    } catch (e) {
      await say({
        text: `Chamber error: ${String(e).slice(0, 200)}`,
        thread_ts: event.thread_ts ?? event.ts,
      });
    }
  });

  // ── DMs ───────────────────────────────────────────────────────────
  app.message(async ({ message, say }) => {
    const m = message as {
      channel_type?: string;
      bot_id?: string;
      subtype?: string;
      text?: string;
      user?: string;
      channel?: string;
      thread_ts?: string;
      ts?: string;
    };
    if (m.channel_type !== "im") return;
    if (m.bot_id || m.subtype) return;
    const text = (m.text ?? "").trim();
    if (!text) return;
    try {
      const reply = gatedSlackTurn(db, text, {
        channelId: m.channel ?? "dm",
        userId: m.user ?? "unknown",
      });
      await say({ text: reply });
    } catch (e) {
      await say({ text: `Chamber error: ${String(e).slice(0, 200)}` });
    }
  });

  // ── Slash /chamber ────────────────────────────────────────────────
  app.command("/chamber", async ({ command, ack, respond, client }) => {
    await ack();
    try {
      const result = handleChamberSlash(db, command.text ?? "", {
        userId: command.user_id,
        channelId: command.channel_id,
      });
      await respond({
        response_type: "ephemeral",
        text: result.ephemeral.slice(0, 3900),
      });
      if (result.publicReply) {
        await client.chat.postMessage({
          channel: command.channel_id,
          text: result.publicReply.slice(0, 3900),
          thread_ts: command.thread_ts,
        });
      }
    } catch (e) {
      await respond({
        response_type: "ephemeral",
        text: `error: ${String(e).slice(0, 200)}`,
      });
    }
  });

  // ── Interactive approve / reject ──────────────────────────────────
  app.action("chamber_approve", async ({ body, action, ack, respond, client }) => {
    await ack();
    const userId = body.user.id;
    const writeId =
      action.type === "button" ? String(action.value ?? "") : "";
    const r = slackApprove(db, writeId, userId);
    await respond({ response_type: "ephemeral", text: r.text });
    if (r.ok && body.channel?.id && (body as { message?: { ts?: string } }).message?.ts) {
      await client.chat.update({
        channel: body.channel.id,
        ts: (body as { message: { ts: string } }).message.ts,
        text: r.text,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `✅ ${r.text} by <@${userId}>` },
          },
        ],
      });
    }
  });

  app.action("chamber_reject", async ({ body, action, ack, respond, client }) => {
    await ack();
    const userId = body.user.id;
    const writeId =
      action.type === "button" ? String(action.value ?? "") : "";
    const r = slackReject(db, writeId, userId);
    await respond({ response_type: "ephemeral", text: r.text });
    if (r.ok && body.channel?.id && (body as { message?: { ts?: string } }).message?.ts) {
      await client.chat.update({
        channel: body.channel.id,
        ts: (body as { message: { ts: string } }).message.ts,
        text: r.text,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `❌ ${r.text} by <@${userId}>` },
          },
        ],
      });
    }
  });

  // ── Optional: post pending cards to ops channel on interval ───────
  const ops = process.env.CHAMBER_SLACK_OPS_CHANNEL;
  if (ops) {
    setInterval(async () => {
      try {
        const pending = listPendingQueue(db, 5);
        // Lightweight: only log count; full cards can be posted on propose via hook later
        if (pending.length && process.env.CHAMBER_SLACK_DEBUG === "1") {
          console.log(`[slack] pending=${pending.length}`);
        }
      } catch {
        /* ignore */
      }
    }, 60_000);
  }

  await app.start();
  console.log(
    `Chamber Slack Socket Mode up (approvers configured=${canSlackApprove("test") || (process.env.CHAMBER_SLACK_APPROVERS ?? "").length > 0})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
