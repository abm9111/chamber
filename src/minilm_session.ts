import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { minilmServeCommand, noteMinilmStderr } from "./embedder.ts";

const REPLY_LIMIT = 64 * 1024 * 1024;
const SEND_TIMEOUT_MS = 180_000;
const STOP_WAIT_MS = 2_000;
const ROUNDTRIP_MS = 10_000;

export interface MinilmSession {
  send(payload: string): number[][];
  stop(): void;
  close(): void;
  cleanupError: Error | undefined;
}

interface WorkerReply {
  ok?: boolean;
  vectors?: number[][];
  stderr?: string;
  status?: number | null;
  alive?: boolean;
  error?: string;
  gone?: boolean;
}

const WORKER_SOURCE = String.raw`
"use strict";
const { parentPort } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const REPLY_LIMIT = ${REPLY_LIMIT};
const STOP_WAIT_MS = ${STOP_WAIT_MS};
let port = null;
let flag = null;
let pidSlot = null;
let child = null;
let stdout = "";
let stderrPending = "";
let requestOpen = false;
let settled = false;
let pendingVectors = null;

function reply(message) {
  message.stderr = (message.stderr || "") + stderrPending;
  stderrPending = "";
  port.postMessage(message);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0, 1);
}

function waitExit(target, ms) {
  return new Promise((resolve) => {
    if (target.exitCode !== null || target.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    target.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function finishRequest(message) {
  if (settled || !requestOpen) return;
  settled = true;
  requestOpen = false;
  pendingVectors = null;
  reply(message);
}

function detachChild(target) {
  if (child === target) {
    child = null;
    Atomics.store(pidSlot, 0, 0);
  }
}

function killChild(target) {
  try {
    target.kill("SIGKILL");
  } catch (err) {}
  detachChild(target);
}

function bind(target) {
  child = target;
  Atomics.store(pidSlot, 0, target.pid || 0);
  target.stdout.setEncoding("utf8");
  target.stderr.setEncoding("utf8");
  target.stdin.on("error", () => {});
  target.stdout.on("data", (chunk) => {
    if (stdout.length + chunk.length > REPLY_LIMIT) {
      killChild(target);
      stderrPending += "reply longer than 64 MiB";
      finishRequest({ ok: false, status: null });
      return;
    }
    stdout += chunk;
    const nl = stdout.indexOf("\n");
    if (nl < 0 || settled) return;
    const line = stdout.slice(0, nl);
    stdout = stdout.slice(nl + 1);
    let vectors;
    try {
      vectors = JSON.parse(line);
    } catch (err) {
      killChild(target);
      stderrPending += "embed_minilm: expected a JSON array of vectors";
      finishRequest({ ok: false, status: null });
      return;
    }
    if (!Array.isArray(vectors)) {
      killChild(target);
      stderrPending += "embed_minilm: expected a JSON array of vectors";
      finishRequest({ ok: false, status: null });
      return;
    }
    pendingVectors = vectors;
    setImmediate(() => {
      if (settled || !requestOpen) return;
      const alive = child === target && target.exitCode === null && target.signalCode === null;
      finishRequest({ ok: true, vectors, alive });
    });
  });
  target.stderr.on("data", (chunk) => {
    stderrPending += chunk;
  });
  target.on("exit", (code) => {
    detachChild(target);
    setImmediate(() => {
      if (!requestOpen || settled) return;
      if (pendingVectors) {
        finishRequest({ ok: true, vectors: pendingVectors, alive: false, status: code });
        return;
      }
      finishRequest({ ok: false, status: code, gone: code === 0 });
    });
  });
  target.on("error", (err) => {
    detachChild(target);
    stderrPending += String(err);
    if (requestOpen) finishRequest({ ok: false, status: null });
  });
}

async function stopChild() {
  if (!child) return;
  const target = child;
  try { target.kill("SIGTERM"); } catch (err) {}
  let gone = await waitExit(target, STOP_WAIT_MS);
  if (!gone) {
    try { target.kill("SIGKILL"); } catch (err) {}
    await waitExit(target, STOP_WAIT_MS);
  }
  if (child === target) {
    child = null;
    Atomics.store(pidSlot, 0, 0);
  }
}

async function closeChild() {
  if (!child) return;
  const target = child;
  try { target.stdin.end(); } catch (err) {}
  let gone = await waitExit(target, STOP_WAIT_MS);
  if (!gone) {
    try { target.kill("SIGKILL"); } catch (err) {}
    gone = await waitExit(target, STOP_WAIT_MS);
  }
  if (child === target) {
    child = null;
    Atomics.store(pidSlot, 0, 0);
  }
  if (!gone) throw new Error("embed_minilm: child did not exit");
}

parentPort.on("message", (msg) => {
  if (msg.port) {
    port = msg.port;
    flag = new Int32Array(msg.shared, 0, 1);
    pidSlot = new Int32Array(msg.shared, 4, 1);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0, 1);
    return;
  }
  if (msg.op === "start") {
    try {
      if (child) {
        if (
          !child.killed &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          reply({ ok: true, alive: true });
          return;
        }
        detachChild(child);
      }
      stdout = "";
      settled = false;
      pendingVectors = null;
      requestOpen = false;
      let startReplied = false;
      const replyStart = (message) => {
        if (startReplied) return;
        startReplied = true;
        reply(message);
      };
      const target = spawn(msg.command[0], msg.command.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const onSpawn = () => {
        bind(target);
        replyStart({ ok: true, alive: true });
      };
      target.once("error", (err) => {
        stderrPending += String(err);
        detachChild(target);
        replyStart({ ok: false, status: null });
      });
      if (target.pid !== undefined) {
        onSpawn();
      } else {
        target.once("spawn", onSpawn);
      }
    } catch (err) {
      stderrPending += String(err);
      reply({ ok: false, status: null });
    }
    return;
  }
  if (msg.op === "send") {
    if (!child) {
      reply({ ok: false, status: null, gone: true });
      return;
    }
    settled = false;
    pendingVectors = null;
    requestOpen = true;
    try {
      child.stdin.write(msg.payload + "\n");
    } catch (err) {
      stderrPending += String(err);
      finishRequest({ ok: false, status: null });
    }
    return;
  }
  if (msg.op === "stop") {
    stopChild().then(() => reply({ ok: true })).catch((err) => {
      stderrPending += String(err);
      reply({ ok: false, status: null });
    });
    return;
  }
  if (msg.op === "close") {
    closeChild().then(() => reply({ ok: true })).catch((err) => {
      stderrPending += String(err);
      reply({ ok: false, error: String(err) });
    });
  }
});

`.trim();

function failed(status: number | null, stderr: string): Error {
  return new Error(`embed_minilm failed (${status}): ${stderr.slice(-400)}`);
}

export function createMinilmSession(opts?: { command?: string[] }): MinilmSession {
  const command = opts?.command ?? minilmServeCommand();
  let worker: Worker | undefined;
  let port1: MessagePort | undefined;
  let flag: Int32Array | undefined;
  let pidSlot: Int32Array | undefined;
  let closed = false;
  let dead = false;
  let childAlive = false;
  let replied = false;
  let started = 0;
  let restartsUsed = 0;
  const session: MinilmSession = {
    cleanupError: undefined,
    send(payload) {
      return send(payload, false);
    },
    stop() {
      if (closed || !worker || !flag) return;
      if (!childAlive) {
        if (started > 0 && !replied) dead = true;
        return;
      }
      const msg = roundtrip({ op: "stop" }, ROUNDTRIP_MS);
      if (msg.timeout) {
        const pid = pidSlot ? Atomics.load(pidSlot, 0) : 0;
        if (pid > 0) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
        const late = Atomics.wait(flag, 0, 0, ROUNDTRIP_MS);
        if (late !== "timed-out") {
          const trailed = takeMessage();
          if (trailed.stderr) noteMinilmStderr(trailed.stderr);
        }
      } else if (msg.stderr) {
        noteMinilmStderr(msg.stderr);
      }
      childAlive = false;
      if (!replied) dead = true;
    },
    close() {
      if (closed) return;
      closed = true;
      if (!worker || !flag || !port1) return;
      try {
        const msg = roundtrip({ op: "close" }, ROUNDTRIP_MS);
        if (msg.timeout) {
          const pid = pidSlot ? Atomics.load(pidSlot, 0) : 0;
          if (pid > 0) {
            try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
          }
          session.cleanupError = new Error("embed_minilm: close timed out");
        } else {
          if (msg.stderr) noteMinilmStderr(msg.stderr);
          if (msg.error) session.cleanupError = new Error(msg.error);
        }
      } catch (err) {
        session.cleanupError = err instanceof Error ? err : new Error(String(err));
      }
      childAlive = false;
      void worker.terminate();
    },
  };

  function ensureWorker(): void {
    if (worker && flag && port1) return;
    const shared = new SharedArrayBuffer(8);
    flag = new Int32Array(shared, 0, 1);
    pidSlot = new Int32Array(shared, 4, 1);
    const channel = new MessageChannel();
    port1 = channel.port1;
    port1.unref();
    worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.unref();
    Atomics.store(flag, 0, 0);
    worker.postMessage({ port: channel.port2, shared }, [channel.port2]);
    const status = Atomics.wait(flag, 0, 0, ROUNDTRIP_MS);
    Atomics.store(flag, 0, 0);
    if (status === "timed-out") throw failed(null, "worker did not start");
  }

  function takeMessage(): WorkerReply {
    const deadline = Date.now() + 1_000;
    let got = receiveMessageOnPort(port1!);
    while (!got && Date.now() < deadline) {
      Atomics.wait(flag!, 0, 1, 20);
      got = receiveMessageOnPort(port1!);
    }
    Atomics.store(flag!, 0, 0);
    if (!got) throw failed(null, "worker reply missing");
    return got.message as WorkerReply;
  }

  function roundtrip(message: object, timeoutMs: number): WorkerReply & { timeout?: boolean } {
    ensureWorker();
    Atomics.store(flag!, 0, 0);
    worker!.postMessage(message);
    const status = Atomics.wait(flag!, 0, 0, timeoutMs);
    if (status === "timed-out") return { timeout: true };
    return takeMessage();
  }

  function startChild(): void {
    if (started > 0 && !replied) {
      dead = true;
      throw new Error("embed_minilm: session is dead");
    }
    if (started > 0 && restartsUsed >= 1) {
      dead = true;
      throw new Error("embed_minilm: session is dead");
    }
    if (started > 0) restartsUsed += 1;
    const msg = roundtrip({ op: "start", command }, ROUNDTRIP_MS);
    if (msg.timeout || msg.ok === false) {
      dead = true;
      throw failed(msg.status ?? null, `${msg.stderr || ""}${msg.error || ""}`);
    }
    started += 1;
    childAlive = true;
    replied = false;
  }

  function send(payload: string, retried: boolean): number[][] {
    if (closed) throw new Error("embed_minilm: session is closed");
    if (dead) throw new Error("embed_minilm: session is dead");
    if (!childAlive) startChild();
    const msg = roundtrip({ op: "send", payload }, SEND_TIMEOUT_MS);
    if (msg.timeout) {
      const pid = pidSlot ? Atomics.load(pidSlot, 0) : 0;
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      const late = Atomics.wait(flag!, 0, 0, ROUNDTRIP_MS);
      if (late !== "timed-out") {
        const trailed = takeMessage();
        if (trailed.stderr) noteMinilmStderr(trailed.stderr);
      }
      childAlive = false;
      if (!replied) dead = true;
      throw failed(null, "timed out");
    }
    if (msg.gone) {
      childAlive = false;
      if (retried || !replied) {
        dead = true;
        throw failed(null, msg.stderr || "stdout closed");
      }
      return send(payload, true);
    }
    if (msg.stderr) noteMinilmStderr(msg.stderr);
    if (msg.ok !== true || !Array.isArray(msg.vectors)) {
      childAlive = false;
      if (!replied) dead = true;
      throw failed(msg.status ?? null, `${msg.stderr || ""}${msg.error || ""}`);
    }
    replied = true;
    childAlive = msg.alive === true;
    return msg.vectors;
  }

  return session;
}
