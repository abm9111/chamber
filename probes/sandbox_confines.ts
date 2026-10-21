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
 *   - the payload must not reach the network
 *   - the payload must not see a host process: this probe starts a sleeping
 *     child with a random marker in its argv, and the payload scans /proc for
 *     it. That is the pid namespace (`--unshare-pid`). The needle is proven
 *     visible UNCONFINED first, by running the same scan outside the sandbox,
 *     so its absence inside means confinement and not a scan that finds nothing.
 *     The scan also has to prove it could look: the payload reports
 *     `procReadable` only if /proc/self/cmdline read and it listed a numeric
 *     entry, because a scan that swallows every error reports "saw nothing"
 *     just as happily when /proc is missing altogether.
 *   - the payload must be in its own IPC and UTS namespaces: the inode strings
 *     of /proc/self/ns/ipc and /proc/self/ns/uts inside must differ from this
 *     process's own (`--unshare-ipc`, `--unshare-uts`)
 *   - the payload must not share this terminal session: its session id, from
 *     /proc/self/stat, must be non-zero. Under `--unshare-pid` alone the session
 *     leader is outside the pid namespace and the id reads 0; `--new-session`
 *     makes the payload its own leader (`--new-session`)
 *
 * Linux + bubblewrap only, and deliberately not part of `npm run probes`: on a
 * machine with no isolating backend it can only fail, and a probe that always
 * fails teaches people to ignore it. CI runs it explicitly, which is the whole
 * point — that is the machine where confinement is claimed.
 *
 *   CHAMBER_SANDBOX_REQUIRED=1 node --experimental-strip-types probes/sandbox_confines.ts
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInSandbox, detectSandboxBackend } from "../src/sandbox.ts";

const backend = detectSandboxBackend();
console.log("detectSandboxBackend() =", backend);
console.log("CHAMBER_SANDBOX_REQUIRED =", process.env.CHAMBER_SANDBOX_REQUIRED ?? "(unset)");

// The process needle: a host process the payload must not be able to see. A
// pid would be a poor marker, because the sandbox's own pid namespace numbers
// from 1 and a small host pid could collide with a sandbox process; a random
// string in a process's argv cannot.
/** This process's own namespace id, e.g. "ipc:[4026531839]"; "" if unreadable. */
function ownNamespace(kind: "ipc" | "uts"): string {
  try {
    return readlinkSync(`/proc/self/ns/${kind}`);
  } catch {
    return "";
  }
}
const hostIpc = ownNamespace("ipc");
const hostUts = ownNamespace("uts");

const marker = `chamber-needle-${randomBytes(8).toString("hex")}`;
const needle = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", "--", marker], {
  stdio: "ignore",
});
const controlDir = mkdtempSync(join(tmpdir(), "chamber-needle-"));

/** Stop the needle and remove the scratch directory, then exit. */
function finish(code: number): never {
  needle.kill("SIGKILL");
  rmSync(controlDir, { recursive: true, force: true });
  process.exit(code);
}

// Reads every /proc/<pid>/cmdline and reports whether any contains the marker,
// plus the positive controls that make a "no" from it mean something:
//   procReadable  true only if /proc/self/cmdline read AND a numeric entry was
//                 listed. Every read below swallows its errors, so without this
//                 a payload with no /proc at all reports sawHostProcess:false.
//   ipc, uts      this process's namespace ids ("" if unreadable)
//   sid           this process's session id from /proc/self/stat, -1 if unparsed
// `import * as` so it can sit beside the payload's own imports without
// redeclaring a name. The scanning process's own argv is a file path, never the
// marker, so it cannot find itself.
const PROC_SCAN = `
  import * as procfs from "node:fs";
  const MARKER = ${JSON.stringify(marker)};
  let sawHostProcess = false, sawNumericEntry = false, procReadable = false;
  try {
    for (const name of procfs.readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(name)) continue;
      sawNumericEntry = true;
      try {
        if (procfs.readFileSync("/proc/" + name + "/cmdline", "utf8").includes(MARKER)) sawHostProcess = true;
      } catch {}
    }
  } catch {}
  try { procfs.readFileSync("/proc/self/cmdline"); procReadable = sawNumericEntry; } catch {}
  let ipc = "", uts = "", sid = -1;
  try { ipc = procfs.readlinkSync("/proc/self/ns/ipc"); } catch {}
  try { uts = procfs.readlinkSync("/proc/self/ns/uts"); } catch {}
  try {
    // comm may contain spaces and parentheses, so split after the LAST ")".
    // Then: state ppid pgrp session ... -- the session is the 4th field.
    const stat = procfs.readFileSync("/proc/self/stat", "utf8");
    const parsed = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
    if (Number.isInteger(parsed)) sid = parsed;
  } catch {}
`;
const REPORT_FIELDS = "sawHostProcess, procReadable, ipc, uts, sid";

// The control. The needle must be visible with no sandbox at all, or its
// absence inside the sandbox proves nothing. The child may not have exec'd yet,
// so poll briefly before concluding it is invisible.
writeFileSync(
  join(controlDir, "scan.mjs"),
  `${PROC_SCAN}\nconsole.log(JSON.stringify({ ${REPORT_FIELDS} }));\n`,
);
interface ScanReport {
  sawHostProcess?: boolean;
  procReadable?: boolean;
  ipc?: string;
  uts?: string;
  sid?: number;
}
let control: ScanReport = {};
let visibleUnconfined = false;
for (let i = 0; i < 50 && !visibleUnconfined; i++) {
  const scan = spawnSync(process.execPath, [join(controlDir, "scan.mjs")], { encoding: "utf8" });
  try {
    control = JSON.parse((scan.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "{}") as ScanReport;
  } catch {
    control = {};
  }
  visibleUnconfined = control.sawHostProcess === true;
  if (!visibleUnconfined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
console.log("process needle visible unconfined:", visibleUnconfined);
if (!visibleUnconfined) {
  console.log(
    "\n>>> NOT PROVEN — the process needle is not visible outside the sandbox either\n" +
      "    (no /proc, or the needle did not start), so its absence inside proves nothing.",
  );
  finish(1);
}
// The same scan, unconfined, must also read what the sandboxed one is judged on:
// /proc readable, the namespace links equal to ours (so the two reads agree on
// what a "shared" value looks like), and a parsed session id. Otherwise a
// difference inside could be a failed read rather than a namespace.
const controlsHold =
  control.procReadable === true &&
  hostIpc !== "" &&
  hostUts !== "" &&
  control.ipc === hostIpc &&
  control.uts === hostUts &&
  typeof control.sid === "number" &&
  control.sid >= 0;
console.log(
  "ipc/uts/session readable unconfined:",
  controlsHold,
  `(ipc ${control.ipc ?? "?"}, uts ${control.uts ?? "?"}, sid ${control.sid ?? "?"})`,
);
if (!controlsHold) {
  console.log(
    "\n>>> NOT PROVEN — the namespace and session reads do not work outside the sandbox\n" +
      "    either, so a difference or a zero inside proves nothing.",
  );
  finish(1);
}

const r = runInSandbox({
  runtime: "node",
  source: `
    import { readFileSync } from "node:fs";
    import net from "node:net";
    ${PROC_SCAN}
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
    console.log(JSON.stringify({ ran: true, readOutside, reachedNet, ${REPORT_FIELDS} }));
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
  finish(1);
}

// Parse rather than substring-match, and require positive evidence the payload
// ran. `leaked` inferred from the absence of two substrings meant that empty or
// truncated stdout — an output cap, a runtime that starts and writes nothing —
// read as confinement, certifying a run whose assertions may never have
// executed.
let report: ScanReport & { ran?: boolean; readOutside?: boolean; reachedNet?: boolean } = {};
try {
  report = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).pop() ?? "{}");
} catch {
  /* leave empty — handled below */
}
if (report.ran !== true || typeof report.sawHostProcess !== "boolean") {
  console.log(
    "\n>>> NOT PROVEN — the payload did not report running. Absence of a leak in\n" +
      "    empty output is not evidence of confinement.",
  );
  finish(1);
}
// "saw nothing" only counts if the payload could look. Without /proc inside the
// sandbox, or without readable namespace links and a parsed session id, every
// check below passes vacuously.
if (
  report.procReadable !== true ||
  typeof report.ipc !== "string" ||
  report.ipc === "" ||
  typeof report.uts !== "string" ||
  report.uts === "" ||
  typeof report.sid !== "number" ||
  report.sid < 0
) {
  console.log(
    "\n>>> NOT PROVEN — the payload could not read /proc inside the sandbox (procReadable,\n" +
      "    namespace links or session id missing), so \"saw nothing\" is not evidence.",
  );
  finish(1);
}
const sharesIpc = report.ipc === hostIpc;
const sharesUts = report.uts === hostUts;
const sharesSession = report.sid === 0;
const leaked =
  report.readOutside === true ||
  report.reachedNet === true ||
  report.sawHostProcess === true ||
  sharesIpc ||
  sharesUts ||
  sharesSession;
console.log(
  leaked
    ? "\n>>> NOT CONFINED — the payload ran and reached outside the sandbox:\n" +
        `    read /etc/passwd: ${report.readOutside}, reached the network: ${report.reachedNet}, ` +
        `saw a host process: ${report.sawHostProcess},\n` +
        `    shares the host IPC namespace: ${sharesIpc}, shares the host UTS namespace: ${sharesUts},\n` +
        `    shares the host terminal session (sid ${report.sid}): ${sharesSession}`
    : "\n>>> CONFINED — the payload ran, could not read /etc/passwd, had no network,\n" +
        "    could not see a host process, and had its own IPC namespace, UTS namespace\n" +
        `    and session (sid ${report.sid})`,
);
finish(leaked ? 1 : 0);
