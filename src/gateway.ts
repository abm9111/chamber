/**
 * Messaging gateway interface (Hermes multi-platform analog).
 * Built-in: console adapter. Telegram optional when TELEGRAM_BOT_TOKEN set.
 *
 * All inbound messages must enter Chamber via the same gated turn path —
 * gateway only transports; it does not bypass debt/approvals/faculty.
 */

import { spawnSync } from "node:child_process";

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

/**
 * Telegram long-poll adapter (optional).
 * Requires TELEGRAM_BOT_TOKEN. Soft-no-op if missing.
 */
export class TelegramGateway implements GatewayAdapter {
  name: GatewayChannel = "telegram";
  private token: string;
  private offset = 0;
  private running = false;

  constructor(token = process.env.TELEGRAM_BOT_TOKEN ?? "") {
    this.token = token;
  }

  get available(): boolean {
    return !!this.token;
  }

  private api(method: string, body?: Record<string, unknown>): unknown {
    if (!this.token) throw new Error("TELEGRAM_BOT_TOKEN not set");
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const res = spawnSync(
      "curl",
      [
        "-s",
        "-m",
        "35",
        "-X",
        "POST",
        url,
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify(body ?? {}),
      ],
      { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 },
    );
    if (res.status !== 0) {
      throw new Error(String(res.stderr || "telegram api failed"));
    }
    return JSON.parse(res.stdout || "{}");
  }

  async send(msg: OutboundMessage): Promise<void> {
    this.api("sendMessage", {
      chat_id: msg.chatId,
      text: msg.text.slice(0, 4000),
    });
  }

  async start(onMessage: (msg: InboundMessage) => Promise<string>): Promise<void> {
    if (!this.available) {
      console.log("Telegram gateway: TELEGRAM_BOT_TOKEN not set — disabled");
      return;
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
              chat: { id: number };
              from?: { id: number };
            };
          }[];
        };
        for (const u of data.result ?? []) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m?.text) continue;
          const reply = await onMessage({
            channel: "telegram",
            chatId: String(m.chat.id),
            userId: m.from ? String(m.from.id) : undefined,
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
        await new Promise((r) => setTimeout(r, 3000));
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
