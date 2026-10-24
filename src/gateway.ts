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

/** The most of the Bot API's own text (a description, an error code, curl's stderr) one log line or error carries. */
const MAX_LOGGED_API_TEXT = 300;
/** The most of a body that is not JSON that an error message carries. */
const MAX_NON_JSON_BODY = 200;
/** The longest the poll loop waits between two asks, whatever the backoff or the API says. */
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * How long the poll loop waits after its `failures`th failed round in a row (1
 * is the first): `baseMs`, doubled for each round after the first, and never
 * more than five minutes. When the API said how long to wait (`retryAfterSec`,
 * from a 429's `parameters.retry_after`) that is the wait instead, with the same
 * ceiling.
 */
function telegramRetryDelayMs(baseMs: number, failures: number, retryAfterSec: number | undefined): number {
  const wanted = retryAfterSec !== undefined ? retryAfterSec * 1000 : baseMs * 2 ** Math.min(Math.max(failures, 1) - 1, 30);
  return Math.min(wanted, MAX_RETRY_DELAY_MS);
}

/** `parameters.retry_after` of the API's answer, if it is a positive number of seconds; anything else is no instruction. */
function telegramRetryAfterSec(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null || !("parameters" in data)) return undefined;
  const params = data.parameters;
  if (typeof params !== "object" || params === null || !("retry_after" in params)) return undefined;
  const sec = params.retry_after;
  return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec : undefined;
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
  // Both are cut before they are escaped: the answer can be as long as httpSync reads (4 MiB).
  const code =
    typeof body.error_code === "number"
      ? String(body.error_code)
      : jsonForTerminal(String(body.error_code ?? "none").slice(0, MAX_LOGGED_API_TEXT));
  const why = jsonForTerminal(String(body.description ?? "none").slice(0, MAX_LOGGED_API_TEXT));
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
  /**
   * How long the poll loop waits after its first failed round, an error or a
   * refusal, before it asks again. It doubles for each failed round after that,
   * up to five minutes, and starts over when the API accepts a getUpdates.
   */
  protected retryDelayMs = 3000;
  /** The wait the poll loop is in, so that `stop()` can end it. */
  private sleeping: { timer: ReturnType<typeof setTimeout>; wake: () => void } | undefined;

  constructor(token = process.env.TELEGRAM_BOT_TOKEN ?? "") {
    this.token = token;
  }

  get available(): boolean {
    return !!this.token;
  }

  /** Waits `ms`, or until `stop()`; no wait at all once the gateway is stopped. */
  private sleep(ms: number): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.sleeping = undefined;
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.sleeping = { timer, wake };
    });
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
    // curl's stderr and the body are text from the network, so each goes into an
    // Error message as a JSON string, and the body only as far as 200 characters.
    if (res.exitStatus !== 0) {
      throw new Error(`telegram api failed: ${jsonForTerminal(String(res.stderr || "no message").slice(0, MAX_LOGGED_API_TEXT))}`);
    }
    try {
      return JSON.parse(res.body || "{}");
    } catch {
      // V8's SyntaxError message quotes the start of the body as it is, so it is dropped.
      throw new Error(`telegram api returned non-JSON: ${jsonForTerminal(String(res.body).slice(0, MAX_NON_JSON_BODY))}`);
    }
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
    // Failed rounds (a refusal, or an error) since the API last accepted a getUpdates.
    let failures = 0;
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
          failures += 1;
          await this.sleep(telegramRetryDelayMs(this.retryDelayMs, failures, telegramRetryAfterSec(data)));
          continue;
        }
        failures = 0;
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
        failures += 1;
        // Whatever was thrown (this loop also runs the turn) is printed as a JSON
        // string and not as the Error, whose message can carry text from the network.
        const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        console.error(`telegram poll error ${jsonForTerminal(what)}`);
        await this.sleep(telegramRetryDelayMs(this.retryDelayMs, failures, undefined));
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    // A loop that is waiting out a backoff of minutes would otherwise hold the process.
    this.sleeping?.wake();
  }
}

export function createGatewayFromEnv(): GatewayAdapter {
  if (process.env.TELEGRAM_BOT_TOKEN) return new TelegramGateway();
  return new ConsoleGateway();
}
