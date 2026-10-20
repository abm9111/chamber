/**
 * PROBE: the README's install, plus a notes folder, judges a file that was
 * never ingested, and does not create a database to do it.
 *
 * Exits non-zero while an empty database still returns NOT_FOUND, or while
 * the call creates the database file.
 *
 *   node --experimental-strip-types probes/check_declared_notes.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openChamberDb } from "../src/db.ts";
import { checkClaims } from "../src/check.ts";
import { ingestDirectory } from "../src/ingest.ts";
import { MINILM_MODEL } from "../src/embedder.ts";
import { blobToFloat32 } from "../src/vector.ts";

const root = mkdtempSync(join(tmpdir(), "chamber-probe-notes-"));
const db = join(root, "missing.sqlite");
const note = join(root, "gpu.md");
let failed = false;
function fail(msg: string): void {
  failed = true;
  console.error(msg);
}
try {
  mkdirSync(root, { recursive: true });
  writeFileSync(note, "# GPU\n\nOne NVIDIA A100 80GB can serve about 1,000 users.\n");
  const server = fileURLToPath(new URL("../src/mcp_server.ts", import.meta.url));
  const frames = (source: string): string => [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "chamber_check",
        arguments: {
          claims: [{
            text: "One NVIDIA A100 80GB can serve about 2,000 users.",
            sources: [source],
          }],
        },
      },
    }),
  ].join("\n") + "\n";
  const input = frames(note);
  const check = (label: string, source: string): void => {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", server, "--notes", root], {
      input: frames(source),
      encoding: "utf8",
      env: { ...process.env, CHAMBER_DB: db, CHAMBER_CONFIG: join(root, "no-config.json") },
      timeout: 30_000,
    });
    const line = (run.stdout || "").split("\n").find((l) => l.includes('"id":2')) ?? "";
    if (!line.includes("TERMS_ABSENT") || !line.includes("2000")) fail(`${label}: verdict missing:\n${run.stdout}\n${run.stderr}`);
    if (/not in the index|no such passage|isError/.test(line)) fail(`${label}: reply is an index error:\n${line}`);
    if (existsSync(db)) fail(`${label}: database was created at ${db}`);
  };
  check("absolute path", note);
  // An absolute path is still absolute when it names a passage: judged from
  // disk (the note has one passage), no index, no file.
  check("absolute passage ref", `${note}#p0`);
  const bad = spawnSync(process.execPath, ["--experimental-strip-types", server, "--not-a-flag"], {
    input,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (bad.status !== 1) fail(`bad flag exited ${bad.status}`);
  if ((bad.stdout || "").trim().startsWith("{")) fail(`bad flag wrote JSON: ${bad.stdout}`);

  // A relative file.md#pN is the same file as the absolute path. An exclude
  // that matched nothing must refuse it before the freshness read opens it.
  const relRoot = join(root, "rel");
  mkdirSync(relRoot);
  const relNote = join(relRoot, "n.md");
  writeFileSync(relNote, "The audit store is SQLite.\n");
  const relDb = openChamberDb(join(root, "rel.sqlite"));
  const savedEmbedder = process.env.CHAMBER_EMBEDDER;
  process.env.CHAMBER_EMBEDDER = "hash";
  try {
    ingestDirectory(relDb, relRoot);
    const folders = [{ root: relRoot, exclude: ["no-such"] }];
    const poison = '--exclude matched nothing: "no-such" — nothing in this folder was checked';
    const cited = checkClaims(relDb, [{ text: "The audit store is SQLite.", sources: ["n.md#p0"] }], { folders })[0];
    if (!cited || cited.status !== "NOT_FOUND" || !cited.problems.some((p) => p === poison)) {
      fail(`relative #p0 was not refused: ${JSON.stringify(cited)}`);
    }
    rmSync(relNote);
    const fifo = spawnSync("mkfifo", [relNote]);
    if (fifo.status !== 0) fail(`mkfifo failed: ${fifo.stderr}`);
    const started = Date.now();
    const piped = checkClaims(relDb, [{ text: "The audit store is SQLite.", sources: ["n.md#p0"] }], { folders })[0];
    if (Date.now() - started >= 5000) fail("relative #p0 hung on the fifo");
    if (!piped || piped.status !== "NOT_FOUND" || !piped.problems.some((p) => p === poison)) {
      fail(`relative #p0 opened the fifo: ${JSON.stringify(piped)}`);
    } else if (piped.problems.some((p) => p.includes("regular file"))) {
      fail(`the file was opened: ${JSON.stringify(piped.problems)}`);
    }
  } finally {
    if (savedEmbedder === undefined) delete process.env.CHAMBER_EMBEDDER;
    else process.env.CHAMBER_EMBEDDER = savedEmbedder;
    relDb.close();
  }

  // An exclude used only at ingest is not stored. The root remembered on the
  // rows must not become a permit to read the file that exclude skipped.
  const vault = join(root, "vault");
  mkdirSync(join(vault, "Private"), { recursive: true });
  writeFileSync(join(vault, "open.md"), "The public figure is 10.\n");
  writeFileSync(join(vault, "Private", "secret.md"), "The secret figure is 12.\n");
  const vaultDb = openChamberDb(join(root, "vault.sqlite"));
  process.env.CHAMBER_EMBEDDER = "hash";
  try {
    ingestDirectory(vaultDb, vault, { exclude: ["Private"] });
    const hidden = join(vault, "Private", "secret.md");
    const leaked = checkClaims(vaultDb, [{ text: "The secret figure is 12.", sources: [hidden] }])[0];
    if (!leaked || leaked.status !== "NOT_FOUND") {
      fail(`an ingest exclude was read from disk: ${JSON.stringify(leaked)}`);
    }
    const probed = checkClaims(vaultDb, [{ text: "The secret figure is 99.", sources: [hidden] }])[0];
    if (!probed || probed.status !== "NOT_FOUND" || probed.missing?.includes("99")) {
      fail(`an excluded file answered a false claim: ${JSON.stringify(probed)}`);
    }

    // Once the file is indexed, every spelling hits the same exclude.
    const wide = join(root, "wide");
    mkdirSync(join(wide, "Private"), { recursive: true });
    const secret = join(wide, "Private", "secret.md");
    writeFileSync(secret, "The codename is Zephyr.\n");
    const wideDb = openChamberDb(join(root, "wide.sqlite"));
    ingestDirectory(wideDb, wide);
    const id = (wideDb.prepare(`SELECT id FROM vector_document WHERE source_ref LIKE '%secret.md%'`).get() as { id: string }).id;
    const folders = [{ root: wide, exclude: ["Private"] }];
    const spellings = [secret, `${secret}#p0`, "Private/secret.md", "Private/secret.md#p0", id];
    for (const source of spellings) {
      const verdict = checkClaims(wideDb, [{ text: "The codename is Zephyr.", sources: [source] }], { folders })[0];
      if (!verdict || verdict.status !== "NOT_FOUND" || !verdict.problems.some((p) => p.includes("excluded by --exclude"))) {
        fail(`${source} skipped the exclude: ${JSON.stringify(verdict)}`);
      }
    }
    wideDb.close();

    // A frontmatter title is part of the indexed text. Changing it is behind.
    const titled = join(root, "titled");
    mkdirSync(titled);
    const page = join(titled, "plan.md");
    writeFileSync(page, "---\ntitle: Zephyr\n---\n\nThe budget is fine.\n");
    const titleDb = openChamberDb(join(root, "title.sqlite"));
    ingestDirectory(titleDb, titled);
    writeFileSync(page, "---\ntitle: Quux\n---\n\nThe budget is fine.\n");
    const renamed = checkClaims(
      titleDb,
      [{ text: "Zephyr budget is fine.", sources: [page] }],
      { record: true, folders: [{ root: titled, exclude: [] }] },
    )[0];
    if (!renamed || !renamed.problems.some((p) => p.includes("index is behind"))) {
      fail(`a renamed title was judged as current: ${JSON.stringify(renamed)}`);
    }
    const beliefs = (titleDb.prepare(`SELECT count(*) AS n FROM belief`).get() as { n: number }).n;
    if (beliefs !== 0) fail(`a renamed title was recorded: ${beliefs}`);
    titleDb.close();

    // A vector labelled MiniLM that is not 384 finite floats is not kept.
    const badDir = join(root, "badvec");
    mkdirSync(badDir);
    writeFileSync(join(badDir, "n.md"), "# N\n\nalpha\n\n## Two\n\nbeta\n\n## Three\n\ngamma\n");
    const badDb = openChamberDb(join(root, "bad.sqlite"));
    const mini = (texts: readonly string[]) =>
      texts.map((_, i) => ({
        vector: new Float32Array(384).fill(i + 1),
        model: MINILM_MODEL,
        dims: 384,
        kind: "hash" as const,
      }));
    ingestDirectory(badDb, badDir, { embedBatch: mini });
    const mid = badDb.prepare(`SELECT id FROM vector_document WHERE source_ref LIKE '%#p1'`).get() as { id: string };
    const junk = new Float32Array([Number.NaN, 1, 2]);
    badDb.prepare(
      `UPDATE vector_embedding SET model = ?, dims = ?, vector_blob = ? WHERE document_id = ?`,
    ).run(MINILM_MODEL, junk.length, Buffer.from(junk.buffer), mid.id);
    const axis = (n: number) => {
      const v = new Float32Array(384);
      v[n] = 1;
      return { vector: v, model: MINILM_MODEL, dims: 384, kind: "hash" as const };
    };
    let batchCalls = 0;
    ingestDirectory(badDb, badDir, {
      embedBatch: (texts) => {
        batchCalls += 1;
        return texts.map(() => axis(1));
      },
    });
    if (batchCalls !== 1) fail(`a short vector labelled MiniLM was kept: calls=${batchCalls}`);
    const repaired = blobToFloat32(
      (badDb.prepare(`SELECT vector_blob FROM vector_embedding WHERE document_id = ?`).get(mid.id) as { vector_blob: Buffer }).vector_blob,
    );
    if (repaired.length !== 384 || !Number.isFinite(repaired[0]!)) fail("the short vector was not rewritten");

    // Passage 0 and 2 change; 1 stays. The vectors must not be swapped.
    writeFileSync(join(badDir, "n.md"), "# N\n\nalpha changed\n\n## Two\n\nbeta\n\n## Three\n\ngamma changed\n");
    ingestDirectory(badDb, badDir, {
      embedBatch: (texts) => texts.map(() => axis(0)),
    });
    const stored = badDb.prepare(
      `SELECT d.source_ref AS ref, e.vector_blob AS blob
       FROM vector_document d JOIN vector_embedding e ON e.document_id = d.id
       ORDER BY d.source_ref`,
    ).all() as { ref: string; blob: Buffer }[];
    const at = (i: number) => blobToFloat32(stored[i]!.blob)[0]!;
    if (at(0) < 0.9 || at(2) < 0.9 || at(1) > 0.2) {
      fail(`vectors were zipped onto the wrong passages: ${at(0)}, ${at(1)}, ${at(2)}`);
    }
    badDb.close();
  } finally {
    if (savedEmbedder === undefined) delete process.env.CHAMBER_EMBEDDER;
    else process.env.CHAMBER_EMBEDDER = savedEmbedder;
    vaultDb.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("probe ok");
