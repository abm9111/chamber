/**
 * Sandbox runner for tool verification.
 *
 * Levels (best available):
 *   1. bwrap / docker if present
 *   2. subprocess with timeout, scrubbed env, temp cwd, no network env hints
 *   3. fail-closed if CHAMBER_SANDBOX_REQUIRED=1 and no isolation
 *
 * Tools never write to Chamber DB directly — stdout/stderr captured as evidence.
 */

import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

export type SandboxBackend = "bwrap" | "docker" | "subprocess" | "none";

export interface SandboxRequest {
  /** Language runner */
  runtime: "node" | "python" | "bash";
  /** Source code to execute */
  source: string;
  /** Optional argv after script */
  args?: string[];
  /** stdin */
  input?: string;
  /** wall clock ms */
  timeoutMs?: number;
  /** max stdout+stderr bytes kept */
  maxOutputBytes?: number;
}

export interface SandboxResult {
  ok: boolean;
  backend: SandboxBackend;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  sourceHash: string;
  workDir: string;
  error?: string;
}

function which(bin: string): boolean {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

/**
 * Backends execution is genuinely confined by. Membership is a claim about
 * Chamber's own wiring, not about the binary existing: `docker` is detected on
 * PATH and named by `detectSandboxBackend`, but nothing here routes through it
 * yet, so it does not belong. Adding a backend to this set is what makes
 * `CHAMBER_SANDBOX_REQUIRED=1` willing to run on it — do it when the code path
 * lands, not when the binary appears.
 */
const ISOLATING_BACKENDS = new Set<SandboxBackend>(["bwrap"]);

/**
 * Is isolation being demanded? Any value that is not an explicit "off" counts.
 *
 * Testing `=== "1"` made `CHAMBER_SANDBOX_REQUIRED=true` — and `yes`, and a
 * trailing newline from a shell heredoc — run unisolated while the operator who
 * set it believed the opposite. That is the worst direction for a typo to
 * resolve: the flag exists to be a promise, so an unrecognised spelling must
 * keep the promise, not silently drop it.
 */
function sandboxRequired(): boolean {
  const v = (process.env.CHAMBER_SANDBOX_REQUIRED ?? "").trim().toLowerCase();
  return !(v === "" || v === "0" || v === "false" || v === "no" || v === "off");
}

/**
 * Source that reports whether the thing running it is actually confined.
 * Both checks must come back blocked: a real bwrap invocation gets `/` bound
 * read-only and its network unshared, so it can neither write to $HOME nor
 * resolve a name.
 */
const ISOLATION_PROBE_SOURCE = `
  import { writeFileSync, unlinkSync } from "node:fs";
  import { homedir } from "node:os";
  import dns from "node:dns/promises";
  let wrote = false, net = false;
  try { const p = homedir() + "/.chamber_isolation_probe"; writeFileSync(p, "x"); wrote = true; unlinkSync(p); } catch {}
  try { await dns.lookup("example.com"); net = true; } catch {}
  console.log(JSON.stringify({ confined: !wrote && !net }));
`;

let isolationProbeCache: { backend: SandboxBackend; ok: boolean } | null = null;

/**
 * Demonstrate that `backend` confines execution, instead of believing its name.
 *
 * The name has two sources and neither is evidence. `CHAMBER_SANDBOX_BACKEND`
 * is an unsigned assertion any parent process can set, and `which("bwrap")`
 * proves only that a file with that name is on PATH — a three-line stub that
 * drops the isolation flags and execs its payload satisfies both, and did:
 * untrusted source ran with $HOME readable while the result said
 * `backend: "bwrap"`. So run a probe through the backend and require it to come
 * back confined. A stub passes the payload through and the probe reports
 * escape; a broken or missing binary fails to run at all. Both refuse.
 *
 * Cached per process and per backend: this costs one spawn, and the answer
 * cannot change without the process's PATH or env changing under it.
 */
function isolationHolds(backend: SandboxBackend): boolean {
  if (isolationProbeCache?.backend === backend) return isolationProbeCache.ok;
  let ok = false;
  const dir = mkdtempSync(join(tmpdir(), "chamber-sbxprobe-"));
  try {
    const script = writeSource(dir, "node", ISOLATION_PROBE_SOURCE);
    const req: SandboxRequest = {
      runtime: "node",
      source: ISOLATION_PROBE_SOURCE,
      timeoutMs: 10_000,
    };
    // Call the backend runner directly. Routing through runInSandbox would
    // re-enter this check and recurse.
    const r = backend === "bwrap" ? runBwrap(req, dir, script) : null;
    ok = !!r?.ok && r.stdout.includes('"confined":true');
  } catch {
    ok = false;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  isolationProbeCache = { backend, ok };
  return ok;
}

/** Test seam: drop the memoised probe result. */
export function resetIsolationProbe(): void {
  isolationProbeCache = null;
}

export function detectSandboxBackend(): SandboxBackend {
  if (process.env.CHAMBER_SANDBOX_BACKEND) {
    return process.env.CHAMBER_SANDBOX_BACKEND as SandboxBackend;
  }
  if (which("bwrap")) return "bwrap";
  if (which("docker")) return "docker";
  return "subprocess";
}

function scrubEnv(): NodeJS.ProcessEnv {
  const allow = new Set([
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "USER",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const k of allow) {
    if (process.env[k]) env[k] = process.env[k];
  }
  env.CHAMBER_SANDBOX = "1";
  // discourage accidental network libs from picking up keys
  env.NO_PROXY = "*";
  env.HTTP_PROXY = "";
  env.HTTPS_PROXY = "";
  return env;
}

function writeSource(
  dir: string,
  runtime: SandboxRequest["runtime"],
  source: string,
): string {
  const name =
    runtime === "python" ? "main.py" : runtime === "bash" ? "main.sh" : "main.mjs";
  const path = join(dir, name);
  writeFileSync(path, source, "utf8");
  return path;
}

function runSubprocess(
  req: SandboxRequest,
  dir: string,
  script: string,
): Omit<SandboxResult, "backend" | "sourceHash" | "workDir"> {
  const timeoutMs = req.timeoutMs ?? 5_000;
  const maxOut = req.maxOutputBytes ?? 64_000;
  const cmd =
    req.runtime === "python"
      ? "python3"
      : req.runtime === "bash"
        ? "bash"
        : process.execPath;
  const args =
    req.runtime === "node"
      ? ["--experimental-strip-types", script, ...(req.args ?? [])]
      : [script, ...(req.args ?? [])];

  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: dir,
    env: scrubEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: maxOut,
    input: req.input,
  });
  const timedOut = r.error?.message.includes("TIMEDOUT") ?? false;
  return {
    ok: r.status === 0 && !timedOut,
    exitCode: r.status,
    signal: r.signal,
    stdout: (r.stdout ?? "").slice(0, maxOut),
    stderr: (r.stderr ?? "").slice(0, maxOut),
    timedOut,
    durationMs: Date.now() - started,
    error: r.error?.message,
  };
}

function runBwrap(
  req: SandboxRequest,
  dir: string,
  script: string,
): Omit<SandboxResult, "backend" | "sourceHash" | "workDir"> {
  const timeoutMs = req.timeoutMs ?? 5_000;
  const maxOut = req.maxOutputBytes ?? 64_000;
  const cmd =
    req.runtime === "python"
      ? "python3"
      : req.runtime === "bash"
        ? "bash"
        : process.execPath;
  const innerArgs =
    req.runtime === "node"
      ? [cmd, "--experimental-strip-types", script, ...(req.args ?? [])]
      : [cmd, script, ...(req.args ?? [])];

  const bwrapArgs = [
    "--ro-bind",
    "/",
    "/",
    "--bind",
    dir,
    dir,
    "--chdir",
    dir,
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--unshare-net",
    "--die-with-parent",
    ...innerArgs,
  ];
  const started = Date.now();
  const r = spawnSync("bwrap", bwrapArgs, {
    cwd: dir,
    env: scrubEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: maxOut,
    input: req.input,
  });
  const timedOut = r.error?.message.includes("TIMEDOUT") ?? false;
  return {
    ok: r.status === 0 && !timedOut,
    exitCode: r.status,
    signal: r.signal,
    stdout: (r.stdout ?? "").slice(0, maxOut),
    stderr: (r.stderr ?? "").slice(0, maxOut),
    timedOut,
    durationMs: Date.now() - started,
    error: r.error?.message,
  };
}

export function runInSandbox(req: SandboxRequest): SandboxResult {
  const backend = detectSandboxBackend();
  const refusal =
    backend === "none"
      ? "no sandbox backend available"
      : !sandboxRequired()
        ? null
        : !ISOLATING_BACKENDS.has(backend)
          ? `sandbox required but ${backend} does not isolate ` +
            `(isolating backends: ${[...ISOLATING_BACKENDS].join(", ")})`
          : !isolationHolds(backend)
            ? `sandbox required and ${backend} was selected, but it did not ` +
              `confine a probe — treating the name as unproven`
            : null;
  if (refusal) {
    return {
      ok: false,
      // Nothing ran, so no backend ran it. Naming the *detected* backend here
      // would tell an audit reader that docker confined this call when docker
      // never saw it; the detected name belongs in `error`, which says why.
      backend: "none",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0,
      sourceHash: createHash("sha256").update(req.source).digest("hex"),
      workDir: "",
      error: refusal,
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "chamber-sbx-"));
  const sourceHash = createHash("sha256").update(req.source).digest("hex");
  try {
    const script = writeSource(dir, req.runtime, req.source);
    const partial =
      backend === "bwrap"
        ? runBwrap(req, dir, script)
        : runSubprocess(req, dir, script);
    return {
      ...partial,
      backend: backend === "docker" ? "subprocess" : backend, // docker path not fully wired
      sourceHash,
      workDir: dir,
    };
  } finally {
    // keep dir if CHAMBER_SANDBOX_KEEP=1 for debug
    if (process.env.CHAMBER_SANDBOX_KEEP !== "1") {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/** Quick probe for tests. */
export function sandboxSelfTest(): SandboxResult {
  return runInSandbox({
    runtime: "node",
    source: `console.log(JSON.stringify({ ok: true, sandbox: process.env.CHAMBER_SANDBOX }))`,
    timeoutMs: 3000,
  });
}
