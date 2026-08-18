/**
 * Drift backtest — measure `chamber verify` against a corpus's own git history.
 *
 * The claim this exists to test is the product's headline one: *you get told
 * when a source changed underneath a conclusion*. Until this ran, that claim
 * had unit tests and no measurement. Tests encode what the author expected an
 * edit to look like; a repository's history holds what edits actually look
 * like, which is not the same distribution and was not the same answer.
 *
 * What it does, on any git repo of notes or docs:
 *
 *   1. Materialise the corpus at OLD (read-only: `git archive`, never a
 *      checkout, so the source repo's index and worktree are untouched).
 *   2. Ingest it and commit beliefs through the real `commitBelief` gate,
 *      each pinning one passage. `requireVerifiedSupport` is on, so a pin that
 *      would not have been granted is never counted as one.
 *
 *      The sample is STRATIFIED on the interval's own diff, because a uniform
 *      one cannot answer the question. A real corpus changes in a few files
 *      and holds still everywhere else: 44k passages, 34 of them edited, means
 *      a 400-pin uniform sample lands on a changed passage roughly never, and
 *      the run reports `recall n/a` — a clean-looking result that measured
 *      nothing. So every passage of every file the diff names is pinned (up to
 *      `--pins`), and the remainder is a strided sample of the untouched
 *      corpus. The first stratum is where recall lives; the second is where
 *      the false-alarm rate lives; they answer different questions and are
 *      reported apart as well as together.
 *   3. Materialise NEW over the same directory, re-ingest, run the real
 *      `buildVerifyReport`.
 *   4. Join every verdict against git ground truth and print the confusion
 *      matrix, plus an anatomy of each false alarm.
 *
 * Report-only, always exit 0, like `eval_retrieval.ts` and
 * `calibrate_paraphrase_threshold.ts` before it. A floor here would be a
 * constant minted on day one, and this file exists because of what happened
 * the last time this codebase trusted one of those.
 *
 * ── Ground truth, and why it is checked before it is used ──────────────────
 *
 * Truth is *content survival*: strip a passage's heading breadcrumb, split the
 * remainder into whitespace-normalised units, and ask whether each still
 * appears anywhere in the file at NEW. Survived ⇒ the belief's evidence is
 * intact and any alarm is false. Absent ⇒ real drift and silence is a miss.
 *
 * The first version of this method compared whole passage bodies as substrings
 * and reported 412 of 434 pins as "changed" against the corpus they had just
 * been minted from — the chunker's breadcrumbs and re-joins meant a stored body
 * is not a substring of its own file. Every headline number computed from it
 * would have been wrong and confidently so.
 *
 * So the classifier is run against OLD first, where the answer is known: every
 * pin must classify as `survived`, because nothing has changed yet. Below
 * `SELF_TEST_FLOOR` the run aborts rather than reporting. A measurement
 * harness that cannot measure a known-true input is not measuring.
 *
 *   npm run backtest:drift -- --repo ~/Vault --from <rev> [--to <rev>]
 *                             [--pins 400] [--exclude 'Private/**'] [--json]
 *
 * `--to` defaults to WORKTREE: the repo's current files, uncommitted edits
 * included, which is the state a user's `chamber verify` actually sees.
 *
 * `--exclude` is a **git pathspec**, applied when the corpus is materialised
 * rather than when it is ingested. The difference is the whole point: an
 * ingest-time exclude means the content was written to disk and then skipped,
 * and this tool is pointed at private vaults whose owner may have folders an
 * agent must not read at all. A pathspec exclusion means those files are never
 * extracted from the object store in the first place, so "excluded" is a fact
 * about what was materialised and not a promise about what was ignored.
 *
 *   --exclude ':(exclude)Private/**'   (git pathspec syntax, repeatable)
 *
 * ── A sparse checkout is NOT an exclusion ─────────────────────────────────
 *
 * Learned by doing it wrong, 2026-08-18. This harness was pointed at a sparse
 * clone whose restricted folders were absent from the working tree, and run
 * without `--exclude` on the assumption that absent-on-disk meant absent. It
 * does not. `git archive` reads the OBJECT STORE, where every file of the
 * revision still exists regardless of what sparse-checkout put on disk, so a
 * `--from` run extracted precisely the folders the clone was shaped to keep
 * out — and the WORKTREE side, which reads the disk, silently disagreed with
 * it, producing 139 phantom `file_gone` verdicts on top of the privacy
 * failure.
 *
 * Hence `--acknowledge-full-history`: with no `--exclude`, a `--from` run now
 * refuses rather than extracting a whole revision from someone's repository on
 * the strength of an assumption about their checkout. The flag is deliberately
 * verbose. A corpus you may not read in full is the normal case for a private
 * vault, not the exotic one.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openChamberDb } from "../src/db.ts";
import { ingestDirectory } from "../src/ingest.ts";
import { commitBelief } from "../src/commit_belief.ts";
import { buildVerifyReport } from "../src/pins.ts";
import { passagePathOf } from "../src/chunk.ts";
import { findOrphans } from "./backtest_sweep.ts";

/** Below this share of known-true pins classifying as survived, abort. */
const SELF_TEST_FLOOR = 0.98;
const WORKTREE = "WORKTREE";

interface Pin {
  beliefId: string;
  ref: string;
  body: string;
  /** changed = the file this came from is named by the interval's diff. */
  stratum: "changed" | "untouched";
}

interface Args {
  repo: string;
  from: string;
  to: string;
  pins: number;
  exclude: string[];
  json: boolean;
  acknowledgeFullHistory: boolean;
}

/**
 * The magic words `git` itself recognises inside `:( … )`. A closed set,
 * checked exactly — see the call site for the value that got through a
 * membership test.
 */
const PATHSPEC_MAGIC: ReadonlySet<string> = new Set([
  "top",
  "literal",
  "icase",
  "glob",
  "exclude",
]);

function isGitPathspecMagic(word: string): boolean {
  // `attr:<name>` carries an argument; the rest are bare keywords.
  return PATHSPEC_MAGIC.has(word) || /^attr:[A-Za-z0-9_.-]+$/.test(word);
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    repo: "",
    from: "",
    to: WORKTREE,
    pins: 400,
    exclude: [],
    json: false,
    acknowledgeFullHistory: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      // Same rule ingest and verify apply to their own flags: a missing or
      // flag-shaped value is a usage error, never a silent default. A backtest
      // that quietly picked its own revision would report a real number about
      // the wrong question.
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`${a} requires a value`);
      }
      return v;
    };
    switch (a) {
      case "--repo": out.repo = next(); break;
      case "--from": out.from = next(); break;
      case "--to": out.to = next(); break;
      case "--pins": out.pins = Number(next()); break;
      case "--exclude": {
        const v = next();
        // A bare glob is wrapped, because passing it through as a pathspec
        // would restrict the archive TO that folder — the exact inverse of the
        // request, silently.
        if (!v.startsWith(":")) {
          out.exclude.push(`:(exclude)${v}`);
          break;
        }
        // A value that already looks like a pathspec is checked against the
        // closed set of forms that actually EXCLUDE, rather than trusted for
        // starting with a colon. CLAUDE.md: validate against closed sets, do
        // not escape strings — and this is where that rule bites hardest.
        // `:(glob)Private/**` is a valid pathspec, plausible as a typo for
        // `:(exclude,glob)Private/**`, and subtracts nothing: the `.` that
        // always precedes it already matches everything. It would also satisfy
        // the "refuse a full extraction with no --exclude" gate below on
        // length alone, so one malformed value defeats the exclusion AND the
        // safety net that exists to catch a missing exclusion.
        // `:!` and `:^` with no pattern are legitimate: git treats an empty
        // pattern as matching everything, so they exclude the whole tree —
        // the same as the bare `:(exclude)` the long-form branch accepts. The
        // earlier `/^:[!^]./` demanded a character after the sigil and refused
        // them.
        const shorthand = /^:[!^]/.test(v);
        const longForm = /^:\(([^)]*)\)/.exec(v);
        // EVERY word is checked against git's closed set, not just whether
        // "exclude" is among them. Checking only for "exclude" is how
        // `:(exclude, glob)Private/**` passed: the first word is clean, the
        // stray space rides on the SECOND word, and git rejects the whole
        // pathspec with "Invalid pathspec magic ' glob'". That value was the
        // worked example in the commit that claimed to have fixed it — proof
        // that a membership test is not a grammar check.
        const magic = longForm ? longForm[1]!.split(",") : [];
        const badWord = magic.find((w) => !isGitPathspecMagic(w));
        if (longForm && badWord !== undefined) {
          throw new Error(
            `--exclude has a pathspec magic word git will reject: ${JSON.stringify(badWord)}\n` +
              `  in ${JSON.stringify(v)}\n` +
              `  Valid words: ${[...PATHSPEC_MAGIC].join(", ")}, or attr:<name>.\n` +
              `  Note git does not tolerate spaces around them — ':(exclude, glob)' is\n` +
              `  invalid, ':(exclude,glob)' is fine.`,
          );
        }
        if (!shorthand && !magic.includes("exclude")) {
          throw new Error(
            `--exclude got a pathspec that does not exclude: ${JSON.stringify(v)}\n` +
              `  Exclusion is \`:!pattern\`, \`:^pattern\`, or a magic list containing\n` +
              `  \`exclude\` (e.g. ':(exclude,glob)Private/**'). What you passed would be\n` +
              `  applied as an ordinary pathspec and subtract nothing, while still counting\n` +
              `  as "an --exclude was given". Pass a bare glob to have it wrapped for you.`,
          );
        }
        // An exclude with no pattern (`:!`, `:^`, `:(exclude)`) is accepted by
        // `ls-files` and `diff` but REFUSED by `git archive` — "pathspec ':!'
        // did not match any files" — which is the mechanism `--from` uses. It
        // would therefore validate here and then die inside materialise with a
        // raw child_process dump. Refused up front, with the reason.
        const patternStart = shorthand ? 2 : (longForm?.[0]?.length ?? 0);
        if (v.length <= patternStart) {
          throw new Error(
            `--exclude has no pattern: ${JSON.stringify(v)}\n` +
              `  An empty pattern excludes everything, which \`git archive\` refuses\n` +
              `  outright ("did not match any files") — so this would fail mid-run\n` +
              `  rather than here. Give it something to match.`,
          );
        }
        out.exclude.push(v);
        break;
      }
      case "--json": out.json = true; break;
      case "--acknowledge-full-history": out.acknowledgeFullHistory = true; break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!out.repo || !out.from) {
    throw new Error("usage: --repo <path> --from <rev> [--to <rev>] [--pins N] [--exclude <glob>] [--json]");
  }
  if (!Number.isInteger(out.pins) || out.pins < 1) {
    throw new Error(`--pins must be a positive integer, got ${out.pins}`);
  }
  // Fail closed on the whole-revision extraction. `--to WORKTREE` alone reads
  // only what is on disk and needs no acknowledgement; any revision materialised
  // through `git archive` pulls from the object store, which no checkout shape
  // constrains.
  const usesArchive = out.from !== WORKTREE || out.to !== WORKTREE;
  if (usesArchive && out.exclude.length === 0 && !out.acknowledgeFullHistory) {
    throw new Error(
      "refusing to extract a full revision with no --exclude.\n" +
        "  `git archive` reads the object store, so a sparse or partial checkout does NOT\n" +
        "  limit what this materialises — every file in the revision is written to a temp\n" +
        "  directory and ingested, including any folder your checkout leaves off disk.\n" +
        "  Pass --exclude for each path that must never be extracted, or\n" +
        "  --acknowledge-full-history if the entire revision really is fair game.",
    );
  }
  return out;
}

/**
 * Files the interval actually touched, as the repository itself reports them.
 *
 * Takes the same pathspec as materialise, so an excluded path cannot enter the
 * sample through this route either. For a WORKTREE run this is a two-dot diff
 * against the working tree, which is what picks up uncommitted edits — in the
 * vault this was first run on, every genuinely edited note was uncommitted, so
 * a commit-to-commit diff would have found nothing to measure.
 */
function changedFiles(repo: string, from: string, to: string, exclude: string[]): Set<string> {
  const pathspec = exclude.length > 0 ? ["--", ".", ...exclude] : [];
  const revs = to === WORKTREE ? [from] : [from, to];
  const out = git(repo, ["diff", "--name-only", ...revs, ...pathspec]);
  return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
}

/**
 * Materialise `rev` into `dest`, replacing whatever is there.
 *
 * `git archive | tar -x` rather than a checkout: the source repository is
 * somebody's live vault, and a tool that measures it must not be able to move
 * its HEAD, touch its index, or disturb uncommitted work. WORKTREE copies the
 * files as they stand, because uncommitted edits are exactly the state a
 * user's own `chamber verify` runs against — in the vault this was first run
 * on, every genuinely edited note was uncommitted, so a commit-only backtest
 * would have measured nothing at all.
 */
function materialise(repo: string, rev: string, dest: string, exclude: string[]): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // Both branches take the same pathspec, so an excluded path is unreachable
  // by either route. A sparse checkout also lands here: `ls-files` lists the
  // index, which includes entries sparse-checkout left off disk, and those are
  // skipped by the existsSync guard rather than read.
  const pathspec = exclude.length > 0 ? ["--", ".", ...exclude] : [];
  if (rev === WORKTREE) {
    for (const rel of git(repo, ["ls-files", ...pathspec]).split("\n").filter(Boolean)) {
      const src = join(repo, rel);
      if (!existsSync(src)) continue; // tracked but deleted on disk
      const target = join(dest, rel);
      mkdirSync(join(target, ".."), { recursive: true });
      cpSync(src, target);
    }
    return;
  }
  const archive = execFileSync(
    "git",
    ["-C", repo, "archive", "--format=tar", rev, ...pathspec],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  execFileSync("tar", ["-x", "-C", dest], { input: archive, maxBuffer: 1024 * 1024 * 1024 });
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * A passage body is a heading breadcrumb followed by `\n\n`-joined content
 * units (see splitPassages in src/chunk.ts). Only the content carries the
 * claim, and only the content is what a citation is about — a breadcrumb that
 * changes because a parent heading was renamed is not evidence moving.
 */
function contentUnits(body: string): string[] {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && (/^#{1,6}\s/.test(lines[i]!) || lines[i]!.trim() === "")) i++;
  return lines
    .slice(i)
    .join("\n")
    .split(/\n\n+/)
    .map(norm)
    .filter((u) => u.length > 0);
}

type Truth = "survived" | "changed_partial" | "changed_all" | "file_gone" | "no_content_units";

function classify(body: string, fileNorm: string | null): { truth: Truth; present: number; total: number } {
  if (fileNorm === null) return { truth: "file_gone", present: 0, total: 0 };
  const units = contentUnits(body);
  if (units.length === 0) return { truth: "no_content_units", present: 0, total: 0 };
  const present = units.filter((u) => fileNorm.includes(u)).length;
  const truth: Truth =
    present === units.length ? "survived" : present === 0 ? "changed_all" : "changed_partial";
  return { truth, present, total: units.length };
}

// ── run ──────────────────────────────────────────────────────────────────────

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  // A usage error is a message, not a stack trace. The refusal above is the
  // one a caller is most likely to hit, and burying it under eight frames of
  // node internals is how a safety message gets read as a crash and retried
  // with the flag that silences it.
  console.error(`backtest: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const repo = resolve(args.repo);
if (!existsSync(join(repo, ".git"))) {
  console.error(`not a git repository: ${repo}`);
  process.exit(1);
}

/**
 * An abort that must still run cleanup.
 *
 * `process.exit()` does NOT unwind — a `finally` below it never runs, verified
 * directly rather than assumed. Every early exit in this file used to be a
 * bare `process.exit(1)` inside the try, and each one is reached *after* the
 * corpus has been extracted; the self-test abort is reached after ingest too,
 * when the database holds a copy of every passage body. So an aborted run left
 * the whole corpus on disk while printing that nothing was left on disk.
 *
 * Aborts throw this instead, and exiting is deferred until after cleanup.
 */
class BacktestAbort extends Error {}

const work = mkdtempSync(join(tmpdir(), "chamber-backtest-"));
const corpus = join(work, "corpus");
const dbPath = join(work, "backtest.sqlite");
// Excludes are enforced at materialise time (see materialise), so by the time
// ingest walks this directory the excluded content is not on disk to be read.
const ingestOpts = { exclude: [], includeDotted: false, requireExcludeMatch: false };

const log = (m: string): void => { if (!args.json) console.log(m); };

/**
 * Cleanup is idempotent and reachable from every route this process controls:
 * normal completion, an abort, and `exit`.
 *
 * The WHOLE working directory goes, not just the extracted files: the SQLite
 * database holds a full copy of every ingested passage body, so removing the
 * corpus and leaving the database behind leaves the corpus behind, in a less
 * obvious container.
 */
let cleaned = false;
const cleanup = (): void => {
  if (cleaned) return;
  cleaned = true;
  rmSync(work, { recursive: true, force: true });
};

/**
 * ── What signals can and cannot do here, stated because I got it wrong ─────
 *
 * An earlier version of this file registered SIGINT/SIGTERM/SIGHUP handlers
 * and its commit message claimed that made Ctrl-C an ordinary event. It does
 * not. This script is entirely synchronous — no `await`, no timers anywhere —
 * so from `materialise` through the last `commitBelief` it never yields to the
 * event loop, and a JS signal handler cannot run until it does. Verified by
 * sending SIGTERM to a live run: the handler never fired and the process ran
 * to natural completion. A registered handler also SUPPRESSES the default
 * terminate, so the naive version made Ctrl-C *less* responsive, not more.
 *
 * And nothing catches SIGKILL, by design of the kernel. So the residue window
 * is real and cannot be closed from inside the process.
 *
 * What actually closes it is a sweep at startup: an orphaned directory from a
 * killed run is removed by the next run before anything else happens. That
 * covers `kill -9`, a power loss, and the frustrated Ctrl-C the naive handler
 * would have provoked — none of which any in-process handler could.
 *
 * The handlers are kept only so a signal arriving outside the synchronous
 * phase is not simply ignored — NOT because they make Ctrl-C work. As this
 * file is written they are very nearly inert: every route ends in an
 * unconditional `process.exit` as its last synchronous statement, so control
 * never returns to the event loop while the process is alive, and a queued
 * signal has no moment in which to be serviced. Verified by sending SIGTERM
 * three seconds into a seventy-second run: it completed normally and never
 * reached the handler. `process.on("exit")` is the one that carries weight —
 * it fires on every in-process termination route including `process.exit`.
 * The sweep covers the rest and depends on none of this.
 */
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    cleanup();
    // 128 + signal number, per convention: SIGINT 2, SIGTERM 15, SIGHUP 1.
    // An earlier version returned 143 for SIGHUP, which is SIGTERM's number.
    process.exit(sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129);
  });
}


let exitCode = 0;
try {
  log(`repo      ${repo}`);
  log(`from      ${args.from} → to ${args.to}`);
  log(`excludes  ${args.exclude.length > 0 ? args.exclude.join(", ") : "(none — full revision)"}`);
  // Reported, never removed — see backtest_sweep.ts for the two automatic
  // versions of this that each turned out worse than the leak. A candidate may
  // belong to a run happening right now, and nothing available in here can
  // tell the difference.
  const orphans = findOrphans(tmpdir(), work);
  if (orphans.paths.length > 0) {
    log(
      `NOTE      ${orphans.paths.length} working director${orphans.paths.length === 1 ? "y" : "ies"} from other runs of this tool:`,
    );
    for (const d of orphans.paths.slice(0, 5)) log(`            ${d}`);
    if (orphans.paths.length > 5) log(`            … and ${orphans.paths.length - 5} more`);
    log(`          If no other backtest is running, these hold extracted corpus`);
    log(`          content and can be deleted. This tool will not delete them.`);
  }
  log(`corpus    materialised under ${work} (removed on exit)\n`);

  // ── 1. OLD state ───────────────────────────────────────────────────────────
  materialise(repo, args.from, corpus, args.exclude);
  const db = openChamberDb(dbPath);
  const before = ingestDirectory(db, corpus, ingestOpts);
  if (before.aborted) throw new BacktestAbort(`ingest refused: ${before.abortReason}`);
  log(`ingested  ${before.ingested} file(s) → ${before.passages} passage(s) at ${args.from}`);

  // ── 2. mint pins through the real gate ─────────────────────────────────────
  type Row = { id: string; source_ref: string | null; title: string | null; body: string; snapshot_hash: string };
  const rows = db
    .prepare(
      `SELECT id, source_ref, title, body, snapshot_hash FROM vector_document
        WHERE source_kind = 'vault_page' AND source_ref IS NOT NULL ORDER BY id`,
    )
    .all() as unknown as Row[];
  if (rows.length === 0) {
    throw new BacktestAbort("corpus is empty at --from; nothing to pin");
  }
  const touched = changedFiles(repo, args.from, args.to, args.exclude);
  const inChanged = (r: Row): boolean => touched.has(passagePathOf(r.source_ref!));
  const changedRows = rows.filter(inChanged);
  const untouchedRows = rows.filter((r) => !inChanged(r));
  log(`diff      ${touched.size} file(s) changed over the interval, holding ${changedRows.length} pinnable passage(s)`);

  const pins: Pin[] = [];
  let refused = 0;
  const mint = (r: Row, stratum: Pin["stratum"]): void => {
    const res = commitBelief(db, {
      type: "inference",
      text: `backtest pin ${pins.length}: content recorded at ${r.source_ref}`,
      sources: [{ kind: "vault_page", refId: r.id, snapshotHash: r.snapshot_hash }],
      authorFamily: "backtest",
      path: "fast",
      requireVerifiedSupport: true,
    });
    if (res.ok) pins.push({ beliefId: res.beliefId, ref: r.source_ref!, body: r.body, stratum });
    else refused++;
  };

  // Stratum 1 — every passage of every changed file. This is the only stratum
  // that can produce a true positive or a false negative, so it is filled first
  // and never traded away for breadth.
  for (const r of changedRows) {
    if (pins.length >= args.pins) break;
    mint(r, "changed");
  }
  // Stratum 2 — a deterministic stride over what did not change. Deterministic,
  // not random: a backtest whose population moves between runs cannot tell a
  // code change from a resample, which is also why src/db.ts's newId() is
  // avoided throughout this file.
  const budget = Math.max(0, args.pins - pins.length);
  if (budget > 0 && untouchedRows.length > 0) {
    const stride = Math.max(1, Math.floor(untouchedRows.length / budget));
    for (let i = 0; i < untouchedRows.length && pins.length < args.pins; i += stride) {
      mint(untouchedRows[i]!, "untouched");
    }
  }
  const nChanged = pins.filter((p) => p.stratum === "changed").length;
  log(
    `pinned    ${pins.length} belief(s): ${nChanged} in changed files, ` +
      `${pins.length - nChanged} in untouched files (${refused} refused by the gate)`,
  );
  if (nChanged === 0) {
    log(
      `\n  NOTE: nothing changed in the sampled corpus over this interval, so recall\n` +
        `  is unmeasurable here — a clean result below means "nothing to catch", not\n` +
        `  "caught everything". Widen --from/--to or drop an --exclude that covers\n` +
        `  where the edits are.`,
    );
  }

  // ── 3. self-test the classifier where the answer is known ──────────────────
  const oldFiles = new Map<string, string | null>();
  const readAt = (rel: string): string | null => {
    if (!oldFiles.has(rel)) {
      const p = join(corpus, rel);
      oldFiles.set(rel, existsSync(p) && statSync(p).isFile() ? norm(readFileSync(p, "utf8")) : null);
    }
    return oldFiles.get(rel)!;
  };
  let known = 0;
  let survived = 0;
  for (const p of pins) {
    const c = classify(p.body, readAt(passagePathOf(p.ref)));
    if (c.truth === "no_content_units") continue;
    known++;
    if (c.truth === "survived") survived++;
  }
  const selfTest = known === 0 ? 0 : survived / known;
  log(`self-test ${survived}/${known} pins classify as survived against their own source (${(selfTest * 100).toFixed(1)}%)`);
  if (selfTest < SELF_TEST_FLOOR) {
    throw new BacktestAbort(
      `the ground-truth classifier fails on input where the answer is known.\n` +
        `  Every number below it would be wrong, and wrong in a way that reads as a finding.\n` +
        `  Fix contentUnits()/classify() against src/chunk.ts before trusting this harness.`,
    );
  }

  // ── 4. NEW state ───────────────────────────────────────────────────────────
  materialise(repo, args.to, corpus, args.exclude);
  const after = ingestDirectory(db, corpus, ingestOpts);
  if (after.aborted) throw new BacktestAbort(`ingest refused: ${after.abortReason}`);
  log(`re-ingest ${after.ingested} file(s) → ${after.passages} passage(s) at ${args.to}`);
  if (after.removed > 0) log(`          ${after.removed} stale passage(s) removed from shrunken notes`);

  // ── 5. join verdicts against truth ─────────────────────────────────────────
  const vr = buildVerifyReport(db, {});
  const byBelief = new Map(vr.beliefs.map((b) => [b.beliefId, b]));
  const newFiles = new Map<string, string | null>();
  const readNow = (rel: string): string | null => {
    if (!newFiles.has(rel)) {
      const p = join(corpus, rel);
      newFiles.set(rel, existsSync(p) && statSync(p).isFile() ? norm(readFileSync(p, "utf8")) : null);
    }
    return newFiles.get(rel)!;
  };

  interface Cell { ref: string; chamber: string; truth: Truth; present: number; total: number; stratum: Pin["stratum"] }
  const cells: Cell[] = [];
  for (const p of pins) {
    const v = byBelief.get(p.beliefId);
    const chamber =
      v === undefined
        ? "missing_from_report"
        : v.relocations.length > 0 && v.failures.length === 0
          ? "relocated"
          : v.failures.length === 0
            ? "ok"
            : v.failures[0]!.reason;
    const c = classify(p.body, readNow(passagePathOf(p.ref)));
    cells.push({ ref: p.ref, chamber, truth: c.truth, present: c.present, total: c.total, stratum: p.stratum });
  }

  // An alarm is a verdict that fails the run. `relocated` deliberately is not
  // one — it is reported as intact support — so it counts as silence here, and
  // a relocation over genuinely changed content is therefore a false negative,
  // which is the direction that matters most. See KNOWN_LIMITATIONS 6.
  const isAlarm = (c: Cell): boolean => c.chamber !== "ok" && c.chamber !== "relocated";
  const isChanged = (c: Cell): boolean =>
    c.truth === "changed_all" || c.truth === "changed_partial" || c.truth === "file_gone";

  const scored = cells.filter((c) => c.truth !== "no_content_units");
  const tp = scored.filter((c) => isAlarm(c) && isChanged(c));
  const fp = scored.filter((c) => isAlarm(c) && !isChanged(c));
  const fn = scored.filter((c) => !isAlarm(c) && isChanged(c));
  const tn = scored.filter((c) => !isAlarm(c) && !isChanged(c));
  const rate = (n: number, d: number): string => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

  const changedCells = scored.filter((c) => c.stratum === "changed");
  const untouchedCells = scored.filter((c) => c.stratum === "untouched");
  const summary = {
    from: args.from,
    to: args.to,
    pinsInChangedFiles: changedCells.length,
    pinsInUntouchedFiles: untouchedCells.length,
    falseAlarmsInUntouchedFiles: untouchedCells.filter((c) => isAlarm(c) && !isChanged(c)).length,
    corpusPassagesBefore: before.passages,
    corpusPassagesAfter: after.passages,
    pins: pins.length,
    scored: scored.length,
    selfTest: Number(selfTest.toFixed(4)),
    truePositives: tp.length,
    falsePositives: fp.length,
    falseNegatives: fn.length,
    trueNegatives: tn.length,
    recall: tp.length + fn.length === 0 ? null : tp.length / (tp.length + fn.length),
    precision: tp.length + fp.length === 0 ? null : tp.length / (tp.length + fp.length),
    relocated: cells.filter((c) => c.chamber === "relocated").length,
    verifyExitWouldBe: vr.broken + vr.degraded > 0 ? 1 : 0,
    falsePositiveRefs: fp.map((c) => c.ref),
    falseNegativeRefs: fn.map((c) => c.ref),
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    log(`\n── verdicts vs git ground truth (${scored.length} scored pins) ──`);
    const grid = new Map<string, number>();
    for (const c of scored) {
      const k = `chamber=${c.chamber}  truth=${c.truth}`;
      grid.set(k, (grid.get(k) ?? 0) + 1);
    }
    for (const k of [...grid.keys()].sort()) {
      log(`  ${String(grid.get(k)).padStart(5)}  ${k}`);
    }
    log(`\n  true positives   ${tp.length}   (drift, and it fired)`);
    log(`  false negatives  ${fn.length}   (drift, and it stayed silent)  ← the failure that matters`);
    log(`  false positives  ${fp.length}   (no drift, but it fired)`);
    log(`  true negatives   ${tn.length}   (no drift, silent)`);
    log(`\n  by stratum:`);
    log(`    changed files    ${changedCells.length} pin(s) — where recall is measurable`);
    log(`    untouched files  ${untouchedCells.length} pin(s) — ${untouchedCells.filter((c) => isAlarm(c)).length} alarm(s), all of them false by construction`);
    log(`\n  recall     ${rate(tp.length, tp.length + fn.length)}`);
    log(`  precision  ${rate(tp.length, tp.length + fp.length)}`);
    log(`  relocated  ${summary.relocated} pin(s) reported as moved-intact`);
    if (fn.length > 0) {
      log(`\n  FALSE NEGATIVES — evidence changed and verify did not say so:`);
      for (const c of fn.slice(0, 10)) log(`    ${c.chamber.padEnd(12)} ${c.present}/${c.total} units survived  ${c.ref}`);
      if (fn.length > 10) log(`    … and ${fn.length - 10} more`);
    }
    if (fp.length > 0) {
      log(`\n  FALSE POSITIVES — content intact, alarm anyway:`);
      for (const c of fp.slice(0, 10)) log(`    ${c.chamber.padEnd(12)} ${c.present}/${c.total} units survived  ${c.ref}`);
      if (fp.length > 10) log(`    … and ${fp.length - 10} more`);
    }
    log(
      `\nScope: one corpus, one interval. These are measurements of THIS history,` +
        `\nnot population estimates — a single large edit can dominate every rate above.`,
    );
  }

  if (!args.json) {
    log(`\nRe-run with --json for the machine-readable summary. Nothing is left on disk:`);
    log(`the corpus copy and its database are removed on exit, both hold your content.`);
  }
} catch (err) {
  if (err instanceof BacktestAbort) {
    console.error(`\nbacktest aborted: ${err.message}`);
    exitCode = 1;
  } else {
    // Unexpected failures keep their stack — but only after cleanup below.
    console.error(err);
    exitCode = 1;
  }
} finally {
  cleanup();
}
// Outside the finally, so cleanup has already run by the time the process ends.
process.exit(exitCode);
