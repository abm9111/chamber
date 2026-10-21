/**
 * The main thread's side of the `/turn` worker: one long-lived thread, one job
 * at a time.
 *
 * `run()` posts the message and resolves with the worker's reply. The worker is
 * started on first use, handles jobs in the order they arrive (its message
 * handler is synchronous, so the port's queue is the queue), and is restarted on
 * the next `run()` if it ever dies. Anything that was in flight when it died
 * fails with an error, and so does anything queued behind it: whether a turn
 * that was mid-flight committed is not knowable from here, so none is retried.
 *
 * The worker file is a parameter so the tests can drive this class with a
 * worker that crashes on purpose. The protocol types live in `src/turn.ts` and
 * are imported as types only, so this module loads nothing of the turn itself.
 */

import { Worker } from "node:worker_threads";
import type { TurnJob, TurnReply } from "./turn.ts";

/** A failure reported by the worker. The chain and stack are the worker's own text. */
export class TurnWorkerError extends Error {
  readonly chain: string[];

  constructor(chain: string[], stack: string) {
    super(chain[0] ?? "turn failed");
    this.name = "TurnWorkerError";
    this.chain = chain;
    if (stack !== "") this.stack = stack;
  }
}

interface InFlight {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

export class TurnPool {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly inFlight = new Map<number, InFlight>();
  private readonly entry: URL;
  private readonly dbPath: string;

  /** `entry` is the worker module; `dbPath` is handed to it as `workerData.dbPath`. */
  constructor(entry: URL, dbPath: string) {
    this.entry = entry;
    this.dbPath = dbPath;
  }

  run(message: string): Promise<Record<string, unknown>> {
    const worker = this.worker ?? this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.inFlight.set(id, { resolve, reject });
      const job: TurnJob = { id, message };
      worker.postMessage(job);
    });
  }

  /** Stop the worker. Anything still in flight fails. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failAll(new Error("turn worker closed"));
    if (worker) await worker.terminate();
  }

  private start(): Worker {
    const worker = new Worker(this.entry, { workerData: { dbPath: this.dbPath } });
    worker.on("message", (reply: TurnReply) => {
      const job = this.inFlight.get(reply.id);
      if (!job) return;
      this.inFlight.delete(reply.id);
      if (reply.ok) job.resolve(reply.result);
      else job.reject(new TurnWorkerError(reply.chain, reply.stack));
    });
    // An uncaught exception in the worker: 'error', then 'exit'. Forget the
    // worker at the first of them, so a request that arrives in between starts a
    // new one instead of posting to a thread that is going away.
    worker.on("error", (err) => {
      if (this.worker === worker) this.worker = null;
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      void worker.terminate();
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.worker = null;
      this.failAll(new Error(`turn worker exited (code ${code}) before answering`));
    });
    this.worker = worker;
    return worker;
  }

  private failAll(reason: Error): void {
    const jobs = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const job of jobs) job.reject(reason);
  }
}
