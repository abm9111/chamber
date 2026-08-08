/**
 * PROBE: the sandbox actually confines — not merely that it refuses.
 *
 * `probes/sandbox_escape.ts` passes in two very different worlds: one where the
 * sandbox contained the payload, and one where no isolating backend existed so
 * nothing ran at all. Both report "no escape detected", and CI has been living
 * in the second. A gate that is only ever observed saying no has not been
 * observed working.
 *
 * This probe demands the other half. It requires the payload to RUN and to be
 * contained:
 *
 *   - the run must succeed (a refusal fails this probe)
 *   - the payload must not read /etc/passwd  (present + world-readable outside
 *     the allowlist, so a failure here means confinement, not permissions)
 *   - the payload must not resolve a hostname
 *
 * Linux + bubblewrap only, and deliberately not part of `npm run probes`: on a
 * machine with no isolating backend it can only fail, and a probe that always
 * fails teaches people to ignore it. CI runs it explicitly, which is the whole
 * point — that is the machine where confinement is claimed.
 *
 *   CHAMBER_SANDBOX_REQUIRED=1 node --experimental-strip-types probes/sandbox_confines.ts
 */

import { runInSandbox, detectSandboxBackend } from "../src/sandbox.ts";

const backend = detectSandboxBackend();
console.log("detectSandboxBackend() =", backend);
console.log("CHAMBER_SANDBOX_REQUIRED =", process.env.CHAMBER_SANDBOX_REQUIRED ?? "(unset)");

const r = runInSandbox({
  runtime: "node",
  source: `
    import { readFileSync } from "node:fs";
    import net from "node:net";
    let readOutside = false, reachedNet = false;
    try { readFileSync("/etc/passwd"); readOutside = true; } catch {}
    // Raw IP, not a hostname: /etc is not bound, so DNS fails regardless of
    // whether the sandbox has a network, and a name-resolution needle reports
    // "no network" for a fully network-open sandbox.
    reachedNet = await new Promise((resolve) => {
      const socket = net.connect({ host: "1.1.1.1", port: 443 });
      const done = (v) => { try { socket.destroy(); } catch {} resolve(v); };
      socket.setTimeout(3000);
      socket.on("connect", () => done(true));
      socket.on("timeout", () => done(false));
      socket.on("error", () => done(false));
    });
    console.log(JSON.stringify({ ran: true, readOutside, reachedNet }));
  `,
  timeoutMs: 15_000,
});

console.log("backend reported:", r.backend, " ok:", r.ok);
console.log(r.stdout.trim() || r.stderr.trim() || r.error);

// A refusal is ambiguous, and the ambiguity matters. `isolationHolds` runs its
// own read needle before any payload, so a sandbox that genuinely leaks makes
// `runInSandbox` refuse — which lands here looking exactly like "no namespace
// available". Reporting that as a configuration problem points an operator at a
// sysctl when the real condition is a live escape, so the two are separated by
// what the refusal actually says.
if (!r.ok) {
  const unproven = (r.error ?? "").includes("did not confine a probe");
  console.log(
    unproven
      ? "\n>>> NOT PROVEN — bwrap was selected but could not confine its own probe.\n" +
          "    That is either a missing namespace capability OR a real escape;\n" +
          "    this probe cannot tell them apart, and neither can CI.\n" +
          "    Check `unshare --user --map-root-user true` before assuming config."
      : "\n>>> NOT PROVEN — the sandbox refused, so confinement was never exercised.\n" +
      "    On Linux this usually means bubblewrap cannot create a user namespace.\n" +
      "    Ubuntu 24.04 restricts that by default:\n" +
      "      sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n" +
      "    Refusing is the correct fail-closed behaviour — but it is not evidence\n" +
      "    that anything is confined, which is what this probe exists to obtain.",
  );
  process.exit(1);
}

// Parse rather than substring-match, and require positive evidence the payload
// ran. `leaked` inferred from the absence of two substrings meant that empty or
// truncated stdout — an output cap, a runtime that starts and writes nothing —
// read as confinement, certifying a run whose assertions may never have
// executed.
let report: { ran?: boolean; readOutside?: boolean; reachedNet?: boolean } = {};
try {
  report = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).pop() ?? "{}");
} catch {
  /* leave empty — handled below */
}
if (report.ran !== true) {
  console.log(
    "\n>>> NOT PROVEN — the payload did not report running. Absence of a leak in\n" +
      "    empty output is not evidence of confinement.",
  );
  process.exit(1);
}
const leaked = report.readOutside === true || report.reachedNet === true;
console.log(
  leaked
    ? "\n>>> NOT CONFINED — the payload ran and reached outside the sandbox"
    : "\n>>> CONFINED — the payload ran, could not read /etc/passwd, and had no network",
);
process.exit(leaked ? 1 : 0);
