/**
 * Retrieval golden-set report — report BEFORE gate, like
 * calibrate_paraphrase_threshold.ts before it: this prints scores and always
 * exits 0. A floor belongs in CI only after the numbers have been watched
 * long enough to know what normal looks like, per embedder — a floor minted
 * on day one is another 0.8, a constant mistaken for a calibration.
 *
 * What it measures: recall@k (any judged-relevant passage in the top k) and
 * MRR (1/rank of the first relevant hit) over fixtures/retrieval_golden.json,
 * ingested fresh into :memory: through the real ingest path — chunker,
 * embedder, hybrid fusion all included, so the changes most likely to degrade
 * real retrieval (embedder swap, chunker change, lexical reweighting) move
 * these numbers. KNOWN_LIMITATIONS entry 12 is the gap this starts closing.
 *
 * Scores are meaningful only within one embedder model, so the model used is
 * printed first — comparing a hash-vector run against a MiniLM run is
 * comparing two different products.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openChamberDb } from "../src/db.ts";
import { ingestDirectory } from "../src/ingest.ts";
import { searchVector } from "../src/vector.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const K = 8;

interface GoldenQuery {
  q: string;
  relevant: string[];
  tier: string;
}

const golden = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/retrieval_golden.json"), "utf8"),
) as { queries: GoldenQuery[] };

const db = openChamberDb(":memory:");
const report = ingestDirectory(db, join(__dirname, "../fixtures/retrieval_corpus"));
if (report.aborted || report.ingested === 0) {
  console.error(`fixture corpus failed to ingest: ${report.abortReason ?? "0 files"}`);
  process.exit(1);
}

const modelRow = db
  .prepare(`SELECT DISTINCT model FROM vector_embedding`)
  .all() as { model: string }[];
console.log(
  `corpus: ${report.ingested} file(s), ${report.passages} passage(s) · ` +
    `embedder: ${modelRow.map((m) => m.model).join(", ")} · k=${K}\n`,
);

// recall@1 and recall@3, not recall@K: on a fixture corpus smaller than K,
// recall@K is 1.0 by construction — a metric that cannot fail is not a
// metric (the same rule the probes README applies to gates). Rank-sensitive
// scores are the ones the witnessed failure classes actually move.
interface TierScore {
  n: number;
  at1: number;
  at3: number;
  rrSum: number;
}
const byTier = new Map<string, TierScore>();
const misses: { q: string; tier: string; rank: number; top: string[] }[] = [];

for (const g of golden.queries) {
  const hits = searchVector(db, g.q, { k: K });
  const rank = hits.findIndex((h) =>
    g.relevant.includes(h.sourceRef ?? ""),
  );
  const t = byTier.get(g.tier) ?? { n: 0, at1: 0, at3: 0, rrSum: 0 };
  t.n += 1;
  if (rank === 0) t.at1 += 1;
  if (rank >= 0 && rank < 3) t.at3 += 1;
  if (rank >= 0) t.rrSum += 1 / (rank + 1);
  if (rank !== 0) {
    misses.push({
      q: g.q,
      tier: g.tier,
      rank,
      top: hits.slice(0, 3).map((h) => h.sourceRef ?? h.documentId),
    });
  }
  byTier.set(g.tier, t);
}

let n = 0;
let at1 = 0;
let at3 = 0;
let rrSum = 0;
console.log("tier         n   recall@1   recall@3   mrr");
for (const [tier, t] of byTier) {
  console.log(
    `${tier.padEnd(11)} ${String(t.n).padStart(2)}   ${(t.at1 / t.n).toFixed(2).padStart(8)}   ${(
      t.at3 / t.n
    )
      .toFixed(2)
      .padStart(8)}   ${(t.rrSum / t.n).toFixed(3)}`,
  );
  n += t.n;
  at1 += t.at1;
  at3 += t.at3;
  rrSum += t.rrSum;
}
console.log(
  `${"overall".padEnd(11)} ${String(n).padStart(2)}   ${(at1 / n).toFixed(2).padStart(8)}   ${(
    at3 / n
  )
    .toFixed(2)
    .padStart(8)}   ${(rrSum / n).toFixed(3)}`,
);

if (misses.length > 0) {
  console.log(`\nnot-first (${misses.length}):`);
  for (const m of misses) {
    console.log(
      `  [${m.tier}] rank ${m.rank < 0 ? "miss" : m.rank + 1}: "${m.q}"`,
    );
    console.log(`     top-3: ${m.top.join(" · ")}`);
  }
}
console.log(
  "\nreport-only: no floor, exit 0 — watch the numbers per embedder before ever gating on them.",
);
