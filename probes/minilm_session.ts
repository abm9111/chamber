/**
 * PROBE: one ingest of two changed files starts embed_minilm.py --serve once,
 * and each stored vector equals a fresh --json - vector for that body.
 *
 * Exits non-zero when each file starts its own interpreter, when serve mode
 * disagrees with the one-shot path, when the ingest reports `embedFallback`
 * (a hash vector stood in for MiniLM), or when the ingest ran `--json` at all
 * (the per-passage path ran instead of the session). The availability probe
 * is a separate start and is not counted.
 *
 *   node --experimental-strip-types probes/minilm_session.ts
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openChamberDb } from "../src/db.ts";
import { resetMinilmProbe } from "../src/embedder.ts";
import { ingestDirectory } from "../src/ingest.ts";
import { blobToFloat32, l2Normalize } from "../src/vector.ts";

const root = mkdtempSync(join(tmpdir(), "chamber-probe-minilm-session-"));
const real = process.env.CHAMBER_PYTHON?.trim() || "python3";
const script = fileURLToPath(new URL("../scripts/embed_minilm.py", import.meta.url));

function run(): string | null {
  const log = join(root, "argv.log");
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
  try {
    const report = ingestDirectory(db, root, {});

    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const argvs = lines.map((ln) => JSON.parse(ln) as string[]);

    if (report.embedFallback) return `embedFallback: ${report.embedFallback}`;

    const jsonRuns = argvs.filter((argv) => argv.includes("--json"));
    if (jsonRuns.length > 0) {
      return `unexpected --json during ingest (${jsonRuns.length})\n${lines.join("\n")}`;
    }

    const serve = argvs.filter((argv) => argv.includes("--serve"));
    if (serve.length !== 1) {
      return `expected one --serve start, got ${serve.length}\n${lines.join("\n")}`;
    }

    const rows = db
      .prepare(
        `SELECT d.body AS body, e.vector_blob AS vector_blob
         FROM vector_document d JOIN vector_embedding e ON e.document_id = d.id
         ORDER BY d.body`,
      )
      .all() as { body: string; vector_blob: Buffer }[];
    if (rows.length !== 2) return `expected two stored passages, got ${rows.length}`;
    for (const row of rows) {
      const fresh = spawnSync(real, [script, "--json", "-"], {
        input: JSON.stringify([row.body]),
        encoding: "utf8",
        timeout: 180_000,
      });
      if (fresh.status !== 0) return fresh.stderr;
      const parsed = JSON.parse(fresh.stdout.trim().split("\n").filter(Boolean).pop()!) as number[][];
      const expected = l2Normalize(Float32Array.from(parsed[0]!));
      const stored = blobToFloat32(row.vector_blob);
      if (stored.length !== expected.length) {
        return `dims ${stored.length} != ${expected.length} for ${row.body}`;
      }
      for (let i = 0; i < stored.length; i++) {
        if (stored[i] !== expected[i]) return `vector mismatch at ${i} for ${row.body}`;
      }
    }
    return null;
  } finally {
    db.close();
  }
}

let failure: string | null;
try {
  failure = run();
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failure !== null) {
  console.error(failure);
  process.exit(1);
}
console.log("minilm session: one --serve, vectors match");
