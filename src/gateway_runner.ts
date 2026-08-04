/**
 * Unified gateway runner — Telegram / Discord / Slack / console.
 * Every inbound message runs through a provided turn handler (Chamber gates).
 *
 *   TELEGRAM_BOT_TOKEN=... node --experimental-strip-types src/gateway_runner.ts
 *
 * The database is whichever one Chamber's settings name (CHAMBER_DB, then the
 * config file, then the durable default) — see `openConfiguredDb` in src/db.ts.
 */

import type { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openConfiguredDb } from "./db.ts";
import {
  type GatewayAdapter,
  type InboundMessage,
  ConsoleGateway,
  TelegramGateway,
} from "./gateway.ts";
import { startSession, appendMessage } from "./sessions.ts";
import { completeSync } from "./model.ts";
import { enforceReplyContract } from "./contract.ts";
import { commitBelief } from "./commit_belief.ts";
import { recordSpend, spendLastHours, formatSpendFooter } from "./spend.ts";
import { appendAudit } from "./audit.ts";
import { runExpiryJob } from "./expiry.ts";
import { profileContext } from "./profiles.ts";
import { matchSkills } from "./skills_registry.ts";
import { sha256, newId } from "./hash.ts";
import { spawnSync } from "node:child_process";

class DiscordGateway implements GatewayAdapter {
  name = "discord" as const;
  private token: string;
  constructor(token = process.env.DISCORD_BOT_TOKEN ?? "") {
    this.token = token;
  }
  get available() {
    return !!this.token;
  }
  async start(onMessage: (msg: InboundMessage) => Promise<string>): Promise<void> {
    if (!this.available) {
      console.log("Discord gateway: DISCORD_BOT_TOKEN not set — disabled");
      return;
    }
    // Minimal long-poll alternative: gateway WebSocket is complex; use interactions webhook mode note
    console.log(
      "Discord gateway: use `npm run gateway:discord` (discord.js runner) instead of this stub.",
    );
    console.log(
      "Stub: posting to channel requires REST; inbound via webhook not in this process.",
    );
    // Keep process alive for compose demos
    await new Promise(() => {});
  }
  async send(msg: { channel: "discord"; chatId: string; text: string }): Promise<void> {
    if (!this.token) return;
    spawnSync(
      "curl",
      [
        "-s",
        "-X",
        "POST",
        `https://discord.com/api/v10/channels/${msg.chatId}/messages`,
        "-H",
        `Authorization: Bot ${this.token}`,
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify({ content: msg.text.slice(0, 1900) }),
      ],
      { encoding: "utf-8" },
    );
  }
}

class SlackGateway implements GatewayAdapter {
  name = "slack" as const;
  private token: string;
  constructor(token = process.env.SLACK_BOT_TOKEN ?? "") {
    this.token = token;
  }
  get available() {
    return !!this.token;
  }
  async start(onMessage: (msg: InboundMessage) => Promise<string>): Promise<void> {
    if (!this.available) {
      console.log("Slack gateway: SLACK_BOT_TOKEN not set — disabled");
      return;
    }
    console.log(
      "Slack gateway: use `npm run gateway:slack` (Socket Mode Bolt runner) instead of this stub.",
    );
    return;
  }
  async send(msg: { channel: "slack"; chatId: string; text: string }): Promise<void> {
    if (!this.token) return;
    spawnSync(
      "curl",
      [
        "-s",
        "-X",
        "POST",
        "https://slack.com/api/chat.postMessage",
        "-H",
        `Authorization: Bearer ${this.token}`,
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify({ channel: msg.chatId, text: msg.text.slice(0, 3900) }),
      ],
      { encoding: "utf-8" },
    );
  }
}

/**
 * The database this runner writes to.
 *
 * Extracted from `gatedTurn` so it can be exercised without starting a
 * gateway: `gatedTurn` reaches the network on its second line, so a test that
 * wants to know *which file the rows land in* could not get at it otherwise.
 */
export function openGatewayDb(): DatabaseSync {
  return openConfiguredDb();
}

function gatedTurn(message: string, channel: string, chatId: string): string {
  const db = openGatewayDb();
  runExpiryJob(db);
  const turnId = newId("trn");
  const sessionId = startSession(db, {
    channel: channel as "telegram" | "cli" | "http",
    title: `${channel}:${chatId}`,
  });
  appendMessage(db, sessionId, "user", message, turnId);

  appendAudit(db, {
    category: "session",
    action: "turn_start",
    actor: "human",
    turnId,
    sessionId,
    detail: { channel, chatId, message: message.slice(0, 200) },
  });

  commitBelief(db, {
    type: "observation",
    text: `user said: ${message.slice(0, 240)}`,
    sources: [
      {
        kind: "transcript",
        refId: turnId,
        snapshotHash: sha256(message),
        provenance: "transcript",
      },
    ],
    authorFamily: channel,
    sessionId,
    path: "fast",
    turnId,
  });

  const skills = matchSkills(db, message);
  const profiles = profileContext(db);
  const system = [
    "You are Chamber. Prefer observations over assertions. Mark uncertainty.",
    profiles ? `Profiles:\n${profiles}` : "",
    skills.length
      ? `Matched skills (pending execution authority): ${skills.map((s) => s.name).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const completion = completeSync(db, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: message },
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
  const footer = [
    completion.text,
    "",
    spend,
    contract.results.some((r) => r.status === "DEBT" || r.status === "REFUSED")
      ? `(contract: ${contract.results.map((r) => r.status).join(",")})`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  appendAudit(db, {
    category: "session",
    action: "turn_end",
    actor: "system",
    turnId,
    sessionId,
  });

  return footer;
}

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? process.env.CHAMBER_GATEWAY ?? "auto").toLowerCase();
  const adapters: GatewayAdapter[] = [];

  if (mode === "telegram" || mode === "auto") {
    const tg = new TelegramGateway();
    if (tg.available || mode === "telegram") adapters.push(tg);
  }
  if (mode === "discord" || mode === "auto") {
    const d = new DiscordGateway();
    if (d.available || mode === "discord") adapters.push(d);
  }
  if (mode === "slack" || mode === "auto") {
    const s = new SlackGateway();
    if (s.available || mode === "slack") adapters.push(s);
  }
  if (mode === "console" || adapters.length === 0) {
    adapters.push(new ConsoleGateway());
    console.log("No messenger tokens — console gateway only.");
    console.log("Set TELEGRAM_BOT_TOKEN / DISCORD_BOT_TOKEN / SLACK_BOT_TOKEN");
    return;
  }

  console.log(
    `Chamber gateway starting: ${adapters.map((a) => a.name).join(", ")}`,
  );

  await Promise.all(
    adapters.map((adapter) =>
      adapter.start(async (msg) => {
        try {
          return gatedTurn(msg.text, msg.channel, msg.chatId);
        } catch (e) {
          return `Chamber error: ${String(e).slice(0, 200)}`;
        }
      }),
    ),
  );
}

/**
 * Whether this file is the program being run, rather than a module someone
 * imported.
 *
 * `main()` used to be called unconditionally at module scope, so *importing*
 * this file started a daemon: with TELEGRAM_BOT_TOKEN set in the environment —
 * which is the normal state on a machine that runs the gateway — an `import`
 * from a test or a tool opened a real long-poll against Telegram. That made
 * the one line in here worth testing (which database `gatedTurn` writes to)
 * untestable, because reaching it meant launching the thing.
 *
 * `process.argv[1]` is the script node was pointed at. Compared through
 * `realpathSync` so a symlinked entry point still matches — `chamber` is
 * installed as a symlink into the working tree, and the same is possible here.
 * `import.meta.main` would say this more directly but only on Node 24.2+, and
 * package.json still declares `>=23.6`, where it is `undefined` — which would
 * make the runner silently do nothing rather than fail. argv works everywhere.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  if (entry === self) return true;
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
