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
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("probe ok");
