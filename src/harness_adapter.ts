/**
 * Swappable model harness interface (QM-inspired).
 * All completions still flow through spend metering at the call site.
 */

import type { DatabaseSync } from "node:sqlite";
import { completeSync, type CompleteInput, type CompleteResult } from "./model.ts";

export interface ModelHarness {
  id: string;
  complete(db: DatabaseSync, req: CompleteInput): CompleteResult;
}

/** Default: existing stub / local completeSync */
export const stubHarness: ModelHarness = {
  id: "stub-local",
  complete(db, req) {
    return completeSync(db, req);
  },
};

const registry = new Map<string, ModelHarness>([["stub-local", stubHarness]]);

export function registerHarness(h: ModelHarness): void {
  registry.set(h.id, h);
}

export function getHarness(id?: string): ModelHarness {
  const want = id ?? process.env.CHAMBER_HARNESS ?? "stub-local";
  const found = registry.get(want);
  if (!found) {
    throw new Error(
      `unknown harness "${want}" (registered: ${[...registry.keys()].join(", ")})`,
    );
  }
  return found;
}

export function listHarnesses(): string[] {
  return [...registry.keys()];
}
