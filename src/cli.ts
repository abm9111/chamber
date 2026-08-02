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

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openChamberDb } from "./db.ts";
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
  type VectorSourceKind,
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

/** Prefer env → /tmp (writable) → cwd. openChamberDb also falls back on I/O errors. */
function dbPath(): string {
  if (resolvedDbPath) return resolvedDbPath;
  if (process.env.CHAMBER_DB) {
    resolvedDbPath = process.env.CHAMBER_DB;
    return resolvedDbPath;
  }
  resolvedDbPath = "/tmp/chamber.sqlite";
  return resolvedDbPath;
}

function open(): DatabaseSync {
  try {
    return openChamberDb(dbPath());
  } catch {
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
    const mark =
      r.status === "ALLOWED"
        ? "✓"
        : r.status === "DEBT"
          ? "◇"
          : r.status === "APORIA"
            ? "○"
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

function cmdSearch(db: DatabaseSync, query: string, hybrid = false): void {
  const hits = searchVector(db, query, {
    k: 5,
    minScore: 0.01,
    ftsQuery: hybrid ? query : undefined,
  });
  if (hits.length === 0) {
    console.log("no hits");
    return;
  }
  console.log(`search: "${query}" (${hits.length} hits)`);
  for (const h of hits) {
    const preview = h.body.slice(0, 100).replace(/\n/g, " ");
    console.log(
      `  ${h.score.toFixed(4)}  [${h.sourceKind}]  ${h.title ?? h.documentId}`,
    );
    console.log(`           ${preview}${h.body.length > 100 ? "…" : ""}`);
    console.log(`           snap=${h.snapshotHash.slice(0, 12)}…`);
  }
}

function help(): void {
  console.log(`Chamber CLI — minimal vertical slice

Usage:
  chamber turn "<message>"     Run one gated turn (stub model)
  chamber status               Spend + queue + counts
  chamber queue                List pending writes
  chamber approve <writeId>    Human-approve + apply
  chamber reject  <writeId>    Human-reject
  chamber believe <type> <text>
      types: observation|inference|belief|commitment|unknown|defeater
  chamber index <kind> <title> <body> [ref]
      kinds: vault_page|x_tweet|transcript|note|skill|other
  chamber ingest <path> [--exclude <name-or-path>]… [--include-dotted]
                        [--allow-unmatched-exclude]
      Load a directory of .md/.markdown/.mdx files into the corpus (vault_page).
      --exclude prunes any path segment (or root-relative path) matching the
      pattern, case-insensitively, at any depth. A pattern that matches
      nothing aborts the run — quote multi-word names. Dotted entries
      (.trash, .obsidian) and symlinks leaving the root are skipped.
  chamber search <query>           Local vector search
  chamber search --hybrid <query>  Vector + FTS5 hybrid
  chamber ask "<question>" [--strict]        answer from the corpus with verified pins
      The model is shown passages numbered [1]..[k] and cites those numbers;
      index→document and document→hash mapping happen locally, so it can
      neither invent a document id nor supply a snapshot hash. Each claim is
      gated on its own citations. --strict refuses an unsourced assertion
      instead of committing it with citation debt.
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
  chamber search --hybrid "currency"
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    help();
    return;
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
      const parsed = parseIngestArgs(rest);
      if (!parsed.ok) {
        console.error(`ingest: ${parsed.error}`);
        console.error(INGEST_USAGE);
        process.exitCode = 1;
        break;
      }
      const r = ingestDirectory(db, parsed.path, {
        exclude: parsed.exclude,
        includeDotted: parsed.includeDotted,
        requireExcludeMatch: !parsed.allowUnmatchedExclude,
      });
      // An exclude that matched nothing aborts the run before anything is
      // stored: on a privacy control a no-op pattern is a typo far more often
      // than an intent, and a warning buried in output is not a control.
      if (r.aborted) {
        console.error(`ingest refused: ${r.abortReason}`);
        console.error(
          r.abortKind === "unmatched_exclude"
            ? "  nothing was ingested. Fix the pattern, or pass --allow-unmatched-exclude to proceed anyway."
            : "  nothing was ingested. Fix the pattern.",
        );
        process.exitCode = 1;
        break;
      }
      console.log(`ingested ${r.ingested} file(s) from ${parsed.path}`);
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
      break;
    }
    case "search": {
      let hybrid = false;
      let parts = rest;
      if (parts[0] === "--hybrid") {
        hybrid = true;
        parts = parts.slice(1);
      }
      const q = parts.join(" ").trim();
      if (!q) {
        console.error("usage: chamber search [--hybrid] <query>");
        process.exitCode = 1;
        return;
      }
      cmdSearch(db, q, hybrid);
      break;
    }
    case "ask": {
      const strict = rest.includes("--strict");
      // A mistyped `--stict` must not silently answer in lax mode: --strict is
      // the control that turns an unsourced assertion from minted debt into a
      // refusal, so swallowing an unrecognised flag disables a gate quietly.
      // Same rule `ingest` already applies to its own flags.
      const unknown = rest.filter((a) => a.startsWith("--") && a !== "--strict");
      if (unknown.length > 0) {
        console.error(`ask: unknown flag(s): ${unknown.join(", ")}`);
        console.error('usage: chamber ask "<question>" [--strict]');
        process.exitCode = 1;
        break;
      }
      const q = rest
        .filter((a) => !a.startsWith("--"))
        .join(" ")
        .trim();
      if (!q) {
        console.error('usage: chamber ask "<question>" [--strict]');
        process.exitCode = 1;
        break;
      }
      const r = await runAsk(db, q, { strict });
      if (!r.modelCalled) {
        console.log(r.note ?? "no passages retrieved");
        break;
      }
      console.log(`\n${r.answer}\n`);
      const refToPath = new Map(
        r.passages.map((p) => [p.documentId, p.sourceRef ?? p.documentId]),
      );
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
        for (const f of b.failures) {
          const where = f.sourceRef ? ` (${f.sourceRef})` : "";
          const hint =
            f.reason === "hash_mismatch"
              ? " — note changed since commit; re-run `chamber ingest`"
              : "";
          console.log(`  ${f.reason}: ${f.refId}${where}${hint}`);
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
      const hits = searchCode(db, q, { k: 5, hybrid: true });
      if (!hits.length) console.log("no hits");
      for (const h of hits) {
        console.log(
          `  ${h.score.toFixed(3)}  ${h.title}  ${h.sourceRef ?? ""}`,
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
        console.log(`  hit ${h.score.toFixed(3)}  ${h.title}`);
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
