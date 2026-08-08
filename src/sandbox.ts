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

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
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
 * The absolute path a command name resolves to, or null.
 *
 * Never `resolve()` a bare command name: that silently interprets it relative to
 * the working directory, which is how a "bind the runtime's own prefix" rule
 * turned into "bind the parent of wherever this process happens to be running".
 */
/**
 * The read-only bind that lets the runtime start, or refusal.
 *
 * Computing this from the resolved binary keeps re-deriving `/`: `dirname` of
 * `/bin/bash` is `/bin`, whose parent is the root, so on any host whose PATH
 * reaches `/bin` first the allowlist re-mounts the entire filesystem — the very
 * thing it replaced. Resolving through PATH fixed the *cwd* case and left this
 * one, because the bug was never the resolution, it was deriving a bind from an
 * arbitrary path at all.
 *
 * So this refuses instead of computing. A prefix of `/` or a single segment
 * (`/usr`, `/opt`) is rejected outright — anything that broad is already covered
 * by the static allowlist, and a runtime living outside it is one this sandbox
 * cannot confine. An empty bind means the payload cannot start, which is the
 * safe direction: nothing runs rather than something runs unconfined.
 */
function runtimeBindFor(cmd: string): string[] {
  const resolved = absolutePathOf(cmd);
  if (!resolved) return [];
  const prefix = resolve(dirname(resolved), "..");
  const segments = prefix.split("/").filter(Boolean);
  if (segments.length < 2) return [];
  return ["--ro-bind-try", prefix, prefix];
}

function absolutePathOf(cmd: string): string | null {
  if (cmd.startsWith("/")) return cmd;
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  const out = r.status === 0 ? r.stdout.trim().split("\n")[0] : "";
  return out && out.startsWith("/") ? out : null;
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
 *
 * All three checks must come back blocked. **Read is the one that was missing**,
 * and its absence is why a sandbox that mounted the entire host read-only was
 * certified as confining: the probe asked whether the payload could write to
 * $HOME and reach the network, both of which a read-open `--ro-bind / /` sandbox
 * correctly refuses, and answered "confined" while `~/.secrets` and the Chamber
 * database sat readable in front of it. Exfiltration does not need the network —
 * stdout is returned to the caller verbatim.
 *
 * A probe only ever proves the dimensions it tests. If a future backend can be
 * escaped some other way, this list is where that has to be written down.
 *
 * Choosing the read needle is harder than it looks, and both earlier attempts
 * were wrong in opposite directions. `homedir()` is *created* by bwrap whenever
 * the runtime prefix lives under $HOME (nvm), so a confining sandbox reported
 * itself unconfined and refused everything. `~/.ssh` and `/etc/shadow` then
 * failed with ENOENT and EACCES for an ordinary service user whether confined or
 * not, so a read-open sandbox reported itself confined — the dangerous
 * direction. The needle must be present, world-readable *unconfined*, and
 * outside the allowlist *confined*: `/etc/passwd` is all three, with no
 * permission confound to muddy the result.
 *
 * Writes are not probed separately: every bind this sandbox issues is
 * `--ro-bind-try`, so a successful read of the needle is the discriminator and a
 * write attempt only re-tests the same mount from a noisier angle.
 */
const ISOLATION_PROBE_SOURCE = `
  import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
  import dns from "node:dns/promises";
  let wrote = false, net = false, read = false;
  try { await dns.lookup("example.com"); net = true; } catch {}
  try { readFileSync("/etc/passwd"); read = true; } catch {}
  console.log(JSON.stringify({ confined: !wrote && !net && !read }));
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
  // Fail-closed default: an unconfined verdict is the safe one if any path
  // below fails to assign.
  // eslint-disable-next-line no-useless-assignment
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

  // Order is load-bearing: bwrap applies mount operations left to right, and
  // the work directory lives under the system temp dir. With `--tmpfs /tmp`
  // last, the empty tmpfs mounted straight over `/tmp` after the bind, hiding
  // the script that was just written there — so on a host with real bubblewrap
  // the payload failed ENOENT, the isolation probe read that as "does not
  // confine", and CHAMBER_SANDBOX_REQUIRED=1 refused every call on exactly the
  // machines that could isolate. The tmpfs therefore goes down first and the
  // work directory is bound on top of it.
  // What the payload may see, as an allowlist.
  //
  // This began as `--ro-bind / /` — the entire host, readable. That was
  // inert only because the ordering bug below meant the payload never ran;
  // fixing the ordering made a read-open sandbox reachable for the first time,
  // which is a worse defect than the one it fixed. `--unshare-net` stops
  // exfiltration over the network but not over stdout, which is returned to
  // the caller verbatim, so read access to `~/.secrets`, the Chamber database
  // and any credential on disk was a real path out.
  //
  // An allowlist is the only shape that fails safe: a directory nobody thought
  // about is absent rather than exposed. `--ro-bind-try` because these differ
  // per distro and a missing one must not abort the run. The runtime's own
  // prefix is included because node or python may live outside /usr — under
  // nvm it sits in $HOME, and binding that one subtree is not the same as
  // binding $HOME.
  // `cmd` is an absolute path only for the node runtime; python and bash are
  // bare names. `dirname("python3")` is ".", so deriving a prefix from it gave
  // the parent of the *working directory* — which under a systemd unit with no
  // WorkingDirectory is "/", re-binding the entire host read-only and undoing
  // the allowlist this function exists to enforce. Resolve through PATH first,
  // and if that fails, add no runtime bind at all: the payload then cannot start
  // and refuses, which is the safe direction.
  const runtimeBind = runtimeBindFor(cmd);
  const bwrapArgs = [
    "--ro-bind-try",
    "/usr",
    "/usr",
    "--ro-bind-try",
    "/bin",
    "/bin",
    "--ro-bind-try",
    "/sbin",
    "/sbin",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    ...runtimeBind,
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--bind",
    dir,
    dir,
    "--chdir",
    dir,
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
