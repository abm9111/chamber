/**
 * `chamber try` — the whole point of Chamber, in one command, on nothing.
 *
 * The README used to ask for a clone, an `npm link`, a `chamber init` and a
 * hand-edited config before anything could be demonstrated, and its example
 * transcripts cited files that do not exist in this repo. So the one thing worth
 * seeing — a stored conclusion invalidated because its source moved — could not
 * actually be run by anyone evaluating the tool.
 *
 * This seeds a throwaway workspace, runs the real code paths against it, and
 * ends on the failure. No config, no model, no network: `pay-debt` attaches a
 * verified pin from the corpus, which is what makes the drift beat reachable
 * without a chat model.
 *
 * Order is deliberate, and copied from in-toto's demo — the only tool in this
 * space whose walkthrough stages its own failure. Green first, so the reader
 * knows what working looks like; then an announced edit, so the failure is
 * clearly caused rather than encountered; then red. An unannounced non-zero
 * exit at the end of a demo reads as the tool crashing.
 */

import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { openChamberDb } from "./db.ts";
import { ingestDirectory } from "./ingest.ts";
import { countDocuments, searchVector } from "./vector.ts";
import { commitBelief } from "./commit_belief.ts";
import { listOpenDebts, proposeAllDebtPayments } from "./debt.ts";
import { verifyBeliefSources } from "./pins.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/demo");

/**
 * Emphasis, but only into a terminal.
 *
 * `process.stdout.isTTY` is false when this is piped, redirected, or run by the
 * CLI test that asserts the demo still ends on `hash_mismatch` — so the escape
 * codes never reach a log file or a string comparison. A demo that only reads
 * correctly on a screen is fine; one that corrupts its own test is not.
 */
const tty = (): boolean => process.stdout.isTTY === true;
const bold = (t: string): string => (tty() ? `\u001b[1m${t}\u001b[0m` : t);
const red = (t: string): string => (tty() ? `\u001b[31m${t}\u001b[0m` : t);
const dim = (t: string): string => (tty() ? `\u001b[2m${t}\u001b[0m` : t);

/** What a reader could type to reproduce the step they are watching. */
function step(command: string, note?: string): void {
  console.log(`\n$ ${command}`);
  if (note) console.log(`  ${note}`);
}

function line(text = ""): void {
  console.log(text ? `  ${text}` : "");
}

const CLAIM = "Customers may return any purchase within 30 days of delivery.";

export function runTry(opts: { keep?: boolean } = {}): number {
  const work = mkdtempSync(join(tmpdir(), "chamber-try-"));
  const notes = join(work, "notes");
  const dbPath = join(work, "chamber.sqlite");
  let db: DatabaseSync | null = null;

  try {
    seedNotes(notes);
    console.log(bold("Chamber — a demonstration on a throwaway workspace."));
    line(dim(`workspace: ${work}`));
    line("nothing here touches your real database, config, or notes.");
    // Commands below are shown as they would be typed *from inside* that
    // workspace. Printing the absolute path on every step cost a line of noise
    // each time and pushed the part worth watching off the screen.

    db = openChamberDb(dbPath);

    step("chamber ingest ./notes", "index two sample notes");
    const ing = ingestDirectory(db, notes, {});
    line(`ingested ${ing.ingested} file(s) as ${ing.passages} passage(s)`);

    step("chamber corpus", "what is actually in the index");
    line(`${countDocuments(db)} passages`);

    step('chamber search "refund policy"');
    const hits = searchVector(db, "refund policy", { k: 2 });
    for (const h of hits) {
      line(`${h.score.toFixed(4)}  ${h.title ?? h.sourceRef}`);
    }

    step(`chamber believe belief "${CLAIM}"`, "asserted with no source attached");
    const committed = commitBelief(db, {
      type: "belief",
      text: CLAIM,
      sources: [],
      authorFamily: "demo",
      path: "deep",
    });
    if (!committed.ok) {
      line(`unexpected refusal: ${committed.reason}`);
      return 1;
    }
    line(`committed ${committed.beliefId}`);
    line("an unsourced assertion is not refused — it mints citation debt.");

    step("chamber debts", "the claim owes evidence");
    for (const d of listOpenDebts(db)) line(`${d.id}  [${d.status}]`);

    step("chamber pay-debt", "search the corpus for something that supports it");
    for (const p of proposeAllDebtPayments(db)) line(`${p.status}: ${p.reason}`);

    step("chamber verify", "re-check every stored pin against the corpus");
    const clean = verifyBeliefSources(db);
    for (const b of clean) line(`${b.beliefId}  ${b.verified}/${b.total} pins verified`);
    line("");
    line("That is the ordinary state: a belief standing on a pin that still holds.");

    // ---- the announced tamper -------------------------------------------
    console.log("\n" + "─".repeat(66));
    console.log("Now the point. Someone edits the note the belief was built on:");
    console.log("  refunds.md   30 days  ->  14 days");
    console.log("  refunds.md   original payment method  ->  store credit only");
    console.log("─".repeat(66));

    copyFileSync(join(FIXTURES, "refunds.after.md"), join(notes, "refunds.md"));

    step("chamber ingest ./notes", "re-index after the edit");
    const re = ingestDirectory(db, notes, {});
    line(`ingested ${re.ingested} file(s) as ${re.passages} passage(s)`);

    step("chamber verify");
    const after = verifyBeliefSources(db);
    let drifted = 0;
    for (const b of after) {
      line(`${b.beliefId}  ${b.verified}/${b.total} pins verified`);
      for (const f of b.failures) {
        drifted++;
        line(`  ${red(bold(`${f.reason}: ${f.sourceRef ?? f.refId}`))}`);
      }
    }

    console.log("");
    if (drifted === 0) {
      console.log("Expected the pin to drift and it did not — that is a bug, not a demo.");
      return 1;
    }
    console.log(
      "The conclusion did not change. The ground under it did, and Chamber\n" +
        "noticed without being asked. That is the whole product.",
    );
    console.log(
      "\nNothing here needed a model or a network. Next: `chamber init`, point\n" +
        "`ingest` at your own notes, and run `chamber verify` on a schedule.",
    );
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      /* the workspace is going away anyway */
    }
    if (opts.keep) {
      console.log(`\nworkspace kept at ${work}`);
    } else {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

/** Copy the checked-in sample notes into the throwaway workspace. */
function seedNotes(notes: string): void {
  mkdirSync(notes, { recursive: true });
  for (const f of ["refunds.md", "office.md"]) {
    copyFileSync(join(FIXTURES, f), join(notes, f));
  }
}
