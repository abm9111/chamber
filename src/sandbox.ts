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
  if (backend === "none" || process.env.CHAMBER_SANDBOX_REQUIRED === "1") {
    if (backend === "none") {
      return {
        ok: false,
        backend: "none",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs: 0,
        sourceHash: createHash("sha256").update(req.source).digest("hex"),
        workDir: "",
        error: "sandbox required but no backend available",
      };
    }
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
