/**
 * Chamber vs Hermes architecture scorecard.
 *
 * Chamber side: measurable via harness + live probes.
 * Hermes side: architecture scoring from source/docs (not a runtime bake-off of LLMs).
 *
 * Scoring: 0–2 per criterion
 *   0 = absent / theater
 *   1 = partial / config-optional / soft
 *   2 = hard gate, transactional, or default-on with teeth
 *
 * Run: node --experimental-strip-types benchmarks/scorecard.ts
 */

import { openChamberDb } from "../src/db.ts";
import { commitBelief } from "../src/commit_belief.ts";
import { tryActivateSkill } from "../src/try_activate_skill.ts";
import { completeSync } from "../src/model.ts";
import { enforceClaimContract } from "../src/contract.ts";
import { runExpiryJob } from "../src/expiry.ts";
import { openDeliberation } from "../src/faculty.ts";
import { proposeWrite, listPendingQueue } from "../src/approvals.ts";
import { recordSpend, spendLastHours } from "../src/spend.ts";
import { appendAudit, verifyAuditChain } from "../src/audit.ts";
import { getIncrementalRoot } from "../src/merkle_inc.ts";
import { newId, sha256 } from "../src/hash.ts";

interface Criterion {
  id: string;
  name: string;
  dimension: string;
  hermes: 0 | 1 | 2;
  hermesNote: string;
  chamber: 0 | 1 | 2;
  chamberNote: string;
}

const ARCH: Criterion[] = [
  {
    id: "E1",
    name: "Unsourced assertions blocked or debt-gated",
    dimension: "Epistemics",
    hermes: 0,
    hermesNote: "MEMORY.md writes are agent-managed notes; no citation debt object",
    chamber: 2,
    chamberNote: "commitBelief mints blocking citation_debt; contract can REFUSE strict",
  },
  {
    id: "E2",
    name: "Typed beliefs (observation ≠ belief ≠ commitment)",
    dimension: "Epistemics",
    hermes: 0,
    hermesNote: "Flat memory entries; no epistemic type system",
    chamber: 2,
    chamberNote: "EpistemicType enum + path rules (fast path forbids belief)",
  },
  {
    id: "E3",
    name: "Formal abstain / APORIA blocks execution",
    dimension: "Epistemics",
    hermes: 0,
    hermesNote: "Can say uncertain in prose; does not park skills/obligations",
    chamber: 1,
    chamberNote: "unknown type + contract APORIA; skill park via holds partial",
  },
  {
    id: "G1",
    name: "Skill writes default require human approval",
    dimension: "Governance",
    hermes: 1,
    hermesNote: "Tool/command approval exists; skill_manage often auto in learning loop",
    chamber: 2,
    chamberNote: "proposeWrite skill create → pending_write; approvals default ON",
  },
  {
    id: "G2",
    name: "Self-authored skills cannot self-approve",
    dimension: "Governance",
    hermes: 0,
    hermesNote: "Closed learning loop creates/improves skills from agent side",
    chamber: 2,
    chamberNote: "Synthesize → sandbox → queue; human approve required",
  },
  {
    id: "G3",
    name: "Multi-faculty blocking votes (not one prompt)",
    dimension: "Governance",
    hermes: 0,
    hermesNote: "Single agent loop; SOUL.md tone not parliament",
    chamber: 2,
    chamberNote: "5 faculty vote rows; any reject blocks; activate can require",
  },
  {
    id: "G4",
    name: "Constitutional changes need ratification friction",
    dimension: "Governance",
    hermes: 1,
    hermesNote: "SOUL.md described as immutable voice; not a vote/ratify queue",
    chamber: 1,
    chamberNote: "Schema for constitution path; full ratify UX not primary surface",
  },
  {
    id: "C1",
    name: "Spend visible per channel (chat/dream/cron/subagent)",
    dimension: "Cost",
    hermes: 1,
    hermesNote: "Billing/lifecycle docs exist; field reports still cite opacity",
    chamber: 2,
    chamberNote: "spend_event channels + footer every turn",
  },
  {
    id: "C2",
    name: "Background loops metered",
    dimension: "Cost",
    hermes: 0,
    hermesNote: "Cron/subagent/curator can burn without first-class channel ledger",
    chamber: 2,
    chamberNote: "dream/faculty/critic channels in spend meter",
  },
  {
    id: "M1",
    name: "Memory capacity ledger (no silent truncate theater)",
    dimension: "Memory",
    hermes: 1,
    hermesNote: "MEMORY.md hard char caps; truncate is structural not ledgered",
    chamber: 1,
    chamberNote: "Layered memory + status; not a token budget UI yet",
  },
  {
    id: "M2",
    name: "Active forgetting with dependency impact",
    dimension: "Memory",
    hermes: 1,
    hermesNote: "Curator archives skills; belief→skill edge suspend weak",
    chamber: 2,
    chamberNote: "expiry job + skill_dependencies load_bearing holds",
  },
  {
    id: "M3",
    name: "Dream/consolidation propose-only (no auto-apply)",
    dimension: "Memory",
    hermes: 0,
    hermesNote: "Learning loop writes skills/memory as product of autonomy",
    chamber: 2,
    chamberNote: "runDreamCycle → memory_proposal pending only",
  },
  {
    id: "A1",
    name: "Append-only audit hash chain",
    dimension: "Audit",
    hermes: 1,
    hermesNote: "Session DB + observability plugins; not universal hash chain",
    chamber: 2,
    chamberNote: "audit_event prev_hash/entry_hash + verifyAuditChain",
  },
  {
    id: "A2",
    name: "Incremental Merkle root (no full rebuild)",
    dimension: "Audit",
    hermes: 0,
    hermesNote: "Not a product feature",
    chamber: 2,
    chamberNote: "MMR peaks O(log n) append + checkpoint export",
  },
  {
    id: "A3",
    name: "Offline verify without trusting operator",
    dimension: "Audit",
    hermes: 1,
    hermesNote: "Depends on logging stack; not default cryptographic receipt",
    chamber: 2,
    chamberNote: "checkpoint JSON + chain verify",
  },
  {
    id: "T1",
    name: "Tool allowlist + sandbox verify before activate",
    dimension: "Tools",
    hermes: 1,
    hermesNote: "Container/approval for dangerous cmds; skill body less gated",
    chamber: 2,
    chamberNote: "allowlist builtins; synth sandbox; high-risk opt-in",
  },
  {
    id: "T2",
    name: "Compiler-accurate code graph consumer",
    dimension: "Tools",
    hermes: 0,
    hermesNote: "Not core; coding via tools not SCIP index",
    chamber: 1,
    chamberNote: "SCIP ingest consumer; does not generate indexes",
  },
  {
    id: "S1",
    name: "Production messaging surface breadth",
    dimension: "Surface",
    hermes: 2,
    hermesNote: "Telegram/Discord/Slack/WhatsApp/… gateway is core product",
    chamber: 1,
    chamberNote: "CLI + localhost HTTP + Caddy TLS deploy; no multi-messenger",
  },
  {
    id: "S2",
    name: "Self-improving skill loop out of the box",
    dimension: "Surface",
    hermes: 2,
    hermesNote: "Defining feature: create/improve skills from experience",
    chamber: 0,
    chamberNote: "Intentionally refuses auto skill growth without human gates",
  },
  {
    id: "S3",
    name: "TLS reverse-proxy / token hardening docs",
    dimension: "Surface",
    hermes: 1,
    hermesNote: "Docker/gateway security docs exist",
    chamber: 2,
    chamberNote: "Caddy/nginx/Traefik + API token + compose + systemd",
  },
];

function sum(side: "hermes" | "chamber"): number {
  return ARCH.reduce((a, c) => a + c[side], 0);
}

function liveChamberProbes(): { id: string; ok: boolean; detail: string }[] {
  const db = openChamberDb(":memory:");
  const out: { id: string; ok: boolean; detail: string }[] = [];

  // E1 debt
  const bel = commitBelief(db, {
    type: "belief",
    text: "Benchmark claim without sources",
    sources: [],
    authorFamily: "bench",
    path: "deep",
  });
  const debts = db
    .prepare(
      `SELECT COUNT(*) AS c FROM citation_debt WHERE belief_id = ? AND status = 'pending'`,
    )
    .get(bel.beliefId!) as { c: number };
  out.push({
    id: "live_E1",
    ok: bel.ok === true && debts.c >= 1,
    detail: `belief ok=${bel.ok} debts=${debts.c}`,
  });

  // E1 strict refuse
  const strict = enforceClaimContract(
    db,
    { kind: "assertion", text: "Always true claim without evidence at all." },
    { strict: true },
  );
  out.push({
    id: "live_E1_strict",
    ok: strict.status === "REFUSED",
    detail: strict.status,
  });

  // G1 skill queue
  const q = proposeWrite(db, {
    target: "skill",
    action: "create",
    subject: "bench_skill",
    payload: { body: "# skill", stakes: "routine" },
    origin: "foreground",
    authorFamily: "bench",
    reason: "benchmark",
  });
  out.push({
    id: "live_G1",
    ok: q.status === "queued",
    detail: q.status,
  });

  // C1 spend
  completeSync(db, {
    messages: [{ role: "user", content: "bench" }],
    channel: "chat",
  });
  const spend = spendLastHours(db, 24);
  out.push({
    id: "live_C1",
    ok: spend.totalInputTokens + spend.totalOutputTokens > 0,
    detail: `tokens=${spend.totalInputTokens + spend.totalOutputTokens}`,
  });

  // A1 chain
  appendAudit(db, { category: "system", action: "bench", actor: "bench" });
  const chain = verifyAuditChain(db);
  out.push({ id: "live_A1", ok: chain.ok, detail: `checked=${chain.checked}` });

  // A2 mmr
  const mmr = getIncrementalRoot(db);
  out.push({
    id: "live_A2",
    ok: (mmr.leafCount ?? 0) >= 1 && !!mmr.rootHash,
    detail: `leaves=${mmr.leafCount}`,
  });

  // G3 faculty reject
  const delib = openDeliberation(db, {
    subjectKind: "belief",
    subjectId: "x",
    question: "Commit with open debts?",
    stakes: "elevated",
    context: { openDebts: 1 },
  });
  out.push({
    id: "live_G3",
    ok: delib.status === "rejected",
    detail: delib.status,
  });

  // G3 activate blocked
  db.prepare(
    `INSERT INTO skill_snapshot (id, name, content_hash, cleared_hash, critic_clearance)
     VALUES (?, 'bench_sk', 'h', 'h', 'passed')`,
  ).run(newId("ss"));
  const act = tryActivateSkill(db, {
    skillId: "bench_sk",
    currentContentHash: "h",
    stakes: "consequential",
    riskTags: ["shell"],
  });
  out.push({
    id: "live_activate_faculty",
    ok: act.ok === false,
    detail: act.ok ? "activated" : act.reason,
  });

  // M2 expiry
  const past = new Date(Date.now() - 1000).toISOString();
  const bid = newId("blf");
  db.prepare(
    `INSERT INTO belief (id, content, epistemic_type, claim_hash, expires_at, committed_path, stakes, status)
     VALUES (?, 'x', 'observation', ?, ?, 'fast', 'routine', 'active')`,
  ).run(bid, sha256("x"), past);
  const exp = runExpiryJob(db);
  out.push({
    id: "live_M2",
    ok: exp.expired >= 1,
    detail: `expired=${exp.expired}`,
  });

  return out;
}

function main(): void {
  const h = sum("hermes");
  const c = sum("chamber");
  const max = ARCH.length * 2;

  console.log("══ Chamber vs Hermes — Architecture Scorecard ══\n");
  console.log(
    "Method: fixed criteria (0–2). Hermes from product architecture + field UX synthesis;",
  );
  console.log(
    "Chamber from implemented kernel + live probes. Not an LLM quality contest.\n",
  );

  let dim = "";
  for (const row of ARCH) {
    if (row.dimension !== dim) {
      dim = row.dimension;
      console.log(`\n── ${dim} ──`);
    }
    console.log(
      `${row.id}  H=${row.hermes} C=${row.chamber}  ${row.name}`,
    );
    console.log(`     Hermes:  ${row.hermesNote}`);
    console.log(`     Chamber: ${row.chamberNote}`);
  }

  console.log("\n══ Totals ══");
  console.log(`Hermes:  ${h}/${max}  (${((100 * h) / max).toFixed(1)}%)`);
  console.log(`Chamber: ${c}/${max}  (${((100 * c) / max).toFixed(1)}%)`);

  console.log("\n══ Live Chamber probes ══");
  const probes = liveChamberProbes();
  let pass = 0;
  for (const p of probes) {
    console.log(`  ${p.ok ? "PASS" : "FAIL"}  ${p.id}  ${p.detail}`);
    if (p.ok) pass++;
  }
  console.log(`\nProbes: ${pass}/${probes.length}`);

  console.log("\n══ Interpretation ══");
  console.log(
    "Hermes wins product surface (messengers, skill growth loop, ecosystem).",
  );
  console.log(
    "Chamber wins governable cognition (debt, faculty, audit MMR, approve-by-default).",
  );
  console.log(
    "They are not substitutes: Hermes optimizes agency compounding; Chamber optimizes epistemic control.",
  );
}

main();
