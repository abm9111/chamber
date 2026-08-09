/**
 * Measure the paraphrase debt gate's threshold against a labelled set.
 *
 * The shipped 0.8 came from exactly one pair — a paraphrase at 0.834 and an
 * unrelated sentence at 0.030. That shows two points are separable; it does not
 * show where the boundary belongs. This scores ~25 labelled pairs across
 * paraphrase, near-miss, contradiction, entity swap, number swap, unrelated,
 * cross-lingual and long-form, and prints the tradeoff.
 *
 * It deliberately recommends no number. At this sample size an ROC optimum is
 * noise wearing a decimal point; the useful output is the separation band and
 * which pairs sit in it, so a human chooses against a cost they can name. A
 * false positive refuses a commit and names the debt that did it — visible and
 * answerable. A false negative is the silent escape probes/debt_paraphrase.ts
 * exists to close.
 *
 *   npm run calibrate:paraphrase
 *   node --experimental-strip-types scripts/calibrate_paraphrase_threshold.ts --json
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { embedLocalBatch, minilmAvailable } from "../src/embedder.ts";
import { cosineSimilarity } from "../src/vector.ts";

interface Pair {
  id: string;
  category: string;
  same: boolean;
  a: string;
  b: string;
  why?: string;
  unmetBy?: string[];
  unmetWhy?: string;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "fixtures/paraphrase_calibration.json");

const wantJson = process.argv.includes("--json");

/**
 * Refuse before embedding anything if the real model is not there.
 *
 * `embedLocalBatch(texts, "minilm")` does NOT throw when the model files are
 * missing — it rewrites `kind` to "hash" first, and hash vectors are character
 * n-grams. A run without the model would print a clean-looking sweep built on
 * string overlap, and the number_swap pairs, which differ by two characters,
 * would score highest of all. That is a calibration that looks fine and means
 * nothing, which is worse than no calibration.
 */
if (!minilmAvailable()) {
  console.error(
    "refusing to calibrate: the MiniLM model files are not available, and the\n" +
      "batch embedder silently falls back to character-n-gram hash vectors.\n" +
      "A sweep built on those looks plausible and measures string overlap.\n" +
      "Install the model and a python3 with onnxruntime, then re-run.",
  );
  process.exit(2);
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { pairs: Pair[] };
const pairs = fixture.pairs;

// One batch, deduped: embedMinilmBatch spawns python once, so this is a single
// process regardless of set size.
const texts = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
const embeds = embedLocalBatch(texts, "minilm");

// Re-assert what we actually got. The guard above checks the files exist; this
// checks the vectors in hand are the ones we asked for.
const bad = embeds.find((e) => e.kind !== "minilm");
if (bad) {
  console.error(`refusing to calibrate: expected minilm vectors, got "${bad.kind}"`);
  process.exit(2);
}
const model = embeds[0]!.model;
if (embeds.some((e) => e.model !== model)) {
  console.error("refusing to calibrate: the batch mixed models");
  process.exit(2);
}

const vec = new Map(texts.map((t, i) => [t, embeds[i]!.vector]));
const scored = pairs
  .map((p) => ({
    ...p,
    score: cosineSimilarity(vec.get(p.a)!, vec.get(p.b)!),
    excluded: (p.unmetBy ?? []).includes(model),
  }))
  .sort((x, y) => y.score - x.score);

const counted = scored.filter((p) => !p.excluded);
const sames = counted.filter((p) => p.same);
const diffs = counted.filter((p) => !p.same);

const sweep = [];
for (let t = 0.5; t <= 0.99001; t += 0.01) {
  const thr = Number(t.toFixed(2));
  sweep.push({
    threshold: thr,
    fn: sames.filter((p) => p.score < thr).length,
    fnTotal: sames.length,
    fp: diffs.filter((p) => p.score >= thr).length,
    fpTotal: diffs.length,
  });
}

if (wantJson) {
  console.log(
    JSON.stringify(
      {
        model,
        kind: "minilm",
        dims: embeds[0]!.dims,
        pairs: scored.map((p) => ({
          id: p.id,
          category: p.category,
          same: p.same,
          score: p.score,
          excluded: p.excluded,
        })),
        sweep,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`model ${model}  dims=${embeds[0]!.dims}`);
console.log(
  `pairs ${pairs.length}   same ${sames.length}   different ${diffs.length}   ` +
    `excluded (unmetBy) ${scored.length - counted.length}`,
);

console.log("\nscores, descending");
for (const p of scored) {
  const tag = p.excluded ? "SKIP" : p.same ? "SAME" : "DIFF";
  const note = p.excluded ? `  [excluded: ${model}]` : "";
  console.log(
    `  ${p.score.toFixed(3)}  ${tag}  ${p.category.padEnd(14)} ${p.id}${note}`,
  );
}

const lowestSame = sames.reduce((lo, p) => (p.score < lo.score ? p : lo), sames[0]!);
const highestDiff = diffs.reduce((hi, p) => (p.score > hi.score ? p : hi), diffs[0]!);
console.log("\nseparation");
console.log(`  lowest  SAME ${lowestSame.score.toFixed(3)} (${lowestSame.id})`);
console.log(`  highest DIFF ${highestDiff.score.toFixed(3)} (${highestDiff.id})`);
console.log(
  lowestSame.score > highestDiff.score
    ? `  CLEAN gap of ${(lowestSame.score - highestDiff.score).toFixed(3)} — any threshold inside it classifies the set perfectly`
    : `  OVERLAP ${(highestDiff.score - lowestSame.score).toFixed(3)} wide — no threshold classifies this set perfectly`,
);

console.log("\nsweep (raw counts; N is small, percentages would flatter it)");
console.log("   thr    FN        FP");
for (const row of sweep) {
  if (Math.round(row.threshold * 100) % 5 !== 0) continue;
  console.log(
    `   ${row.threshold.toFixed(2)}   ${String(row.fn).padStart(2)}/${row.fnTotal}` +
      `     ${String(row.fp).padStart(2)}/${row.fpTotal}`,
  );
}

const firstClean = sweep.find((r) => r.fp === 0);
console.log(
  `\n  first FP-free threshold: ${firstClean ? firstClean.threshold.toFixed(2) : "none"}` +
    (firstClean ? `  (FN ${firstClean.fn}/${firstClean.fnTotal})` : ""),
);

console.log(
  "\nNo threshold is recommended. Pick one against the cost you accept: a false\n" +
    "positive refuses a commit and names the debt that did it; a false negative\n" +
    "is the silent escape the gate exists to close.",
);
