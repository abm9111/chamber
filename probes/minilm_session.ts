/**
 * PROBE: one ingest of two changed files starts embed_minilm.py --serve once,
 * and each stored vector equals a fresh --json - vector for that body.
 *
 * Exits non-zero when each file starts its own interpreter, or when serve
 * mode disagrees with the one-shot path. The availability probe is a separate
 * start and is not counted.
 *
 *   node --experimental-strip-types probes/minilm_session.ts
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openChamberDb } from "../src/db.ts";
import { resetMinilmProbe } from "../src/embedder.ts";
import { ingestDirectory } from "../src/ingest.ts";
import { blobToFloat32, l2Normalize } from "../src/vector.ts";

const root = mkdtempSync(join(tmpdir(), "chamber-probe-minilm-session-"));
const log = join(root, "argv.log");
const real = process.env.CHAMBER_PYTHON?.trim() || "python3";
const script = fileURLToPath(new URL("../scripts/embed_minilm.py", import.meta.url));
const wrapper = join(root, "python-wrapper.py");
writeFileSync(
  wrapper,
  [
    "#!/usr/bin/env python3",
    "import json, os, sys",
    "with open(os.environ['CHAMBER_PROBE_LOG'], 'a') as fh:",
    "    fh.write(json.dumps(sys.argv[1:]) + '\\n')",
    "os.execv(os.environ['CHAMBER_PROBE_PYTHON'], [os.environ['CHAMBER_PROBE_PYTHON'], *sys.argv[1:]])",
    "",
  ].join("\n"),
);
chmodSync(wrapper, 0o755);
writeFileSync(join(root, "a.md"), "Alpha passage about copper wire.\n");
writeFileSync(join(root, "b.md"), "Beta passage about tin solder.\n");

process.env.CHAMBER_PYTHON = wrapper;
process.env.CHAMBER_PROBE_LOG = log;
process.env.CHAMBER_PROBE_PYTHON = real;
process.env.CHAMBER_EMBEDDER = "minilm";
delete process.env.CHAMBER_DB;
resetMinilmProbe();

const db = openChamberDb(join(root, "chamber.sqlite"));
const report = ingestDirectory(db, root, {});

const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
const argvs = lines.map((ln) => JSON.parse(ln) as string[]);

if (report.embedFallback) {
  console.error(`embedFallback: ${report.embedFallback}`);
  process.exit(1);
}

const jsonRuns = argvs.filter((argv) => argv.includes("--json"));
if (jsonRuns.length > 0) {
  console.error(`unexpected --json during ingest (${jsonRuns.length})\n${lines.join("\n")}`);
  process.exit(1);
}

const serve = argvs.filter((argv) => argv.includes("--serve"));
if (serve.length !== 1) {
  console.error(`expected one --serve start, got ${serve.length}\n${lines.join("\n")}`);
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT d.body AS body, e.vector_blob AS vector_blob
     FROM vector_document d JOIN vector_embedding e ON e.document_id = d.id
     ORDER BY d.body`,
  )
  .all() as { body: string; vector_blob: Buffer }[];
if (rows.length !== 2) {
  console.error(`expected two stored passages, got ${rows.length}`);
  process.exit(1);
}
for (const row of rows) {
  const fresh = spawnSync(real, [script, "--json", "-"], {
    input: JSON.stringify([row.body]),
    encoding: "utf8",
    timeout: 180_000,
  });
  if (fresh.status !== 0) {
    console.error(fresh.stderr);
    process.exit(1);
  }
  const parsed = JSON.parse(fresh.stdout.trim().split("\n").filter(Boolean).pop()!) as number[][];
  const expected = l2Normalize(Float32Array.from(parsed[0]!));
  const stored = blobToFloat32(row.vector_blob);
  if (stored.length !== expected.length) {
    console.error(`dims ${stored.length} != ${expected.length} for ${row.body}`);
    process.exit(1);
  }
  for (let i = 0; i < stored.length; i++) {
    if (stored[i] !== expected[i]) {
      console.error(`vector mismatch at ${i} for ${row.body}`);
      process.exit(1);
    }
  }
}
console.log("minilm session: one --serve, vectors match");
