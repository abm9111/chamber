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
    import dns from "node:dns/promises";
    let readOutside = false, net = false;
    try { readFileSync("/etc/passwd"); readOutside = true; } catch {}
    try { await dns.lookup("example.com"); net = true; } catch {}
    console.log(JSON.stringify({ ran: true, readOutside, net }));
  `,
  timeoutMs: 15_000,
});

console.log("backend reported:", r.backend, " ok:", r.ok);
console.log(r.stdout.trim() || r.stderr.trim() || r.error);

if (!r.ok) {
  console.log(
    "\n>>> NOT PROVEN — the sandbox refused, so confinement was never exercised.\n" +
      "    On Linux this usually means bubblewrap cannot create a user namespace.\n" +
      "    Ubuntu 24.04 restricts that by default:\n" +
      "      sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n" +
      "    Refusing is the correct fail-closed behaviour — but it is not evidence\n" +
      "    that anything is confined, which is what this probe exists to obtain.",
  );
  process.exit(1);
}

const leaked =
  r.stdout.includes('"readOutside":true') || r.stdout.includes('"net":true');
console.log(
  leaked
    ? "\n>>> NOT CONFINED — the payload ran and reached outside the sandbox"
    : "\n>>> CONFINED — the payload ran, could not read /etc/passwd, and had no network",
);
process.exit(leaked ? 1 : 0);
