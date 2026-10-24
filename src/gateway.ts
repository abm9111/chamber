/**
 * Messaging gateway interface (Hermes multi-platform analog).
 * Built-in: console adapter. Telegram optional when TELEGRAM_BOT_TOKEN set.
 *
 * All inbound messages must enter Chamber via the same gated turn path —
 * gateway only transports; it does not bypass debt/approvals/faculty.
 */

import { httpSync } from "./http_sync.ts";
import { jsonForTerminal } from "./terminal_text.ts";

export type GatewayChannel =
  | "cli"
  | "http"
  | "telegram"
  | "discord"
  | "slack"
  | "whatsapp"
  | "other";

export interface InboundMessage {
  channel: GatewayChannel;
  chatId: string;
  userId?: string;
  text: string;
  messageId?: string;
}

export interface OutboundMessage {
  channel: GatewayChannel;
  chatId: string;
  text: string;
}

export interface GatewayAdapter {
  name: GatewayChannel;
  start(onMessage: (msg: InboundMessage) => Promise<string>): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  stop?(): Promise<void>;
}

/** Console adapter for local demos */
export class ConsoleGateway implements GatewayAdapter {
  name: GatewayChannel = "cli";
  async start(): Promise<void> {
    /* CLI owns the loop */
  }
  async send(msg: OutboundMessage): Promise<void> {
    console.log(`[gateway:${msg.channel}] → ${msg.chatId}: ${msg.text.slice(0, 500)}`);
  }
}

/** What a sender who is not on `CHAMBER_TELEGRAM_ALLOWED_USERS` is told, in a private chat. */
export const TELEGRAM_TALK_REFUSAL = "You are not on CHAMBER_TELEGRAM_ALLOWED_USERS.";

/** The numeric user ids in `CHAMBER_TELEGRAM_ALLOWED_USERS`: a comma list, entries trimmed, blanks dropped. */
export function telegramTalkAllowlist(): Set<string> {
  return new Set(
    (process.env.CHAMBER_TELEGRAM_ALLOWED_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Who may talk to the bot. Fail-closed, like the Discord and Slack lists: an
 * empty allowlist means nobody, and a message with no sender (a channel post)
 * is nobody's. The gateway had no talk gate at all, so anyone who found the
 * bot's handle could drive a turn, spend the model budget and write
 * observations into the ledger.
 */
export function canTelegramTalk(userId: string | undefined): boolean {
  return userId !== undefined && telegramTalkAllowlist().has(userId);
}

/**
 * Whether the Bot API accepted `method`. The API answers a refusal (401 for a
 * revoked token, 409 for a second poller, 429 for a rate limit, 403 for a blocked
 * bot) as a parsed `{ok:false,error_code,description}`, which `api` returns like
 * any other body: nothing throws. When it did not say `ok: true`, one line says
 * what it answered and this returns false. The code and the description are
 * the API's text, so they are printed as JSON strings.
 */
function telegramAnswered(method: string, data: unknown): boolean {
  const body: { ok?: unknown; error_code?: unknown; description?: unknown } =
    typeof data === "object" && data !== null ? data : {};
  if (body.ok === true) return true;
  // A number is digits; anything else the API sent in its place is escaped like the description.
  const code = typeof body.error_code === "number" ? String(body.error_code) : jsonForTerminal(String(body.error_code ?? "none"));
  const why = jsonForTerminal(String(body.description ?? "none"));
  console.error(`telegram ${method} refused: error_code ${code}, description ${why}`);
  return false;
}

/**
 * Telegram long-poll adapter (optional).
 * Requires TELEGRAM_BOT_TOKEN. Soft-no-op if missing.
 * Only senders on `CHAMBER_TELEGRAM_ALLOWED_USERS` reach `onMessage`.
 */
export class TelegramGateway implements GatewayAdapter {
  name: GatewayChannel = "telegram";
  private token: string;
  private offset = 0;
  private running = false;
  /** How long the poll loop waits after an error or a refusal before it asks again. */
  protected retryDelayMs = 3000;

  constructor(token = process.env.TELEGRAM_BOT_TOKEN ?? "") {
    this.token = token;
  }

  get available(): boolean {
    return !!this.token;
  }

  protected api(method: string, body?: Record<string, unknown>): unknown {
    if (!this.token) throw new Error("TELEGRAM_BOT_TOKEN not set");
    // The bot token is part of the URL path, which is why this goes through
    // `httpSync`: the URL is on curl's stdin, not on its command line.
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const res = httpSync({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      timeoutSec: 35,
      maxBytes: 4 * 1024 * 1024,
    });
    if (res.exitStatus !== 0) {
      throw new Error(String(res.stderr || "telegram api failed"));
    }
    return JSON.parse(res.body || "{}");
  }

  async send(msg: OutboundMessage): Promise<void> {
    // A refused send is logged and does not throw: the poll loop would only
    // catch it, wait and ask again, with the offset already moved past the update.
    telegramAnswered(
      "sendMessage",
      this.api("sendMessage", {
        chat_id: msg.chatId,
        text: msg.text.slice(0, 4000),
      }),
    );
  }

  async start(onMessage: (msg: InboundMessage) => Promise<string>): Promise<void> {
    if (!this.available) {
      console.log("Telegram gateway: TELEGRAM_BOT_TOKEN not set — disabled");
      return;
    }
    if (telegramTalkAllowlist().size === 0) {
      console.warn("chamber: CHAMBER_TELEGRAM_ALLOWED_USERS is empty, so nobody can talk to this bot");
    }
    this.running = true;
    console.log("Telegram gateway: long-poll started");
    while (this.running) {
      try {
        const data = this.api("getUpdates", {
          offset: this.offset,
          timeout: 25,
        }) as {
          ok?: boolean;
          result?: {
            update_id: number;
            message?: {
              message_id: number;
              text?: string;
              chat: { id: number; type?: string };
              from?: { id: number };
            };
          }[];
        };
        // `{ok:false}` has no `result`, so without this check the loop would run
        // again at once, one curl spawn after another, and never reach the catch.
        if (!telegramAnswered("getUpdates", data)) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
          continue;
        }
        for (const u of data.result ?? []) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m?.text) continue;
          const userId = m.from ? String(m.from.id) : undefined;
          // Before onMessage: that callback is the gated turn, which writes an
          // observation before it replies.
          if (!canTelegramTalk(userId)) {
            // Told only in a private chat; in a group the refusal would answer
            // every member who is not listed.
            if (m.chat.type === "private") {
              await this.send({ channel: "telegram", chatId: String(m.chat.id), text: TELEGRAM_TALK_REFUSAL });
            }
            continue;
          }
          const reply = await onMessage({
            channel: "telegram",
            chatId: String(m.chat.id),
            userId,
            text: m.text,
            messageId: String(m.message_id),
          });
          await this.send({
            channel: "telegram",
            chatId: String(m.chat.id),
            text: reply,
          });
        }
      } catch (e) {
        console.error("telegram poll error", e);
        await new Promise((r) => setTimeout(r, this.retryDelayMs));
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }
}

export function createGatewayFromEnv(): GatewayAdapter {
  if (process.env.TELEGRAM_BOT_TOKEN) return new TelegramGateway();
  return new ConsoleGateway();
}
