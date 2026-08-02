/**
 * Chamber plugin contract (QM-inspired surfaces).
 * Plugins transport only — authority stays in gated turn.
 */

export interface TurnMeta {
  channel: string;
  scopeId: string;
  chatId?: string;
  userId?: string;
}

export interface PluginContext {
  turn: (text: string, meta: TurnMeta) => Promise<string>;
}

export interface ChamberPlugin {
  name: string;
  start(ctx: PluginContext): Promise<void>;
  stop?(): Promise<void>;
}
