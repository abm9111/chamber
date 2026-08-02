/**
 * Telegram plugin — inbound messages → gated turn only.
 */

import type { ChamberPlugin, PluginContext } from "./types.ts";
import { TelegramGateway } from "../gateway.ts";

export function createTelegramPlugin(): ChamberPlugin {
  const gw = new TelegramGateway();
  return {
    name: "telegram",
    async start(ctx: PluginContext): Promise<void> {
      if (!gw.available) {
        console.log("[plugin:telegram] TELEGRAM_BOT_TOKEN not set — disabled");
        return;
      }
      await gw.start(async (msg) => {
        const scopeId =
          process.env.CHAMBER_SCOPE ??
          `tg_${msg.chatId}`;
        return ctx.turn(msg.text, {
          channel: "telegram",
          scopeId,
          chatId: msg.chatId,
          userId: msg.userId,
        });
      });
    },
    async stop() {
      await gw.stop?.();
    },
  };
}
