#!/usr/bin/env node
/**
 * Chamber minimal CLI — vertical slice
 *
 *   node --experimental-strip-types src/cli.ts turn "remember I prefer short answers"
 *   node --experimental-strip-types src/cli.ts status
 *   node --experimental-strip-types src/cli.ts queue
 *   node --experimental-strip-types src/cli.ts approve <writeId>
 *   node --experimental-strip-types src/cli.ts reject  <writeId> [note]
 *   node --experimental-strip-types src/cli.ts believe <type> <text>
 *
 * Demonstrates: spend meter, belief commit gates, skill/memory propose → workflow → queue.
 * No live LLM — turn uses deterministic heuristics so gates are the product.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { openChamberDb } from "./db.ts";
import {
  loadConfig,
  explainConfig,
  configPath,
  type ChamberConfig,
  type ResolvedSetting,
} from "./config.ts";
import { sha256, newId } from "./hash.ts";
import { commitBelief } from "./commit_belief.ts";
import { recordSpend, spendLastHours, formatSpendFooter } from "./spend.ts";
import {
  proposeWrite,
  decideWrite,
  listPendingQueue,
  markApplied,
  expireStalePending,
} from "./approvals.ts";
import { evaluateWorkflows } from "./approval_workflows.ts";
import { appendAudit } from "./audit.ts";
import {
  upsertDocument,
  searchVector,
  countDocuments,
  parseSearchArgs,
  lexicalQueryNotices,
  type VectorSourceKind,
  type ParsedSearchArgs,
  type LexicalSearchError,
} from "./vector.ts";
import {
  ingestDirectory,
  parseIngestArgs,
  type IngestSkipKind,
} from "./ingest.ts";
import { completeSync } from "./model.ts";
import { enforceReplyContract } from "./contract.ts";
import { runAsk } from "./ask.ts";
import { verifyBeliefSources } from "./pins.ts";
import { runExpiryJob } from "./expiry.ts";
import { indexCodeTree, searchCode } from "./code_index.ts";
import {
  listOpenDebts,
  proposeDebtPayment,
  proposeAllDebtPayments,
  confirmDebtPaid,
} from "./debt.ts";
import { listTools, runTool, synthesizeTool } from "./tools.ts";
import { sandboxSelfTest, detectSandboxBackend } from "./sandbox.ts";
import {
  remember,
  listMemory,
  runMemoryDecay,
  runDreamCycle,
  listMemoryProposals,
  resolveMemoryProposal,
  type MemoryLayer,
} from "./memory.ts";
import {
  openDeliberation,
  getDeliberation,
  FACULTY_LABEL,
  workspaceGet,
  workspacePut,
  workspaceLock,
  workspaceUnlock,
} from "./faculty.ts";
import {
  ensureDefaultProfiles,
  listProfiles,
  getProfile,
  updateProfile,
  profileContext,
} from "./profiles.ts";
import {
  startSession,
  appendMessage,
  searchSessions,
  listSessions,
} from "./sessions.ts";
import { addCronJob, listCronJobs, runDueCronJobs, setCronEnabled } from "./cron.ts";
import {
  registerSkill,
  listSkills,
  proposeLearnedSkill,
  listLearningProposals,
  activateSkillRegistry,
} from "./skills_registry.ts";
import { importSkillFile, importSkillDirectory } from "./skill_import.ts";
import { loadAndRegisterMcpFile } from "./mcp_bridge.ts";
import { ensureDefaultScope, createScope, listScopes, globalPosture, effectivePolicy } from "./scope.ts";
import { enqueueJob, processJobQueue, listJobs } from "./job_queue.ts";
import { getHarness, listHarnesses } from "./harness_adapter.ts";
import { pilotSummary, logPilotEvent } from "./pilot.ts";
import { pendingWhy } from "./approvals.ts";
import {
  mcpDiscover,
  mcpToolsList,
  mcpImportRemoteTools,
  mcpGatedCall,
  MCP_PROTOCOL_VERSION,
} from "./mcp_client.ts";
import {
  discoverMcpOAuth,
  loginInteractive,
  getStoredToken,
  deleteStoredToken,
  generatePkce,
  buildAuthorizeUrl,
  normalizeResourceUrl,
} from "./mcp_oauth.ts";
import { statSync } from "node:fs";
import {
  ingestScipFile,
  findSymbol,
  queryCallers,
  queryCallees,
} from "./scip.ts";
import { exportCheckpoint } from "./checkpoint_export.ts";
import { formatErrorChain } from "./error_chain.ts";
import type { DatabaseSync } from "node:sqlite";
import type { EpistemicType, CommittedPath } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
let resolvedDbPath: string | null = null;
let loadedConfig: ChamberConfig | null = null;

const INGEST_USAGE =
  "usage: chamber ingest <path> [--exclude <name-or-path>]… " +
  "[--include-dotted] [--allow-unmatched-exclude]";

/**
 * Cap on individually-listed skips. The full list is always in the report;
 * a vault with thousands of attachments would otherwise bury the privacy
 * relevant lines (excluded, dotted, symlink-escaped) under image filenames.
 * The total count is printed unconditionally, so nothing goes unmentioned.
 */
const INGEST_SKIP_PRINT_LIMIT = 20;

/** Skip kinds that say something about the privacy boundary, printed first. */
const NOTABLE_SKIP_KINDS: ReadonlySet<IngestSkipKind> = new Set<IngestSkipKind>([
  "excluded",
  "dotted",
  "symlink_escape",
  "unreadable",
  "cycle",
]);

/**
 * Config-resolved path. Precedence: CHAMBER_DB > config file > default.
 *
 * By the time this runs, `main()` has already resolved `loadedConfig` (see
 * there for why that happens before `open()` rather than here) — so the
 * `loadConfig()` below normally just reuses that cached result, and this
 * function itself throwing is not the path a malformed config surfaces on.
 * An empty or whitespace-only CHAMBER_DB is treated as unset by config.ts's
 * envSetting(), so it falls through to the config file rather than
 * resolving to an empty path — an empty path is not a no-op, it is a
 * request node:sqlite honors as a private temp database that vanishes
 * silently when the process exits.
 */
function dbPath(): string {
  if (resolvedDbPath) return resolvedDbPath;
  loadedConfig ??= loadConfig();
  resolvedDbPath = loadedConfig.database;
  return resolvedDbPath;
}

/**
 * Open the resolved database.
 *
 * `openChamberDb` creates the parent directory, and on a location it cannot
 * use falls back to `/tmp/chamber.sqlite` then `:memory:` — announcing every
 * such redirect on stderr, naming both paths. This catch is the last one:
 * anything that reaches it (a corrupt database, a broken `sql/*.sql`) is a
 * failure `openChamberDb` deliberately refuses to relocate. Dropping into
 * `:memory:` here keeps a command from dying outright, but it must not do so
 * quietly — every write this run makes is discarded at exit, and `banner()`
 * would otherwise still print the durable path it never opened.
 *
 * `openChamberDb`'s own fallbacks needed the same treatment and were not
 * getting it. The `:memory:` leg below repoints `resolvedDbPath`, so `banner()`
 * follows the data; the `/tmp` leg inside `openChamberDb` updated nothing, so
 * stdout kept announcing the durable path while rows landed in
 * `/tmp/chamber.sqlite` and only stderr disagreed — which made
 * `chamber status 2>/dev/null` a confident lie. The `onRedirect` callback
 * closes that: wherever the data actually goes, that is what gets printed.
 */
function open(): DatabaseSync {
  const requested = dbPath();
  try {
    return openChamberDb(requested, (actual) => {
      resolvedDbPath = actual;
    });
  } catch (err) {
    process.stderr.write(
      `chamber: WARNING — could not open the database at ${requested}: ` +
        `${formatErrorChain(err).join("; ")}\n` +
        `chamber: WARNING — storing data at :memory: instead. ` +
        `Data written now will NOT be in ${requested}; it is discarded when ` +
        `this command exits.\n`,
    );
    resolvedDbPath = ":memory:";
    return openChamberDb(":memory:");
  }
}

function banner(): void {
  console.log("Chamber · governable cognition kernel");
  console.log(`db: ${dbPath()}\n`);
}

function printSpend(db: DatabaseSync): void {
  const report = spendLastHours(db, 24);
  console.log(`💸 ${formatSpendFooter(report)}`);
  if (report.alert) {
    console.log(`⚠️  ${report.alert.message}`);
  }
}

function printQueue(db: DatabaseSync): void {
  expireStalePending(db);
  const q = listPendingQueue(db, 20);
  if (q.length === 0) {
    console.log("📋 pending queue: (empty)");
    return;
  }
  console.log(`📋 pending queue (${q.length}):`);
  for (const item of q) {
    console.log(
      `  · ${item.id}  ${item.target}/${item.action}  [${item.origin}]  ${item.subject}`,
    );
    if (item.reason) console.log(`      reason: ${item.reason}`);
  }
}

/** Heuristic turn — no LLM. Detects memory vs skill intent for gate demo. */
function runTurn(db: DatabaseSync, message: string): void {
  const turnId = newId("trn");
  const sessionId =
    process.env.CHAMBER_SESSION ??
    startSession(db, { channel: "cli", title: message.slice(0, 48) });
  appendMessage(db, sessionId, "user", message, turnId);

  appendAudit(db, {
    category: "session",
    action: "turn_start",
    actor: "human",
    turnId,
    sessionId,
    detail: { message: message.slice(0, 200) },
  });

  // Expiry pass before the turn (cheap)
  const exp = runExpiryJob(db);
  if (exp.expired > 0) {
    console.log(`  ⏳ expiry job: ${exp.expired} belief(s) expired, ${exp.tickets} ticket(s)`);
  }

  console.log(`\n▶ turn ${turnId.slice(0, 12)}…`);
  console.log(`  user: ${message}`);

  const lower = message.toLowerCase();
  const wantsMemory =
    /\b(remember|prefer|i am|i'm|my name|always|never)\b/i.test(message);
  const wantsSkill =
    /\b(skill|procedure|how to|workflow|when i ask)\b/i.test(message);
  const wantsBelief =
    /\b(believe|note that)\b/i.test(message) ||
    /\b(fact|commit)\s*:/i.test(message);

  // 1) Observation of the utterance (fast path — transcript-sourced)
  const obs = commitBelief(db, {
    type: "observation",
    text: `user said: ${message.slice(0, 240)}`,
    sources: [
      {
        kind: "transcript",
        refId: turnId,
        snapshotHash: sha256(message),
        provenance: "transcript",
      },
    ],
    authorFamily: "stub",
    sessionId,
    path: "fast",
    turnId,
  });
  if (obs.ok) {
    console.log(`  ✓ observation committed (${obs.beliefId?.slice(0, 12)}…)`);
  } else {
    console.log(`  ✗ observation: ${obs.status} — ${obs.reason}`);
  }

  // 2) Optional belief-typed commit (deep path) when user marks a fact
  if (wantsBelief) {
    const claim = message.replace(/^.*\b(believe|fact:|commit:)\s*/i, "").trim() || message;
    const bel = commitBelief(db, {
      type: "belief",
      text: claim,
      sources: [], // unsourced → mints citation debt (demo)
      authorFamily: "stub",
      sessionId,
      path: "deep",
      turnId,
    });
    if (bel.ok) {
      console.log(`  ✓ belief committed (${bel.beliefId?.slice(0, 12)}…) — check debts if unsourced`);
    } else {
      console.log(`  ✗ belief: ${bel.status} — ${bel.reason}`);
    }
  }

  // 3) Memory preference → proposeWrite (approvals default ON + workflow)
  if (wantsMemory) {
    const q = proposeWrite(db, {
      target: "memory",
      action: "add",
      subject: "user_preference",
      payload: {
        stakes: "routine",
        text: message.slice(0, 300),
      },
      origin: "foreground",
      authorFamily: "stub",
      reason: "user stated preference in turn",
    });
    if (q.status === "queued") {
      const wf = evaluateWorkflows(db, q.writeId);
      console.log(
        `  → memory write queued ${q.writeId.slice(0, 14)}…  workflow=${wf.applied}`,
      );
      if (wf.applied === "auto_approve") {
        markApplied(db, q.writeId);
        console.log(`  ✓ auto-approved & marked applied`);
      }
    } else if (q.status === "applied_immediate") {
      console.log(`  → memory write applied immediately (${q.writeId.slice(0, 14)}…)`);
    } else {
      console.log(`  ✗ memory write: ${q.status} ${"reason" in q ? q.reason : ""}`);
    }

    recordSpend(db, {
      channel: "memory_fork",
      model: "stub-local",
      inputTokens: 40,
      outputTokens: 10,
      costUsd: 0.0001,
      turnId,
      sessionId,
    });
  }

  // 4) Skill intent → proposeWrite (background-style create stays human)
  if (wantsSkill) {
    const q = proposeWrite(db, {
      target: "skill",
      action: "create",
      subject: `skill_from_turn_${turnId.slice(0, 8)}`,
      payload: {
        body: `# Skill draft\n\nDerived from: ${message.slice(0, 200)}\n`,
        stakes: "routine",
      },
      origin: "foreground",
      authorFamily: "stub",
      reason: "user asked for a reusable procedure",
    });
    if (q.status === "queued") {
      const wf = evaluateWorkflows(db, q.writeId);
      console.log(
        `  → skill create queued ${q.writeId.slice(0, 14)}…  workflow=${wf.applied}`,
      );
    } else {
      console.log(`  ✗ skill write: ${JSON.stringify(q)}`);
    }
  }

  // Model completion — always meters spend inside completeSync
  const completion = completeSync(db, {
    messages: [
      {
        role: "system",
        content:
          "You are Chamber. Prefer observations over assertions. Mark uncertainty explicitly.",
      },
      { role: "user", content: message },
    ],
    channel: "chat",
    turnId,
    sessionId,
    userText: message,
  });

  console.log(`\n  assistant (${completion.model}): ${completion.text}\n`);

  // Evidence completion contract on the reply
  const contract = enforceReplyContract(db, completion.text, {
    sessionId,
    turnId,
    strict: process.env.CHAMBER_STRICT_CONTRACT === "1",
  });
  for (let i = 0; i < contract.results.length; i++) {
    const r = contract.results[i]!;
    const c = contract.claims[i]!;
    if (c.kind === "chatter") continue;
    // UNSUPPORTED is neither a pass nor a refusal: the claim is recorded and
    // nothing holds it up. It must not borrow ✓, which reads as endorsement.
    const mark =
      r.status === "ALLOWED"
        ? "✓"
        : r.status === "DEBT"
          ? "◇"
          : r.status === "APORIA"
            ? "○"
            : r.status === "UNSUPPORTED"
              ? "⚠"
              : "✗";
    console.log(
      `  ${mark} contract ${c.kind}/${r.status}${r.reason ? ` — ${r.reason}` : ""}`,
    );
  }

  appendMessage(db, sessionId, "assistant", completion.text, turnId);
  appendAudit(db, {
    category: "session",
    action: "turn_end",
    actor: "system",
    turnId,
    sessionId,
    detail: {
      model: completion.model,
      spendId: completion.spendId,
      contract: contract.results.map((r) => r.status),
    },
  });

  printSpend(db);
  console.log();
  printQueue(db);
}

function cmdBelieve(db: DatabaseSync, type: string, text: string): void {
  const allowed: EpistemicType[] = [
    "observation",
    "inference",
    "belief",
    "commitment",
    "unknown",
    "defeater",
  ];
  if (!allowed.includes(type as EpistemicType)) {
    console.error(`type must be one of: ${allowed.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const path: CommittedPath =
    type === "observation" || type === "inference" ? "fast" : "deep";
  const sources =
    type === "observation" || type === "inference"
      ? [
          {
            kind: "transcript" as const,
            refId: "cli",
            snapshotHash: sha256(text),
          },
        ]
      : [];

  const r = commitBelief(db, {
    type: type as EpistemicType,
    text,
    sources,
    authorFamily: "cli",
    path,
  });
  if (r.ok) {
    console.log(`committed ${type} ${r.beliefId}`);
  } else {
    console.log(`${r.status}: ${r.reason}`);
    process.exitCode = 1;
  }
  printSpend(db);
}

/** Resolve full pending_write id from exact or unique prefix. */
function resolveWriteId(db: DatabaseSync, prefix: string): string | null {
  const exact = db
    .prepare(`SELECT id FROM pending_write WHERE id = ?`)
    .get(prefix) as { id: string } | undefined;
  if (exact) return exact.id;
  const rows = db
    .prepare(`SELECT id FROM pending_write WHERE id LIKE ?`)
    .all(`${prefix}%`) as { id: string }[];
  if (rows.length === 1) return rows[0]!.id;
  return null;
}

function cmdApprove(db: DatabaseSync, writeId: string): void {
  const id = resolveWriteId(db, writeId);
  if (!id) {
    console.error(`write not found (or prefix ambiguous): ${writeId}`);
    process.exitCode = 1;
    return;
  }
  const d = decideWrite(db, id, "approved", "human", "cli approve");
  if (!d.ok) {
    console.error(d.reason);
    process.exitCode = 1;
    return;
  }
  markApplied(db, id);
  console.log(`approved + applied ${id}`);
  printQueue(db);
}

function cmdReject(db: DatabaseSync, writeId: string, note?: string): void {
  const id = resolveWriteId(db, writeId);
  if (!id) {
    console.error(`write not found (or prefix ambiguous): ${writeId}`);
    process.exitCode = 1;
    return;
  }
  const d = decideWrite(db, id, "rejected", "human", note ?? "cli reject");
  if (!d.ok) {
    console.error(d.reason);
    process.exitCode = 1;
    return;
  }
  console.log(`rejected ${id}`);
  printQueue(db);
}

function cmdStatus(db: DatabaseSync): void {
  banner();
  const beliefs = db.prepare(`SELECT COUNT(*) AS c FROM belief`).get() as { c: number };
  const debts = db
    .prepare(
      `SELECT COUNT(*) AS c FROM citation_debt WHERE status IN ('pending','proposed_paid')`,
    )
    .get() as { c: number };
  const holds = db
    .prepare(`SELECT COUNT(*) AS c FROM skill_holds WHERE released_at IS NULL`)
    .get() as { c: number };
  const audits = db.prepare(`SELECT COUNT(*) AS c FROM audit_event`).get() as {
    c: number;
  };
  const docs = countDocuments(db);
  console.log(`beliefs: ${beliefs.c}`);
  console.log(`open citation debts: ${debts.c}`);
  console.log(`open skill holds: ${holds.c}`);
  console.log(`audit events: ${audits.c}`);
  console.log(`vector documents: ${docs}`);
  console.log();
  printSpend(db);
  console.log();
  printQueue(db);
}

function cmdIndex(
  db: DatabaseSync,
  kind: string,
  title: string,
  body: string,
  ref?: string,
): void {
  const kinds: VectorSourceKind[] = [
    "vault_page",
    "x_tweet",
    "transcript",
    "note",
    "skill",
    "other",
  ];
  if (!kinds.includes(kind as VectorSourceKind)) {
    console.error(`kind must be one of: ${kinds.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const r = upsertDocument(db, {
    sourceKind: kind as VectorSourceKind,
    sourceRef: ref,
    title: title || undefined,
    body,
  });
  console.log(`indexed ${r.id}  model=${r.model} dims=${r.dims}`);
  console.log(`corpus size: ${countDocuments(db)}`);
}

function cmdSearch(db: DatabaseSync, args: ParsedSearchArgs): void {
  const { query, hybrid, exact } = args;
  if (hybrid) {
    for (const n of lexicalQueryNotices(query)) {
      console.error(`warning: ${n.message}`);
    }
  }
  let degraded: LexicalSearchError | undefined;
  const hits = searchVector(db, query, {
    k: 5,
    minScore: 0.01,
    lexical: hybrid
      ? {
          query,
          mode: exact ? "phrase" : "terms",
          require: exact,
        }
      : undefined,
    // A search that quietly stopped being hybrid is a search whose result the
    // operator would misread as "the corpus does not contain it".
    onLexicalError: (e) => {
      degraded = e;
    },
  });
  if (degraded) {
    console.error(
      `warning: keyword leg unavailable, ranking on vectors alone — ${degraded.message}`,
    );
  }
  if (hits.length === 0) {
    console.log("no hits");
    return;
  }
  const mode = exact ? "exact" : hybrid ? "hybrid" : "semantic";
  console.log(`search[${mode}]: "${query}" (${hits.length} hits)`);
  for (const h of hits) {
    const preview = h.body.slice(0, 100).replace(/\n/g, " ");
    const detail =
      h.fusedScore === undefined
        ? ""
        : `  (cos=${h.score.toFixed(3)} lex=${(h.lexicalScore ?? 0).toFixed(3)} via=${h.retrievedBy})`;
    console.log(
      `  ${(h.fusedScore ?? h.score).toFixed(4)}  [${h.sourceKind}]  ${h.title ?? h.documentId}${detail}`,
    );
    console.log(`           ${preview}${h.body.length > 100 ? "…" : ""}`);
    console.log(`           snap=${h.snapshotHash.slice(0, 12)}…`);
  }
}

/**
 * `chamber init` — write a starter config file.
 *
 * Deliberately does not depend on `loadConfig()`/`explainConfig()` succeeding
 * first, and never opens the database: `init` exists to create or repair the
 * file those two read, so a broken (or absent) config must never stand in
 * its own way, and a command whose only job is writing one JSON file has no
 * business creating `~/.local/share/chamber/chamber.sqlite` as a side effect
 * of being asked to write a config. (See the dispatch in `main()`, which
 * routes this — and `cmdConfig` — around the loadConfig()/open() prelude for
 * exactly that reason.)
 *
 * No field here can hold an API key: CHAMBER_API_KEY is env-only, read by
 * src/model.ts and nowhere else, and the starter only ever sets
 * `model.base` — which is the one field that could *send* that key
 * somewhere, and is therefore restricted to this machine when it comes from
 * a file (see `assertFileBaseIsLocal` in src/config.ts). The loopback
 * starter below is written for that reason as much as for local-first
 * defaults. `model.name` is left unset rather than `""` — config.ts
 * rejects a *present but blank* string the same way it rejects a blank
 * `database` (see parseModel/parseDatabase in src/config.ts), so writing
 * `name: ""` here would hand the user a config that fails validation the
 * moment anything else — including this file's own `config show` — reads it.
 */
function cmdInit(rest: string[]): void {
  const target = configPath();
  const force = rest.includes("--force");
  if (existsSync(target) && !force) {
    console.error(`config already exists: ${target}`);
    console.error("  pass --force to overwrite it");
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  const starter: ChamberConfig = {
    database: join(homedir(), ".local", "share", "chamber", "chamber.sqlite"),
    model: { base: "http://127.0.0.1:8087/v1" },
    ingest: [],
  };
  writeFileSync(target, `${JSON.stringify(starter, null, 2)}\n`);
  console.log(`wrote ${target}`);
  console.log("  set model.name, then add ingest roots with their excludes");
  console.log("  API keys are read from CHAMBER_API_KEY, never from this file");
  console.log(
    "  model.base here must stay on this machine; for a remote one, " +
      "export CHAMBER_API_BASE",
  );
  console.log("  run `chamber config show` to see what is in effect");
}

/**
 * `chamber config show` — print every resolved setting and where it came
 * from.
 *
 * `explainConfig()` now validates exactly as strictly as `loadConfig()` (see
 * `parseFile` in src/config.ts) and throws on a malformed file instead of
 * reporting a config as healthy that Chamber could not actually load. A
 * broken config is exactly the situation someone runs `config show` to
 * diagnose, so that throw is caught here and turned into a message naming
 * the file and the problem — never a bare stack trace escaping to the
 * terminal. `formatErrorChain` renders `name: message`, never `.stack`, so
 * this cannot leak one either. Like `cmdInit`, this never opens the database.
 */
function cmdConfig(rest: string[]): void {
  if (rest[0] !== "show") {
    console.error("usage: chamber config show");
    process.exitCode = 1;
    return;
  }
  let rows: ResolvedSetting[];
  try {
    rows = explainConfig();
  } catch (err) {
    console.error(
      `chamber: cannot show config — ${formatErrorChain(err).join("; ")}`,
    );
    console.error("  fix the file, or run `chamber init --force` to replace it");
    process.exitCode = 1;
    return;
  }
  for (const row of rows) {
    const conflict = row.conflict ? `  (config says ${row.conflict})` : "";
    console.log(`  ${row.key} = ${row.value}   [from ${row.source}]${conflict}`);
  }
}

function help(): void {
  console.log(`Chamber CLI — minimal vertical slice

Usage:
  init [--force]                     write a starter config file
  config show                        print every setting and where it came from
  chamber turn "<message>"     Run one gated turn (stub model)
  chamber status               Spend + queue + counts
  chamber queue                List pending writes
  chamber approve <writeId>    Human-approve + apply
  chamber reject  <writeId>    Human-reject
  chamber believe <type> <text>
      types: observation|inference|belief|commitment|unknown|defeater
  chamber index <kind> <title> <body> [ref]
      kinds: vault_page|x_tweet|transcript|note|skill|other
      Only vault_page is citable: every other kind is searchable but has no
      registered pin formula, so 'chamber ask' will not retrieve it and a
      claim can never be supported by it.
  chamber ingest <path> [--exclude <name-or-path>]… [--include-dotted]
                        [--allow-unmatched-exclude]
      Load a directory of .md/.markdown/.mdx files into the corpus (vault_page).
      --exclude prunes any path segment (or root-relative path) matching the
      pattern, case-insensitively, at any depth. A pattern that matches
      nothing aborts the run — quote multi-word names. Dotted entries
      (.trash, .obsidian) and symlinks leaving the root are skipped.
  chamber search [--exact|--semantic] <query>   Hybrid (vector + FTS5) search
      Hybrid is the default: results are the union of the two legs, ranked by
      0.7*cosine + 0.3*(share of the query's idf mass this passage contains).
      A passage found by both legs generally outranks one found by either.
      --exact  narrows to passages containing the query as a literal phrase.
      --semantic  turns the keyword leg off (vector similarity only).
  chamber ask "<question>" [--strict] [--exact|--semantic]
                                             answer from the corpus with verified pins
      The model is shown passages numbered [1]..[k] and cites those numbers;
      index→document and document→hash mapping happen locally, so it can
      neither invent a document id nor supply a snapshot hash. Each claim is
      gated on its own citations. --strict refuses an unsourced assertion
      instead of committing it with citation debt. Retrieval is hybrid by
      default; --exact / --semantic mean what they mean for 'search'.
  chamber verify [--since <ISO date>]        re-check stored pins against the corpus
      A pin is written when a belief commits; the corpus can move after that
      (an edited, re-ingested note). verify re-derives every stored pin from
      the corpus as it is now and reports what no longer matches — it never
      mutates a belief or the corpus. Exits non-zero exactly when a belief
      has no verified support left, so it is safe to run as a scheduled
      health check. --since limits the scan to beliefs committed on or after
      that date.
  chamber expiry                   Run belief expiry job

Env:
  CHAMBER_MODEL=stub|openai        default stub
  CHAMBER_API_KEY / CHAMBER_API_BASE / CHAMBER_API_MODEL
  CHAMBER_STRICT_CONTRACT=1        refuse unsourced assertions

Env:
  CHAMBER_DB       sqlite path
  CHAMBER_SESSION  session id (default: cli)

Examples:
  chamber turn "remember I prefer short answers"
  chamber index note "AED" "User base currency is AED (UAE dirham)."
  chamber search "currency UAE"
  chamber search --exact "revealed preference"
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    help();
    return;
  }

  // `init` and `config show` exist to create or diagnose the file the block
  // below loads, so neither may depend on that load succeeding first:
  // routed through it, a broken config would block `init --force` from ever
  // reaching the fix, and `config show`'s own legible, file-naming error
  // (see cmdConfig) would never fire — the generic top-level handler at the
  // bottom of this file would print instead. Both return here, and neither
  // opens the database (see cmdInit's and cmdConfig's doc comments).
  if (cmd === "init") {
    cmdInit(rest);
    return;
  }
  if (cmd === "config") {
    cmdConfig(rest);
    return;
  }

  // Resolved here, before open() — deliberately, not just "somewhere before
  // the switch". open() wraps its database open in a try/catch that falls
  // back to an in-memory database on any failure. Placed after open()
  // instead, a malformed config would still exit non-zero, but only by
  // accident: dbPath()'s loadConfig() call (made from inside open()'s try)
  // would throw first and be swallowed by that catch-all, silently opening
  // a throwaway :memory: db with a full schema applied and nothing that
  // will ever use it — then this same loadConfig() call would run again
  // (loadedConfig is still null; the failed assignment never completed) and
  // throw a second time, this time unguarded, which is what would actually
  // reach `main().catch` below. That "works" but only because open()'s catch
  // happens to be a blind catch-all and loadedConfig happens to stay unset
  // after a failed load — verified by moving this block after open() and
  // confirming the malformed-config test still passed, for exactly that
  // reason. Loading config here removes the dependency on that coincidence:
  // dbPath() then always finds loadedConfig already resolved, a bad config
  // throws exactly once, and open()'s catch is left doing only what it says
  // — falling back on a genuine disk I/O error opening the resolved path,
  // not laundering an unrelated config error into a silent :memory:.
  //
  // The model layer reads CHAMBER_API_BASE / CHAMBER_API_MODEL from the
  // environment directly. Seeding only where unset preserves precedence by
  // construction, since env already outranks config. This is a seam, not an
  // architecture: close it when complete() takes explicit options.
  loadedConfig ??= loadConfig();
  if (!process.env.CHAMBER_API_BASE && loadedConfig.model.base) {
    process.env.CHAMBER_API_BASE = loadedConfig.model.base;
  }
  if (!process.env.CHAMBER_API_MODEL && loadedConfig.model.name) {
    process.env.CHAMBER_API_MODEL = loadedConfig.model.name;
  }

  const db = open();

  switch (cmd) {
    case "turn": {
      const msg = rest.join(" ").trim();
      if (!msg) {
        console.error("usage: chamber turn \"<message>\"");
        process.exitCode = 1;
        return;
      }
      banner();
      runTurn(db, msg);
      break;
    }
    case "status":
      cmdStatus(db);
      break;
    case "queue":
      banner();
      printQueue(db);
      break;
    case "approve": {
      if (!rest[0]) {
        console.error("usage: chamber approve <writeId>");
        process.exitCode = 1;
        return;
      }
      cmdApprove(db, rest[0]);
      break;
    }
    case "reject": {
      if (!rest[0]) {
        console.error("usage: chamber reject <writeId> [note]");
        process.exitCode = 1;
        return;
      }
      cmdReject(db, rest[0], rest.slice(1).join(" ") || undefined);
      break;
    }
    case "believe": {
      const type = rest[0];
      const text = rest.slice(1).join(" ").trim();
      if (!type || !text) {
        console.error("usage: chamber believe <type> <text>");
        process.exitCode = 1;
        return;
      }
      cmdBelieve(db, type, text);
      break;
    }
    case "index": {
      const kind = rest[0];
      const title = rest[1];
      const body = rest[2];
      const ref = rest[3];
      if (!kind || !body) {
        console.error("usage: chamber index <kind> <title> <body> [ref]");
        process.exitCode = 1;
        return;
      }
      cmdIndex(db, kind, title ?? "", body, ref);
      break;
    }
    case "ingest": {
      // Shared by both the configured-roots loop and the explicit-path call
      // below, so a configured root is reported — skips included — exactly
      // as an explicit path would be. That parity matters beyond cosmetics:
      // Task 6 runs this unattended from launchd, and a scheduled log an
      // operator only skims after the fact must read the same as a manual
      // run they watched live.
      const runOne = (
        path: string,
        opts: { exclude: string[]; includeDotted: boolean; requireExcludeMatch: boolean },
      ): boolean => {
        const r = ingestDirectory(db, path, opts);
        // An exclude that matched nothing aborts the run before anything is
        // stored: on a privacy control a no-op pattern is a typo far more
        // often than an intent, and a warning buried in output is not a
        // control.
        if (r.aborted) {
          console.error(`ingest refused: ${r.abortReason}`);
          console.error(
            r.abortKind === "unmatched_exclude"
              ? "  nothing was ingested. Fix the pattern, or pass --allow-unmatched-exclude to proceed anyway."
              : "  nothing was ingested. Fix the pattern.",
          );
          return false;
        }
        console.log(
          `ingested ${r.ingested} file(s) as ${r.passages} passage(s) from ${path}`,
        );
        // A shrunken note's stale passages are deleted rather than left to keep
        // answering from content the note no longer holds. That is a corpus
        // deletion, so it is reported rather than done quietly.
        if (r.removed > 0) {
          console.log(
            `  removed ${r.removed} stale passage(s) from notes that shrank`,
          );
        }
        for (const e of r.excludes) {
          console.log(
            `  exclude ${e.raw} → pruned ${e.matched} entr${e.matched === 1 ? "y" : "ies"}`,
          );
        }
        if (r.unmatchedExcludes.length > 0) {
          console.error(
            `  ⚠ --exclude matched nothing: ${r.unmatchedExcludes.join(", ")} (allowed via --allow-unmatched-exclude)`,
          );
        }
        if (r.skipped.length > 0) {
          // Privacy-relevant skips first, then the rest, so a vault full of
          // attachments cannot push an escaping symlink off the bottom.
          const ranked = [
            ...r.skipped.filter((s) => NOTABLE_SKIP_KINDS.has(s.kind)),
            ...r.skipped.filter((s) => !NOTABLE_SKIP_KINDS.has(s.kind)),
          ];
          console.log(`  skipped ${ranked.length} entr${ranked.length === 1 ? "y" : "ies"}:`);
          for (const s of ranked.slice(0, INGEST_SKIP_PRINT_LIMIT)) {
            console.log(`    [${s.kind}] ${s.path}: ${s.reason}`);
          }
          const hidden = ranked.length - INGEST_SKIP_PRINT_LIMIT;
          if (hidden > 0) console.log(`    … and ${hidden} more`);
        }
        for (const c of r.collisions) {
          console.error(
            `  ⚠ cross-root collision on ${c.sourceRef}: already ingested from ${c.existingRoots.join(", ")} — stored as a separate document, not overwritten`,
          );
        }
        return true;
      };

      // Bare `chamber ingest` — and only bare — takes the configured roots.
      //
      // This used to ask "is any argument not `--`-prefixed?", which answered
      // no for `chamber ingest --exclude=public`: the configured-roots branch
      // ran, the exclude was dropped without a word, `public/` was ingested,
      // and the output read like a clean success at exit 0.
      // `--include-dotted`, `--allow-unmatched-exclude` and `--totally-bogus`
      // were all swallowed the same way — the last command path that did not
      // reject unknown flags, and the privacy-relevant one, repeating the
      // shape of the historical bug `parseIngestArgs` documents.
      //
      // Refusing rather than applying them, because there is no honest way to
      // apply them: excludes are per-root in the config file, and a single
      // CLI `--exclude` spread across N roots has no defined meaning —
      // `--allow-unmatched-exclude` would have to guess between "unmatched
      // against every root" and "against any", and both guesses silently
      // weaken a privacy control. Any argument at all therefore selects the
      // explicit-path form, whose parser already rejects an unknown flag and
      // a missing path out loud.
      if (rest.length === 0) {
        const cfg = loadConfig();
        if (cfg.ingest.length === 0) {
          console.error("ingest: no path given and no roots configured");
          console.error("  add roots to the config file, or pass a path");
          console.error("  run `chamber config show` to find the config file");
          process.exitCode = 1;
          break;
        }
        let allOk = true;
        for (const entry of cfg.ingest) {
          if (!existsSync(entry.root)) {
            console.error(`  skipped ${entry.root}: does not exist`);
            allOk = false;
            continue;
          }
          if (
            !runOne(entry.root, {
              exclude: entry.exclude,
              includeDotted: false,
              requireExcludeMatch: true,
            })
          ) {
            allOk = false;
          }
        }
        if (!allOk) process.exitCode = 1;
        break;
      }

      const parsed = parseIngestArgs(rest);
      if (!parsed.ok) {
        console.error(`ingest: ${parsed.error}`);
        console.error(INGEST_USAGE);
        process.exitCode = 1;
        break;
      }
      if (
        !runOne(parsed.path, {
          exclude: parsed.exclude,
          includeDotted: parsed.includeDotted,
          requireExcludeMatch: !parsed.allowUnmatchedExclude,
        })
      ) {
        process.exitCode = 1;
      }
      break;
    }
    case "search": {
      const parsed = parseSearchArgs(rest);
      if (!parsed.ok) {
        console.error(`search: ${parsed.error}`);
        console.error("usage: chamber search [--exact|--semantic] <query>");
        process.exitCode = 1;
        return;
      }
      cmdSearch(db, parsed);
      break;
    }
    case "ask": {
      const strict = rest.includes("--strict");
      // A mistyped `--stict` must not silently answer in lax mode: --strict is
      // the control that turns an unsourced assertion from minted debt into a
      // refusal, so swallowing an unrecognised flag disables a gate quietly.
      // Same rule `ingest` already applies to its own flags.
      const exact = rest.includes("--exact");
      const semantic = rest.includes("--semantic");
      const known = ["--strict", "--exact", "--semantic"];
      const unknown = rest.filter(
        (a) => a.startsWith("--") && !known.includes(a),
      );
      if (unknown.length > 0) {
        console.error(`ask: unknown flag(s): ${unknown.join(", ")}`);
        console.error(
          'usage: chamber ask "<question>" [--strict] [--exact|--semantic]',
        );
        process.exitCode = 1;
        break;
      }
      if (exact && semantic) {
        console.error(
          "ask: --semantic and --exact contradict: --exact is a lexical filter",
        );
        process.exitCode = 1;
        break;
      }
      const q = rest
        .filter((a) => !a.startsWith("--"))
        .join(" ")
        .trim();
      if (!q) {
        console.error(
          'usage: chamber ask "<question>" [--strict] [--exact|--semantic]',
        );
        process.exitCode = 1;
        break;
      }
      const r = await runAsk(db, q, { strict, exact, hybrid: !semantic });
      if (!r.modelCalled) {
        console.log(r.note ?? "no passages retrieved");
        break;
      }
      console.log(`\n${r.answer}\n`);
      // An answer can be produced over a filtered view of the corpus. Printing
      // the note only on the no-answer path above is what made that silent.
      if (r.note) console.log(`  note: ${r.note}\n`);
      // Not `sourceRef` alone: a note is stored as many passage rows, so that
      // renders as `manual.md#p7` — a real location, but not a legible one.
      // The label adds the heading breadcrumb, so a cited claim names the file
      // *and* the section it came from and the operator can go check it.
      const refToPath = new Map(r.passages.map((p) => [p.documentId, p.label]));
      for (const c of r.claims) {
        if (c.kind === "chatter") continue;
        const cites = c.citedRefs.map((id) => refToPath.get(id) ?? id).join(", ");
        console.log(`  [${c.status}] ${c.text.slice(0, 70)}`);
        if (cites) console.log(`     sources: ${cites}`);
        for (const rj of c.rejected) {
          console.log(`     rejected ${rj.refId}: ${rj.reason}`);
        }
        if (c.debtIds.length) {
          console.log(`     debt: ${c.debtIds.join(", ")}`);
        }
      }
      console.log(`\n${formatSpendFooter(spendLastHours(db, 24))}`);
      break;
    }
    case "verify": {
      // A typo'd flag must not be silently treated as "no filter": the same
      // rule `ingest` and `ask` already apply to their own flags. `--since`'s
      // value is a date and is never itself `--`-prefixed (guarded below), so
      // it is unambiguous to exclude only the literal `--since` token here —
      // anything else starting with `--` (e.g. a mistyped `--sinse`) is an
      // unrecognized flag and must be refused before it ever reaches
      // verifyBeliefSources, which cannot tell "no --since given" from "you
      // meant --since but misspelled it" — both look like an absent filter.
      const unknown = rest.filter((a) => a.startsWith("--") && a !== "--since");
      if (unknown.length > 0) {
        console.error(`verify: unknown flag(s): ${unknown.join(", ")}`);
        console.error("usage: chamber verify [--since <date>]");
        process.exitCode = 1;
        break;
      }
      const i = rest.indexOf("--since");
      let since: string | undefined;
      if (i >= 0) {
        const raw = rest[i + 1];
        // Same guard `ingest --exclude` applies: a missing or flag-shaped
        // value is a usage error, not silent "no filter".
        if (raw === undefined || raw.startsWith("-")) {
          console.error("usage: chamber verify [--since <date>]");
          console.error("  --since requires a date value");
          process.exitCode = 1;
          break;
        }
        // The query below is a raw TEXT compare against belief.created_at's
        // ISO-8601 form; SQLite never parses or validates a TEXT value, so an
        // unparseable --since does not throw there — it silently compares as
        // ordinary bytes. Depending on the first differing byte that can
        // silently exclude every belief (any value that sorts after "2026-…",
        // which is most non-numeric text) and print a false "0 with no
        // verified support left", or silently include everything. Both look
        // exactly like a correct, clean report on stdout — the one failure
        // mode a scheduled health check cannot absorb. Confirmed empirically
        // (task-7-report.md §"--since"): `--since not-a-real-date` reports a
        // clean "0 belief(s) checked" instead of the drift that is actually
        // there. Validate and normalize here so a malformed --since is a
        // loud, exit-1 usage error instead of a quiet false negative.
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) {
          console.error(`verify: --since is not a valid date: ${JSON.stringify(raw)}`);
          process.exitCode = 1;
          break;
        }
        since = parsed.toISOString();
      }
      const report = verifyBeliefSources(db, { since });
      let broken = 0;
      for (const b of report) {
        if (b.failures.length === 0) continue;
        broken += b.verified === 0 ? 1 : 0;
        console.log(`${b.beliefId}  ${b.verified}/${b.total} pins verified`);
        console.log(`  "${b.content.slice(0, 70)}"`);
        // What this message has to convey is whether the operator's evidence
        // *moved* or *vanished*, and the old one conveyed neither. It printed
        // only the position (`policy.md#p1`) and then prescribed `chamber
        // ingest` — but re-ingesting is what produced this state, so running it
        // again changes nothing, and the position is exactly the thing an edit
        // above the passage silently reassigns. Inserting a section at the top
        // of a note left the message naming `#p1` while the section actually
        // cited had shifted intact to `#p2`, so it pointed at content the
        // belief never cited and prescribed a no-op to fix it.
        for (const f of b.failures) {
          if (f.reason === "hash_mismatch") {
            // The ref is what the pin was committed against; the title is what
            // holds that position now. Printing both is what lets an operator
            // tell "my section was edited" from "my section moved and something
            // else took its slot" without opening the database.
            console.log(
              `  hash_mismatch: ${f.refId} — committed against ${f.sourceRef ?? "(no source ref)"}, which now holds: ${f.title ?? "(untitled)"}`,
            );
            console.log(
              "    the cited passage is not what is stored there any more — it may have been" +
                " edited, or shifted to another passage of the same note. Open the note and re-check;" +
                " re-ingesting will not restore the pin.",
            );
          } else if (f.reason === "not_found") {
            console.log(`  not_found: ${f.refId}`);
            console.log(
              "    nothing is stored under this id — the cited passage left the corpus" +
                " (the note shrank past this position, or its rows were replaced). The text may still" +
                " be in the note at a different passage; the citation can no longer reach it.",
            );
          } else {
            // `belief_not_found` and `kind_unregistered`: no corpus row was
            // matched, so there is nothing truthful to add beyond the reason.
            const where = f.sourceRef ? ` (${f.sourceRef})` : "";
            console.log(`  ${f.reason}: ${f.refId}${where}`);
          }
        }
      }
      console.log(
        `\n${report.length} belief(s) checked, ${broken} with no verified support left`,
      );
      if (broken > 0) process.exitCode = 1;
      break;
    }
    case "expiry": {
      const report = runExpiryJob(db);
      console.log(
        `expiry: scanned=${report.scanned} expired=${report.expired} tickets=${report.tickets}`,
      );
      break;
    }
    case "index-code": {
      const dir = rest[0] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
      console.log(`indexing code under ${dir}`);
      const r = indexCodeTree(db, dir);
      console.log(
        `files=${r.files} chunks=${r.chunks} merkle_roots=${r.roots.length}`,
      );
      for (const root of r.roots.slice(0, 5)) {
        console.log(`  ${root.path}  root=${root.rootHash.slice(0, 12)}…  n=${root.chunkCount}`);
      }
      break;
    }
    case "search-code": {
      const q = rest.join(" ").trim();
      if (!q) {
        console.error("usage: chamber search-code <query>");
        process.exitCode = 1;
        break;
      }
      for (const n of lexicalQueryNotices(q)) {
        console.error(`warning: ${n.message}`);
      }
      // Degrade-and-warn, like `search` and `ask`. A missing FTS index used to
      // abort this command with exit 1 while its two siblings answered on
      // vectors alone, so the same corpus was searchable by one command and
      // broken by another.
      let degraded: LexicalSearchError | undefined;
      const hits = searchCode(db, q, {
        k: 5,
        hybrid: true,
        onLexicalError: (e) => {
          degraded = e;
        },
      });
      if (degraded) {
        console.error(
          `warning: keyword leg unavailable, ranking on vectors alone — ${degraded.message}`,
        );
      }
      if (!hits.length) console.log("no hits");
      for (const h of hits) {
        // The fused score, because that is what the rows are ordered by.
        // Printing the raw cosine next to a fused ordering made the column
        // read out of order and looked like a sorting bug.
        const detail =
          h.fusedScore === undefined
            ? ""
            : `  (cos=${h.score.toFixed(3)} lex=${(h.lexicalScore ?? 0).toFixed(3)} via=${h.retrievedBy})`;
        console.log(
          `  ${(h.fusedScore ?? h.score).toFixed(3)}  ${h.title}  ${h.sourceRef ?? ""}${detail}`,
        );
      }
      break;
    }
    case "debts": {
      const debts = listOpenDebts(db);
      if (!debts.length) console.log("no open blocking debts");
      for (const d of debts) {
        console.log(
          `  ${d.id}  [${d.status}]  ${d.claimText.slice(0, 80)}`,
        );
      }
      break;
    }
    case "pay-debt": {
      const id = rest[0];
      if (!id) {
        const props = proposeAllDebtPayments(db);
        for (const p of props) {
          console.log(`  ${p.debtId} → ${p.status}: ${p.reason}`);
        }
        if (!props.length) console.log("no pending debts");
        break;
      }
      if (rest[1] === "confirm") {
        const ok = confirmDebtPaid(db, id, "human");
        console.log(ok ? `paid ${id}` : `could not pay ${id}`);
        break;
      }
      const p = proposeDebtPayment(db, id);
      console.log(`${p.status}: ${p.reason}`);
      for (const h of p.hits.slice(0, 3)) {
        console.log(`  hit ${h.score.toFixed(3)}  [${h.sourceKind}]  ${h.title}`);
      }
      for (const rj of p.rejected) {
        console.log(`  not pinned ${rj.refId}: ${rj.reason}`);
      }
      break;
    }
    case "tools": {
      console.log(`sandbox backend: ${detectSandboxBackend()}`);
      for (const t of listTools(db)) {
        const flags = [
          t.allowlisted ? "allow" : "deny",
          t.quarantined ? "quarantine" : "live",
          t.risk.join("+"),
        ].join(",");
        console.log(`  ${t.name.padEnd(16)} ${flags}  ${t.description}`);
      }
      break;
    }
    case "tool-run": {
      const name = rest[0];
      if (!name) {
        console.error("usage: chamber tool-run <name> [args...]");
        process.exitCode = 1;
        break;
      }
      const r = runTool(db, name, rest.slice(1));
      if (!r.allowed) {
        console.log(`blocked: ${r.reason}`);
        process.exitCode = 1;
        break;
      }
      console.log(
        `ok=${r.sandbox?.ok} backend=${r.sandbox?.backend} exit=${r.sandbox?.exitCode}`,
      );
      if (r.sandbox?.stdout) console.log(r.sandbox.stdout.trimEnd());
      if (r.sandbox?.stderr) console.error(r.sandbox.stderr.trimEnd());
      if (!r.sandbox?.ok) process.exitCode = 1;
      break;
    }
    case "tool-synth": {
      // chamber tool-synth <name> -- <source...>
      const name = rest[0];
      const sep = rest.indexOf("--");
      if (!name || sep < 0) {
        console.error(
          'usage: chamber tool-synth <name> -- <js source one-liner or file path>',
        );
        process.exitCode = 1;
        break;
      }
      const srcParts = rest.slice(sep + 1);
      let source = srcParts.join(" ");
      if (
        source.endsWith(".mjs") ||
        source.endsWith(".js") ||
        source.endsWith(".ts")
      ) {
        try {
          source = readFileSync(source, "utf8");
        } catch {
          /* treat as source text */
        }
      }
      const result = synthesizeTool(db, {
        name,
        description: `synthesized tool ${name}`,
        source,
        risk: ["compute"],
      });
      console.log(`${result.status}: ${result.reason}`);
      if (result.writeId) console.log(`writeId: ${result.writeId}`);
      console.log(
        `sandbox ok=${result.sandbox.ok} backend=${result.sandbox.backend} hash=${result.sandbox.sourceHash.slice(0, 12)}…`,
      );
      break;
    }
    case "sandbox-test": {
      const r = sandboxSelfTest();
      console.log(
        JSON.stringify(
          {
            ok: r.ok,
            backend: r.backend,
            exitCode: r.exitCode,
            stdout: r.stdout.trim(),
            ms: r.durationMs,
          },
          null,
          2,
        ),
      );
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case "remember": {
      // chamber remember <layer> <text...>
      const layer = rest[0] as MemoryLayer;
      const body = rest.slice(1).join(" ").trim();
      const layers = ["working", "episodic", "semantic", "skill_note"];
      if (!layers.includes(layer) || !body) {
        console.error(
          "usage: chamber remember <working|episodic|semantic|skill_note> <text>",
        );
        process.exitCode = 1;
        break;
      }
      const r = remember(db, {
        layer,
        body,
        sourceKind: "human",
        requireApproval: layer === "semantic" || layer === "skill_note",
      });
      console.log(`${r.status}${r.id ? ` id=${r.id}` : ""}${r.writeId ? ` writeId=${r.writeId}` : ""}`);
      break;
    }
    case "memory": {
      const layer = rest[0] as MemoryLayer | undefined;
      const items = listMemory(db, {
        layer: layer && ["working", "episodic", "semantic", "skill_note"].includes(layer)
          ? layer
          : undefined,
        limit: 30,
      });
      if (!items.length) console.log("(empty)");
      for (const m of items) {
        console.log(
          `  [${m.layer}] ${m.id.slice(0, 14)}…  sal=${m.salience.toFixed(2)}  ${(m.title ?? m.body).slice(0, 60)}`,
        );
      }
      break;
    }
    case "memory-decay": {
      const r = runMemoryDecay(db);
      console.log(
        `decay: scanned=${r.scanned} decayed=${r.decayed} forgotten=${r.forgotten}`,
      );
      break;
    }
    case "dream": {
      const r = runDreamCycle(db);
      console.log(`dream proposals: ${r.proposals.length} (none auto-applied)`);
      for (const p of r.proposals) {
        console.log(`  ${p.id.slice(0, 12)}…  ${p.kind}  ${p.rationale.slice(0, 70)}`);
      }
      break;
    }
    case "harvest": {
      if (rest[0] === "accept" || rest[0] === "reject") {
        const id = rest[1];
        if (!id) {
          console.error("usage: chamber harvest accept|reject <proposalId>");
          process.exitCode = 1;
          break;
        }
        const ok = resolveMemoryProposal(
          db,
          id,
          rest[0] === "accept" ? "accepted" : "rejected",
        );
        console.log(ok ? `${rest[0]} ${id}` : `failed ${id}`);
        break;
      }
      const props = listMemoryProposals(db);
      if (!props.length) console.log("no pending memory proposals");
      for (const p of props) {
        console.log(
          `  ${p.id}  ${p.kind}  mem=${p.memoryId?.slice(0, 12) ?? "—"}  ${p.rationale.slice(0, 60)}`,
        );
      }
      break;
    }
    case "deliberate": {
      // chamber deliberate <kind> <id> <question...>
      // optional: --stakes=consequential --debts=1 --nosources
      const kind = rest[0] as "skill" | "belief" | "memory" | "tool" | "other";
      const subjectId = rest[1];
      let parts = rest.slice(2);
      let stakes: "routine" | "elevated" | "consequential" = "routine";
      let openDebts = 0;
      let hasSources: boolean | undefined;
      const riskTags: string[] = [];
      parts = parts.filter((p) => {
        if (p.startsWith("--stakes=")) {
          stakes = p.slice(9) as typeof stakes;
          return false;
        }
        if (p.startsWith("--debts=")) {
          openDebts = Number(p.slice(8)) || 0;
          return false;
        }
        if (p === "--nosources") {
          hasSources = false;
          return false;
        }
        if (p.startsWith("--risk=")) {
          riskTags.push(p.slice(7));
          return false;
        }
        return true;
      });
      const question = parts.join(" ").trim();
      if (!kind || !subjectId || !question) {
        console.error(
          "usage: chamber deliberate <skill|belief|memory|tool|other> <id> [--stakes=] [--debts=N] [--nosources] [--risk=tag] <question>",
        );
        process.exitCode = 1;
        break;
      }
      const r = openDeliberation(db, {
        subjectKind: kind,
        subjectId,
        question,
        stakes,
        context: {
          openDebts,
          hasSources,
          riskTags,
          isSkillMutation: kind === "skill",
        },
      });
      console.log(`${r.status}: ${r.outcome}`);
      console.log(`deliberation: ${r.id}`);
      for (const v of r.votes) {
        console.log(
          `  ${FACULTY_LABEL[v.faculty].padEnd(28)} ${v.vote.padEnd(8)} ${v.rationale}`,
        );
      }
      if (r.status === "rejected" || r.status === "parked") process.exitCode = 1;
      break;
    }
    case "delib": {
      const id = rest[0];
      if (!id) {
        console.error("usage: chamber delib <deliberationId>");
        process.exitCode = 1;
        break;
      }
      const r = getDeliberation(db, id);
      if (!r) {
        console.log("not found");
        process.exitCode = 1;
        break;
      }
      console.log(`${r.status}: ${r.outcome}`);
      for (const v of r.votes) {
        console.log(`  ${v.faculty} ${v.vote} — ${v.rationale}`);
      }
      break;
    }
    case "workspace": {
      const op = rest[0];
      const key = rest[1];
      if (!op || !key) {
        console.error("usage: chamber workspace get|put|lock|unlock <key> [json|by]");
        process.exitCode = 1;
        break;
      }
      if (op === "get") {
        const v = workspaceGet(db, key);
        console.log(v ? JSON.stringify(v, null, 2) : "null");
      } else if (op === "put") {
        const by = process.env.CHAMBER_ACTOR ?? "human";
        let value: unknown = rest.slice(2).join(" ") || "{}";
        try {
          value = JSON.parse(String(value));
        } catch {
          value = { text: value };
        }
        const r = workspacePut(db, key, value, by);
        console.log(r.ok ? `ok v${r.version}` : `fail: ${r.reason}`);
        if (!r.ok) process.exitCode = 1;
      } else if (op === "lock") {
        const by = rest[2] ?? process.env.CHAMBER_ACTOR ?? "human";
        console.log(workspaceLock(db, key, by) ? `locked by ${by}` : "lock failed");
      } else if (op === "unlock") {
        const by = rest[2] ?? process.env.CHAMBER_ACTOR ?? "human";
        console.log(workspaceUnlock(db, key, by) ? "unlocked" : "unlock failed");
      } else {
        console.error("unknown op");
        process.exitCode = 1;
      }
      break;
    }
    case "scip-ingest": {
      const path = rest[0];
      if (!path) {
        console.error("usage: chamber scip-ingest <graph.json>");
        process.exitCode = 1;
        break;
      }
      try {
        const r = ingestScipFile(db, path);
        console.log(
          `scip: docs=${r.documents} symbols=${r.symbols} occ=${r.occurrences} rels=${r.relationships}`,
        );
      } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
      }
      break;
    }
    case "scip-find": {
      const q = rest.join(" ").trim();
      if (!q) {
        console.error("usage: chamber scip-find <query>");
        process.exitCode = 1;
        break;
      }
      const hits = findSymbol(db, q);
      if (!hits.length) console.log("no symbols");
      for (const h of hits) {
        console.log(`  ${h.displayName ?? h.symbol}  (${h.kind ?? "?"})`);
        console.log(`    ${h.symbol}`);
      }
      break;
    }
    case "scip-calls": {
      const sym = rest.join(" ").trim();
      if (!sym) {
        console.error("usage: chamber scip-calls <symbol>");
        process.exitCode = 1;
        break;
      }
      console.log("callees:");
      for (const e of queryCallees(db, sym)) {
        console.log(`  → [${e.kind}] ${e.to}`);
      }
      console.log("callers:");
      for (const e of queryCallers(db, sym)) {
        console.log(`  ← [${e.kind}] ${e.from}`);
      }
      break;
    }
    case "checkpoint": {
      const out = rest[0] ?? "/tmp/chamber-checkpoint.json";
      const r = exportCheckpoint(db, out);
      console.log(`wrote ${out}`);
      console.log(
        `mmrRoot=${r.mmrRoot?.slice(0, 16) ?? "null"}… leaves=${r.leafCount} audit.ok=${r.audit.ok}`,
      );
      break;
    }

    case "pilot": {
      console.log(pilotSummary(db));
      break;
    }
    case "scopes": {
      ensureDefaultScope(db);
      console.log(`posture: ${globalPosture()}`);
      for (const s of listScopes(db)) {
        console.log(`  ${s.id.padEnd(16)} ${s.kind.padEnd(6)} policy=${s.policy}  ${s.title ?? ""}`);
      }
      break;
    }
    case "scope-add": {
      const kind = (rest[0] ?? "user") as "user" | "room" | "org";
      const title = rest.slice(1).join(" ") || kind;
      const id = createScope(db, { kind, title });
      console.log(`created ${id} policy=${effectivePolicy(db, id)}`);
      break;
    }
    case "jobs": {
      if (rest[0] === "enqueue") {
        const kind = (rest[1] ?? "expiry") as "expiry" | "cron" | "dream";
        const id = enqueueJob(db, kind);
        console.log(`enqueued ${id} kind=${kind}`);
      } else if (rest[0] === "run") {
        const r = processJobQueue(db, { limit: Number(rest[1] ?? 10) });
        console.log(`processed=${r.processed} done=${r.done} failed=${r.failed}`);
      } else {
        for (const j of listJobs(db)) {
          console.log(`  ${j.id.slice(0, 12)}…  ${j.kind.padEnd(12)} ${j.status.padEnd(8)} attempts=${j.attempts}`);
        }
      }
      break;
    }
    case "harness": {
      console.log(`active: ${getHarness().id}`);
      console.log(`available: ${listHarnesses().join(", ")}`);
      break;
    }
    case "profiles": {
      ensureDefaultProfiles(db);
      for (const pr of listProfiles(db)) {
        console.log(`  ${pr.id.padEnd(8)} v${pr.version}  ${pr.chars}/${pr.maxChars ?? "∞"} chars`);
      }
      break;
    }
    case "profile": {
      const id = rest[0];
      if (!id) {
        console.error("usage: chamber profile <soul|user|memory> [set <text>]");
        process.exitCode = 1;
        break;
      }
      if (rest[1] === "set") {
        const body = rest.slice(2).join(" ");
        const r = updateProfile(db, id, body);
        console.log(r.status, r.writeId ?? "");
      } else {
        const pr = getProfile(db, id);
        console.log(pr ? pr.body : "missing");
      }
      break;
    }
    case "sessions": {
      for (const s of listSessions(db)) {
        console.log(`  ${s.id.slice(0, 12)}…  ${s.channel}  ${s.title ?? ""}  ${s.startedAt}`);
      }
      break;
    }
    case "session-search": {
      const q = rest.join(" ").trim();
      if (!q) {
        console.error("usage: chamber session-search <query>");
        process.exitCode = 1;
        break;
      }
      for (const h of searchSessions(db, q)) {
        console.log(`  ${h.role}  ${h.snippet}`);
      }
      break;
    }
    case "cron": {
      if (rest[0] === "add") {
        // chamber cron add name schedule prompt...
        const name = rest[1];
        const schedule = rest[2];
        const prompt = rest.slice(3).join(" ");
        if (!name || !schedule || !prompt) {
          console.error("usage: chamber cron add <name> <interval:1h> <prompt>");
          process.exitCode = 1;
          break;
        }
        const id = addCronJob(db, { name, schedule, prompt });
        console.log(`added ${id}`);
      } else if (rest[0] === "run") {
        const r = runDueCronJobs(db, (p) => `cron-handled: ${p.slice(0, 80)}`);
        console.log(`ran ${r.ran}`);
        for (const x of r.results) console.log(`  ${x.id} ${x.status}`);
      } else {
        for (const j of listCronJobs(db)) {
          console.log(`  ${j.name}  ${j.schedule}  enabled=${j.enabled}  next=${j.nextRunAt ?? "—"}`);
        }
      }
      break;
    }
    case "skill-import": {
      const path = rest[0];
      if (!path) {
        console.error("usage: chamber skill-import <file-or-dir>");
        process.exitCode = 1;
        break;
      }
      if (statSync(path).isDirectory()) {
        const r = importSkillDirectory(db, path);
        console.log(`imported ${r.imported}`);
        for (const x of r.results) console.log(`  ${x.name} ${x.status}`);
      } else {
        const r = importSkillFile(db, path);
        console.log(`${r.name} ${r.status} ${r.id ?? ""}`);
      }
      break;
    }
    case "mcp-auth": {
      const sub = rest[0];
      const url = rest[1];
      if (sub === "discover") {
        if (!url) {
          console.error("usage: chamber mcp-auth discover <resource-url>");
          process.exitCode = 1;
          break;
        }
        try {
          const { prm, as } = discoverMcpOAuth(db, url);
          console.log(`resource: ${prm.resource}`);
          console.log(`AS:       ${as.issuer}`);
          console.log(`authorize ${as.authorization_endpoint}`);
          console.log(`token     ${as.token_endpoint}`);
          console.log(`scopes    ${(prm.scopes_supported ?? []).join(" ") || "(none listed)"}`);
        } catch (e) {
          console.error(String(e));
          process.exitCode = 1;
        }
      } else if (sub === "login") {
        if (!url) {
          console.error("usage: chamber mcp-auth login <resource-url>");
          process.exitCode = 1;
          break;
        }
        loginInteractive(db, url)
          .then((tok) => {
            console.log(`ok resource=${tok.resourceUrl} expires=${tok.expiresAt ?? "—"}`);
          })
          .catch((e) => {
            console.error(String(e));
            process.exitCode = 1;
          });
        return;
      } else if (sub === "status") {
        if (!url) {
          console.error("usage: chamber mcp-auth status <resource-url>");
          process.exitCode = 1;
          break;
        }
        const t = getStoredToken(db, url);
        if (!t) console.log("no token");
        else console.log(`token present expires=${t.expiresAt ?? "—"} issuer=${t.issuer}`);
      } else if (sub === "logout") {
        if (!url) {
          console.error("usage: chamber mcp-auth logout <resource-url>");
          process.exitCode = 1;
          break;
        }
        console.log(deleteStoredToken(db, url) ? "logged out" : "no token");
      } else {
        console.error("usage: chamber mcp-auth discover|login|status|logout <resource-url>");
        process.exitCode = 1;
      }
      break;
    }
    case "mcp-discover": {
      const url = rest[0];
      if (!url) {
        console.error("usage: chamber mcp-discover <endpoint-url>");
        process.exitCode = 1;
        break;
      }
      try {
        const d = mcpDiscover(url);
        console.log(`protocol=${MCP_PROTOCOL_VERSION} remote=${d.protocolVersions.join(",")}`);
        console.log(JSON.stringify(d.serverInfo ?? {}, null, 2));
      } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
      }
      break;
    }
    case "mcp-list": {
      const url = rest[0];
      if (!url) {
        console.error("usage: chamber mcp-list <endpoint-url>");
        process.exitCode = 1;
        break;
      }
      try {
        for (const tool of mcpToolsList(url)) {
          console.log(`  ${tool.name}  ${tool.description ?? ""}`.slice(0, 100));
        }
      } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
      }
      break;
    }
    case "mcp-import-remote": {
      const url = rest[0];
      if (!url) {
        console.error("usage: chamber mcp-import-remote <endpoint-url>");
        process.exitCode = 1;
        break;
      }
      try {
        const r = mcpImportRemoteTools(db, url);
        console.log(`server=${r.server} registered=${r.registered} (all pending)`);
        for (const n of r.tools) console.log(`  ${n}`);
      } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
      }
      break;
    }
    case "mcp-call": {
      // chamber mcp-call <endpoint> <tool> [json-args]
      const url = rest[0];
      const tool = rest[1];
      if (!url || !tool) {
        console.error("usage: chamber mcp-call <endpoint> <tool> [json-args]");
        process.exitCode = 1;
        break;
      }
      let args = {};
      if (rest[2]) {
        try { args = JSON.parse(rest.slice(2).join(" ")); } catch { args = {}; }
      }
      const r = mcpGatedCall(db, url, tool, args as Record<string, unknown>);
      if (!r.ok) {
        console.error(r.reason);
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify(r.result, null, 2));
      }
      break;
    }
    case "mcp-import": {
      const path = rest[0];
      if (!path) {
        console.error("usage: chamber mcp-import <manifest.json>");
        process.exitCode = 1;
        break;
      }
      const r = loadAndRegisterMcpFile(db, path);
      console.log(`server=${r.server} registered=${r.registered} blocked=${r.blocked}`);
      break;
    }
    case "skills": {
      if (rest[0] === "add") {
        const name = rest[1];
        const body = rest.slice(2).join(" ") || `# ${name}\n`;
        const r = registerSkill(db, { name, body, source: "human", activate: true });
        console.log(r.status, r.id, r.writeId ?? "");
      } else if (rest[0] === "learn") {
        const name = rest[1];
        const body = rest.slice(2).join(" ") || `# ${name}\n`;
        const r = proposeLearnedSkill(db, { name, body, evidence: "cli learn" });
        console.log("proposal", r.proposalId, r.writeId ?? "");
      } else {
        for (const s of listSkills(db)) {
          console.log(`  ${s.name.padEnd(16)} ${s.status.padEnd(10)} ${s.source}`);
        }
        const props = listLearningProposals(db);
        if (props.length) {
          console.log("learning proposals:");
          for (const p of props) console.log(`  ${p.id}  ${p.title}`);
        }
      }
      break;
    }
    default:

      console.error(`unknown command: ${cmd}`);
      help();
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(formatErrorChain(err).join("\n"));
  // exitCode (not exit()) so buffered stdout still flushes.
  process.exitCode = 1;
});
