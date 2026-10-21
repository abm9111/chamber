/**
 * Worker-thread entry point for `POST /turn`. Started by `src/turn_pool.ts`.
 *
 * It opens its own connection to the server's database file (`workerData.dbPath`,
 * the path the server actually opened, after any redirect) and answers `TurnJob`
 * messages one at a time with `runTurn`. The paraphrase check and the write stay
 * in one `BEGIN IMMEDIATE` inside `commitBelief`, on this thread (FM-6); nothing
 * about that changes, only which thread waits for the embedder.
 *
 * What it has to set up for itself, because a thread shares nothing with the
 * main thread but the environment (copied when the thread starts):
 *  - the pending-write hook: `proposeWrite` runs here now, and a listener
 *    registered on the main thread never sees it;
 *  - the model and embedder settings: the server never calls `applyModelEnv`,
 *    so it runs on `process.env` alone, and so does this thread.
 * Spend and the approval queue are rows in the database, so both connections
 * share them. The `/turn` rate-limit bucket is in memory and lives here, for as
 * long as this thread does.
 */

import { parentPort, workerData } from "node:worker_threads";
import { openChamberDb } from "./db.ts";
import { formatErrorChain } from "./error_chain.ts";
import { registerSlackPendingHook } from "./slack_ops.ts";
import { runTurn, type TurnJob, type TurnReply } from "./turn.ts";

if (parentPort === null) {
  throw new Error("turn_worker.ts is a worker-thread entry point; it cannot be run directly");
}
const port = parentPort;
const { dbPath } = workerData as { dbPath: string };

try {
  registerSlackPendingHook();
} catch {
  /* slack optional */
}
const db = openChamberDb(dbPath);

port.on("message", (job: TurnJob) => {
  let reply: TurnReply;
  try {
    // Through JSON, so what crosses the thread is exactly what the HTTP reply
    // would have carried, and nothing that cannot be cloned.
    const result = JSON.parse(JSON.stringify(runTurn(db, job.message))) as Record<string, unknown>;
    reply = { id: job.id, ok: true, result };
  } catch (err) {
    reply = {
      id: job.id,
      ok: false,
      chain: formatErrorChain(err),
      stack: err instanceof Error && err.stack ? err.stack : "",
    };
  }
  port.postMessage(reply);
});
