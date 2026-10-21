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
  /** The worker's database call failed because another connection held the write lock. */
  readonly busy: boolean;

  constructor(chain: string[], stack: string, busy: boolean = false) {
    super(chain[0] ?? "turn failed");
    this.name = "TurnWorkerError";
    this.chain = chain;
    this.busy = busy;
    if (stack !== "") this.stack = stack;
  }
}

interface InFlight {
  /** The worker instance this job was posted to. Only its events may fail the job. */
  owner: Worker;
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
      this.inFlight.set(id, { owner: worker, resolve, reject });
      const job: TurnJob = { id, message };
      worker.postMessage(job);
    });
  }

  /** Stop the worker. Anything still in flight fails. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failJobsOf(null, new Error("turn worker closed"));
    if (worker) await worker.terminate();
  }

  private start(): Worker {
    const worker = new Worker(this.entry, { workerData: { dbPath: this.dbPath } });
    worker.on("message", (reply: TurnReply) => {
      const job = this.inFlight.get(reply.id);
      if (!job) return;
      this.inFlight.delete(reply.id);
      if (reply.ok) job.resolve(reply.result);
      else job.reject(new TurnWorkerError(reply.chain, reply.stack, reply.busy === true));
    });
    // An uncaught exception in the worker: 'error', then 'exit'. Forget the
    // worker at the first of them, so a request that arrives in between starts a
    // new one instead of posting to a thread that is going away.
    worker.on("error", (err) => {
      if (this.worker === worker) this.worker = null;
      this.failJobsOf(worker, err instanceof Error ? err : new Error(String(err)));
      void worker.terminate();
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.worker = null;
      this.failJobsOf(worker, new Error(`turn worker exited (code ${code}) before answering`));
    });
    this.worker = worker;
    return worker;
  }

  /**
   * Fail the jobs posted to `owner`, or every job when `owner` is null (close).
   *
   * A dead worker's 'exit' can arrive after the pool has already started its
   * replacement and posted a job to it. That event must fail only the jobs that
   * belong to the thread that died.
   */
  private failJobsOf(owner: Worker | null, reason: Error): void {
    for (const [id, job] of [...this.inFlight]) {
      if (owner !== null && job.owner !== owner) continue;
      this.inFlight.delete(id);
      job.reject(reason);
    }
  }
}
