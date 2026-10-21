/**
 * One `POST /turn`, as a function of a database and a message.
 *
 * Lived in `src/server.ts` and ran on the event loop. A turn that reaches the
 * paraphrase check holds `BEGIN IMMEDIATE` across a Python embedding spawn (that
 * is FM-6 and it stays), so on the main thread it froze every other route for
 * as long as the embedder took: `/health` included, which is what a load
 * balancer reads. It now runs in `src/turn_worker.ts`, on its own connection to
 * the same database file, and this module is the part both threads share.
 *
 * The wire types are here, and not in the worker or the pool, so the pool can
 * import them as types without ever loading this module's dependencies.
 */

import type { DatabaseSync } from "node:sqlite";
import { sha256, newId } from "./hash.ts";
import { commitBelief } from "./commit_belief.ts";
import { completeSync, syncCompletionAvailable } from "./model.ts";
import { enforceReplyContract } from "./contract.ts";
import { runExpiryJob } from "./expiry.ts";
import { spendLastHours, formatSpendFooter, assertSpendBudget } from "./spend.ts";
import { proposeWrite, listPendingQueue, expireStalePending } from "./approvals.ts";
import { evaluateWorkflows } from "./approval_workflows.ts";
import { appendAudit } from "./audit.ts";
import { listOpenDebts } from "./debt.ts";
import { startSession, appendMessage } from "./sessions.ts";
import {
  quarantineUntrustedText,
  stripInvisibleNoise,
  checkRateLimit,
  surfaceRateKey,
} from "./surface_harden.ts";

/** Main thread to worker: run this message. */
export interface TurnJob {
  id: number;
  message: string;
}

/** Worker to main thread. A failure carries the error chain and stack as text, which survive a thread boundary. */
export type TurnReply =
  | { id: number; ok: true; result: Record<string, unknown> }
  | { id: number; ok: false; chain: string[]; stack: string; busy?: boolean };

/**
 * Did SQLite refuse because another connection holds the write lock?
 *
 * Decided from the error's `errcode`, never its message text. node:sqlite sets
 * `code` to the constant `ERR_SQLITE_ERROR` for every failure and puts SQLite's
 * own result code in `errcode`; `SQLITE_BUSY` is 5, and its extended forms
 * (`SQLITE_BUSY_RECOVERY` 261, `SQLITE_BUSY_SNAPSHOT` 517) keep 5 in the low
 * byte. `SQLITE_LOCKED` (6) is a different condition and is not busy. A `cause`
 * is followed in case a caller wrapped the error.
 */
export function isSqliteBusy(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const errcode = (current as { errcode?: unknown }).errcode;
    if (typeof errcode === "number" && (errcode & 0xff) === 5) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function runTurn(db: DatabaseSync, message: string): Record<string, unknown> {
  // Asked before anything is written. Every one of these surfaces commits an
  // observation, opens a session and writes audit rows before it reaches
  // completeSync, which refuses the openai mode by design — so the ledger gained
  // rows and the caller gained an exception, in that order. Guarding only the
  // CLI left four other surfaces reproducing the exact defect the guard was
  // written to remove.
  const model = syncCompletionAvailable();
  if (!model.ok) throw new Error(`turn unavailable: ${model.reason}`);

  const budget = assertSpendBudget(db);
  if (!budget.ok) {
    return {
      ok: false,
      error: budget.reason,
      spend: formatSpendFooter(budget.report),
    };
  }
  const rate = checkRateLimit(surfaceRateKey("http", "http", "turn"));
  if (!rate.ok) {
    return {
      ok: false,
      error: `Rate limited. Retry in ~${Math.ceil((rate.retryAfterMs ?? 60000) / 1000)}s.`,
    };
  }
  const cleaned = stripInvisibleNoise(message);
  const turnId = newId("trn");
  const sessionId = startSession(db, { channel: "http", title: cleaned.slice(0, 48) });
  appendMessage(db, sessionId, "user", cleaned, turnId);
  runExpiryJob(db);

  appendAudit(db, {
    category: "session",
    action: "turn_start",
    actor: "human",
    turnId,
    sessionId,
    detail: { message: cleaned.slice(0, 200) },
  });

  const obs = commitBelief(db, {
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
    authorFamily: "http",
    sessionId,
    path: "fast",
    turnId,
  });

  const wantsBelief =
    /\b(believe|note that)\b/i.test(cleaned) || /\b(fact|commit)\s*:/i.test(cleaned);
  let belief: unknown = null;
  if (wantsBelief) {
    const claim =
      cleaned.replace(/^.*\b(believe|fact:|commit:)\s*/i, "").trim() || cleaned;
    belief = commitBelief(db, {
      type: "belief",
      text: claim,
      sources: [],
      authorFamily: "http",
      sessionId,
      path: "deep",
      turnId,
    });
  }

  if (/\b(remember|prefer)\b/i.test(message)) {
    const q = proposeWrite(db, {
      target: "memory",
      action: "add",
      subject: "user_preference",
      payload: { stakes: "routine", text: message.slice(0, 300) },
      origin: "foreground",
      authorFamily: "http",
      reason: "http turn preference",
    });
    if (q.status === "queued") evaluateWorkflows(db, q.writeId);
  }

  const completion = completeSync(db, {
    messages: [
      {
        role: "system",
        content:
          "You are Chamber. Prefer observations over assertions. Mark uncertainty explicitly.",
      },
      { role: "user", content: quarantineUntrustedText(cleaned, "http") },
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

  appendAudit(db, {
    category: "session",
    action: "turn_end",
    actor: "system",
    turnId,
    sessionId,
  });

  const spend = spendLastHours(db, 24);
  expireStalePending(db);

  appendMessage(db, sessionId, "assistant", completion.text, turnId);

  return {
    turnId,
    sessionId,
    observation: obs,
    belief,
    assistant: completion.text,
    model: completion.model,
    contract: contract.results.map((r, i) => ({
      claim: contract.claims[i]?.kind,
      status: r.status,
      reason: r.reason,
    })),
    spend: formatSpendFooter(spend),
    queue: listPendingQueue(db, 10),
    debts: listOpenDebts(db, 10),
  };
}
