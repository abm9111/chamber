/**
 * PROBE: sandbox escape.
 *
 * Demonstrates that as of baseline a49f4c5:
 *   - CHAMBER_SANDBOX_REQUIRED=1 does not refuse
 *   - detectSandboxBackend() may report "docker" while running a bare subprocess
 *   - sandboxed code reads $HOME, writes to $HOME, and reaches the network
 *
 * This probe is expected to FAIL (i.e. report no escape) once Phase 1.1 lands.
 * Promote it into tests/harness.ts as a negative regression test at that point.
 *
 *   CHAMBER_SANDBOX_REQUIRED=1 node --experimental-strip-types probes/sandbox_escape.ts
 */

import { runInSandbox, detectSandboxBackend } from "../src/sandbox.ts";

console.log("CHAMBER_SANDBOX_REQUIRED =", process.env.CHAMBER_SANDBOX_REQUIRED ?? "(unset)");
console.log("detectSandboxBackend()   =", detectSandboxBackend());

const r = runInSandbox({
  runtime: "node",
  source: `
    import { existsSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
    import { homedir } from "node:os";
    import dns from "node:dns/promises";

    const out = { homeReadable: false, sshExists: false, secretsExists: false,
                  wroteOutside: false, net: "?" };
    try { out.homeReadable = readdirSync(homedir()).length > 0; } catch { out.homeReadable = "BLOCKED"; }
    try { out.sshExists = existsSync(homedir() + "/.ssh"); } catch { out.sshExists = "BLOCKED"; }
    try { out.secretsExists = existsSync(homedir() + "/.secrets"); } catch { out.secretsExists = "BLOCKED"; }
    try {
      const p = homedir() + "/.chamber_sandbox_escape_probe";
      writeFileSync(p, "x"); out.wroteOutside = true; unlinkSync(p);
    } catch (e) { out.wroteOutside = "BLOCKED"; }
    try { const a = await dns.lookup("example.com"); out.net = "RESOLVED " + a.address; }
    catch { out.net = "BLOCKED"; }
    console.log(JSON.stringify(out, null, 2));
  `,
  timeoutMs: 8000,
});

console.log("backend reported:", r.backend, " ok:", r.ok);
console.log(r.stdout || r.stderr || r.error);

const escaped =
  r.ok && (r.stdout.includes('"wroteOutside": true') || r.stdout.includes("RESOLVED"));
console.log(
  escaped
    ? "\n>>> ESCAPE CONFIRMED — sandbox does not isolate"
    : "\n>>> no escape detected",
);
process.exit(escaped ? 1 : 0);
