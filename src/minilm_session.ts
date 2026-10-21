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
let owner = null;
let request = null;
let stdout = "";
let stderrPending = "";
const states = new WeakMap();

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

function drained(target) {
  const state = states.get(target);
  return state ? state.drained : Promise.resolve();
}

function finishRequest(target, message) {
  if (!request || request.target !== target) return;
  request = null;
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

function isCurrent(target) {
  return child === target;
}

function owns(target) {
  return request !== null && request.target === target;
}

function bind(target) {
  const state = { code: null, reason: "", stdoutEnded: false, stdoutLost: false, drained: null };
  let markDrained = null;
  state.drained = new Promise((resolve) => { markDrained = resolve; });
  states.set(target, state);
  child = target;
  owner = target;
  stdout = "";
  Atomics.store(pidSlot, 0, target.pid || 0);
  target.stdout.setEncoding("utf8");
  target.stderr.setEncoding("utf8");
  target.stdin.on("error", () => {});
  const fail = (reason) => {
    state.reason = reason;
    killChild(target);
  };
  target.stdout.on("data", (chunk) => {
    if (!isCurrent(target)) return;
    if (stdout.length + chunk.length > REPLY_LIMIT) {
      fail("reply longer than 64 MiB");
      return;
    }
    stdout += chunk;
    if (!owns(target) || request.vectors) return;
    const nl = stdout.indexOf("\n");
    if (nl < 0) return;
    const line = stdout.slice(0, nl);
    stdout = stdout.slice(nl + 1);
    let vectors = null;
    try {
      vectors = JSON.parse(line);
    } catch (err) {}
    if (!Array.isArray(vectors)) {
      fail("embed_minilm: expected a JSON array of vectors");
      return;
    }
    request.vectors = vectors;
    setImmediate(() => {
      if (!isCurrent(target)) return;
      const alive =
        target.exitCode === null && target.signalCode === null && !state.stdoutEnded;
      finishRequest(target, { ok: true, vectors, alive });
    });
  });
  target.stdout.on("end", () => {
    state.stdoutEnded = true;
    if (!isCurrent(target) || !owns(target) || request.vectors) return;
    state.stdoutLost = true;
    killChild(target);
  });
  target.stderr.on("data", (chunk) => {
    if (owner !== target) return;
    stderrPending += chunk;
  });
  let drainTimer = null;
  let gone = false;
  const settle = () => {
    if (gone) return;
    gone = true;
    if (drainTimer) clearTimeout(drainTimer);
    markDrained();
    if (!owns(target)) return;
    const code = state.code;
    if (request.vectors) {
      finishRequest(target, { ok: true, vectors: request.vectors, alive: false, status: code });
      return;
    }
    const note = state.reason || (state.stdoutLost && code === null ? "embed_minilm: stdout closed" : "");
    if (note) {
      if (stderrPending && !stderrPending.endsWith("\n")) stderrPending += "\n";
      stderrPending += note;
    }
    finishRequest(target, { ok: false, status: code, gone: code === 0 && !note });
  };
  target.on("exit", (code) => {
    state.code = code;
    detachChild(target);
    drainTimer = setTimeout(settle, STOP_WAIT_MS);
  });
  target.on("close", settle);
  target.on("error", (err) => {
    if (!isCurrent(target)) return;
    detachChild(target);
    stderrPending += String(err);
    finishRequest(target, { ok: false, status: null });
  });
}

async function endChild(target) {
  let gone = await waitExit(target, STOP_WAIT_MS);
  if (!gone) {
    try { target.kill("SIGKILL"); } catch (err) {}
    gone = await waitExit(target, STOP_WAIT_MS);
  }
  detachChild(target);
  if (!gone) throw new Error("embed_minilm: child " + target.pid + " still running after SIGKILL");
  await drained(target);
}

async function stopChild() {
  if (!child) return;
  const target = child;
  try { target.kill("SIGTERM"); } catch (err) {}
  await endChild(target);
}

async function closeChild() {
  if (!child) return;
  const target = child;
  try { target.stdin.end(); } catch (err) {}
  await endChild(target);
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
        const state = states.get(child);
        if (
          !child.killed &&
          child.exitCode === null &&
          child.signalCode === null &&
          !(state && state.stdoutEnded)
        ) {
          reply({ ok: true, alive: true });
          return;
        }
        killChild(child);
      }
      stdout = "";
      request = null;
      const target = spawn(msg.command[0], msg.command.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const onSpawn = () => {
        target.removeListener("error", onError);
        bind(target);
        reply({ ok: true, alive: true });
      };
      const onError = (err) => {
        target.removeListener("spawn", onSpawn);
        stderrPending += String(err);
        reply({ ok: false, status: null });
      };
      target.once("spawn", onSpawn);
      target.once("error", onError);
    } catch (err) {
      stderrPending += String(err);
      reply({ ok: false, status: null });
    }
    return;
  }
  if (msg.op === "send") {
    const state = child && states.get(child);
    if (state && state.stdoutEnded) killChild(child);
    if (!child) {
      reply({ ok: false, status: null, gone: true });
      return;
    }
    const target = child;
    request = { target, vectors: null };
    try {
      target.stdin.write(msg.payload + "\n");
    } catch (err) {
      stderrPending += String(err);
      finishRequest(target, { ok: false, status: null });
    }
    return;
  }
  if (msg.op === "stop") {
    stopChild().then(() => reply({ ok: true })).catch((err) => {
      reply({ ok: false, status: null, error: String(err) });
    });
    return;
  }
  if (msg.op === "close") {
    closeChild().then(() => reply({ ok: true })).catch((err) => {
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
        session.cleanupError ??= new Error("embed_minilm: stop timed out");
      } else {
        if (msg.stderr) noteMinilmStderr(msg.stderr);
        if (msg.error) session.cleanupError ??= new Error(msg.error);
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
          session.cleanupError ??= new Error("embed_minilm: close timed out");
        } else {
          if (msg.stderr) noteMinilmStderr(msg.stderr);
          if (msg.error) session.cleanupError ??= new Error(msg.error);
        }
      } catch (err) {
        session.cleanupError ??= err instanceof Error ? err : new Error(String(err));
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
    if (msg.stderr) noteMinilmStderr(msg.stderr);
    started += 1;
    childAlive = true;
    replied = false;
  }

  function send(payload: string, retried: boolean): number[][] {
    if (closed) throw new Error("embed_minilm: session is closed");
    if (dead) throw new Error("embed_minilm: session is dead");
    if (/[\n\r]/.test(payload)) throw new Error("embed_minilm: payload must be one line");
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
    if (msg.stderr) noteMinilmStderr(msg.stderr);
    if (msg.gone) {
      childAlive = false;
      if (retried || !replied) {
        dead = true;
        throw failed(null, msg.stderr || "stdout closed");
      }
      return send(payload, true);
    }
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
