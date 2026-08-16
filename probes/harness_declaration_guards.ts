/**
 * PROBE: a test declared past the harness's own report block is silently lost.
 *
 * `tests/harness.ts` reads `pending` once (the drain loop) and `registered`
 * once (the summary). A `test()` call after either point increments a number
 * nobody looks at again, so both sides of the tally move together and the run
 * prints `N/N passed · 0 failed`, exit 0, having never invoked the test. That
 * is the failure this repository exists to catch, living in the thing that
 * reports whether the repository works.
 *
 * Two tests appended to the end of that file during a fix reported 370/370
 * with neither ever executed, and only broke cover because the fix they
 * guarded was deliberately reverted to watch them go red — and they did not.
 *
 * The guards that close it cannot be tested from inside the harness: both
 * throw at module load, which kills the process that would have reported the
 * result. So the probe runs the harness as a child, twice, each time with one
 * marker test spliced in past one of the two doors, and demands a crash.
 *
 *   node --experimental-strip-types probes/harness_declaration_guards.ts
 *
 * Fails (exit 1) if either late declaration is accepted, if the process exits
 * 0, or if the crash is not the guard's own message — a suite that dies for an
 * unrelated reason is not evidence that the guard fired.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = join(ROOT, "tests/harness.ts");
/**
 * The mutant lives beside the original, not in a temp directory.
 *
 * `tests/harness.ts` imports `../src/*.ts` relatively, so a copy under
 * `os.tmpdir()` dies with ERR_MODULE_NOT_FOUND before reaching a single
 * `test()` call — a crash, exit 1, and no evidence whatsoever about the guard.
 * The first version of this probe did exactly that; it reported an escape and
 * was right to, because "the process died" is not "the guard fired". Hence the
 * two-part assertion below.
 *
 * `.gitignore` carries this pattern in case the probe is killed mid-run.
 */
const MUTANT_DIR = join(ROOT, "tests");

/**
 * Where each marker goes, and what the guard must say when it fires.
 *
 * The anchors are the comment lines above the two flag assignments rather than
 * the assignments themselves, so a marker lands *after* the door is shut but
 * before anything downstream reads the state — which is the only window where
 * each condition is reachable on its own. Splicing an async test after
 * `reportingStarted` instead would fire the *other* guard and prove nothing
 * about this one.
 */
const CASES: { name: string; anchor: string; marker: string; expect: string }[] = [
  {
    name: "async test after the drain loop",
    anchor: "// From here the tally is fixed:",
    marker:
      'test("gates", "PROBE late async", async () => { assert(true, "unreachable"); });\n\n',
    expect: "was declared after the async queue was drained",
  },
  {
    name: "sync test after the summary",
    // The last line of the file's report block. Appending at EOF puts the
    // marker past both doors, and `reportingStarted` is checked first, so the
    // sync case has to be planted here to reach its own guard.
    anchor: null as unknown as string,
    marker: 'test("gates", "PROBE late sync", () => { assert(true, "unreachable"); });\n',
    expect: "was declared after the summary was computed",
  },
];

const source = readFileSync(HARNESS, "utf8");
const written: string[] = [];
let escaped = false;

try {
  for (const [i, c] of CASES.entries()) {
    const target = join(MUTANT_DIR, `.harness-guard-probe-${i}.ts`);
    written.push(target);
    let mutated: string;
    if (c.anchor === null) {
      mutated = `${source}\n${c.marker}`;
    } else {
      const at = source.indexOf(c.anchor);
      if (at < 0) {
        console.error(
          `PROBE BROKEN: anchor not found in tests/harness.ts: ${c.anchor}\n` +
            `The harness was restructured; re-point this probe rather than deleting it.`,
        );
        process.exit(1);
      }
      mutated = source.slice(0, at) + c.marker + source.slice(at);
    }
    writeFileSync(target, mutated);

    // --suite=gates keeps the child cheap: the marker declares into `gates`,
    // and the guards run before the suite filter precisely so a late test
    // cannot hide by naming a suite this run did not select.
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", target, "--suite=gates"],
      { encoding: "utf8", timeout: 300_000, cwd: ROOT },
    );

    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const said = output.includes(c.expect);
    const died = r.status !== 0;

    console.log(`${c.name}:`);
    console.log(`  exit status : ${r.status}`);
    console.log(`  guard fired : ${said}`);

    if (!died || !said) {
      escaped = true;
      console.log(
        `  >>> ESCAPE — a test declared here is accepted and never runs.` +
          (died ? ` The process died, but not for the guard's reason.` : ``) +
          `\n${output.slice(-1200)}`,
      );
    }
  }
} finally {
  for (const f of written) rmSync(f, { force: true });
}

console.log(
  escaped
    ? "\n>>> CONFIRMED — the harness accepts declarations it cannot count"
    : "\n>>> no escape — both late declarations are refused, non-zero",
);
process.exit(escaped ? 1 : 0);
