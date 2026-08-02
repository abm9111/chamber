/**
 * Minimal HTTP surface for Chamber.
 *
 *   CHAMBER_DB=/tmp/chamber.sqlite node --experimental-strip-types src/server.ts
 *   PORT=8787
 *
 * Routes:
 *   GET  /health
 *   GET  /status
 *   GET  /queue
 *   POST /turn          { "message": "..." }
 *   POST /approve       { "writeId": "..." }
 *   POST /reject        { "writeId": "...", "note": "..." }
 *   POST /deliberate    { "kind", "subjectId", "question", "stakes?" }
 *   GET  /checkpoint
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { openChamberDb } from "./db.ts";
import { sha256, newId } from "./hash.ts";
import { commitBelief } from "./commit_belief.ts";
import { completeSync } from "./model.ts";
import { enforceReplyContract } from "./contract.ts";
import { runExpiryJob } from "./expiry.ts";
import { recordSpend, spendLastHours, formatSpendFooter, assertSpendBudget } from "./spend.ts";
import {
  proposeWrite,
  decideWrite,
  listPendingQueue,
  markApplied,
  expireStalePending,
} from "./approvals.ts";
import { evaluateWorkflows } from "./approval_workflows.ts";
import { appendAudit } from "./audit.ts";
import { openDeliberation, FACULTY_LABEL } from "./faculty.ts";
import { buildCheckpointReceipt } from "./checkpoint_export.ts";
import { listOpenDebts } from "./debt.ts";
import { listMemory } from "./memory.ts";
import { startSession, appendMessage } from "./sessions.ts";
import { profileContext } from "./profiles.ts";
import { registerSlackPendingHook } from "./slack_ops.ts";
import { quarantineUntrustedText, stripInvisibleNoise, checkRateLimit, surfaceRateKey } from "./surface_harden.ts";

try { registerSlackPendingHook(); } catch { /* slack optional */ }
const PORT = Number(process.env.PORT ?? process.env.CHAMBER_PORT ?? 8787);
/** When set, all routes except GET /health require this bearer/token. */
const API_TOKEN = process.env.CHAMBER_API_TOKEN?.trim() || "";
/** Bind host: default loopback; compose may use 0.0.0.0 on internal network only. */
const BIND = process.env.CHAMBER_BIND ?? "127.0.0.1";
const db = openChamberDb(process.env.CHAMBER_DB ?? "/tmp/chamber.sqlite");

function extractToken(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const h = req.headers["x-chamber-token"];
  if (typeof h === "string") return h.trim();
  if (Array.isArray(h) && h[0]) return h[0].trim();
  return "";
}

/** Constant-time-ish compare to avoid trivial timing leaks on short tokens. */
function tokenOk(provided: string): boolean {
  if (!API_TOKEN) return true; // auth disabled
  if (!provided || provided.length !== API_TOKEN.length) {
    // still walk both sides
    let acc = 0;
    const a = provided || " ";
    const b = API_TOKEN;
    for (let i = 0; i < b.length; i++) {
      acc |= (a.charCodeAt(i % a.length) || 0) ^ b.charCodeAt(i);
    }
    return false;
  }
  let acc = 0;
  for (let i = 0; i < API_TOKEN.length; i++) {
    acc |= provided.charCodeAt(i) ^ API_TOKEN.charCodeAt(i);
  }
  return acc === 0;
}

function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): boolean {
  // Health stays open for load balancers even when token is set
  if (path === "/health" && (req.method === "GET" || req.method === "HEAD")) {
    return true;
  }
  if (!API_TOKEN) return true;
  if (tokenOk(extractToken(req))) return true;
  json(res, 401, {
    error: "unauthorized",
    hint: "Authorization: Bearer <CHAMBER_API_TOKEN> or X-Chamber-Token header",
  });
  return false;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function runTurn(message: string): Record<string, unknown> {
  const budget = assertSpendBudget(db);
  if (!budget.ok) {
    return {
      ok: false,
      error: budget.reason,
      spend: formatSpendFooter(budget.report),
    };
  }
  const rate = checkRateLimit(surfaceRateKey("http", "http", "turn"));
  if (!rate.ok) {
    return {
      ok: false,
      error: `Rate limited. Retry in ~${Math.ceil((rate.retryAfterMs ?? 60000) / 1000)}s.`,
    };
  }
  const cleaned = stripInvisibleNoise(message);
  const turnId = newId("trn");
  const sessionId = startSession(db, { channel: "http", title: cleaned.slice(0, 48) });
  appendMessage(db, sessionId, "user", cleaned, turnId);
  runExpiryJob(db);

  appendAudit(db, {
    category: "session",
    action: "turn_start",
    actor: "human",
    turnId,
    sessionId,
    detail: { message: cleaned.slice(0, 200) },
  });

  const obs = commitBelief(db, {
    type: "observation",
    text: `user said: ${cleaned.slice(0, 240)}`,
    sources: [
      {
        kind: "transcript",
        refId: turnId,
        snapshotHash: sha256(cleaned),
        provenance: "transcript",
      },
    ],
    authorFamily: "http",
    sessionId,
    path: "fast",
    turnId,
  });

  const wantsBelief =
    /\b(believe|note that)\b/i.test(cleaned) || /\b(fact|commit)\s*:/i.test(cleaned);
  let belief: unknown = null;
  if (wantsBelief) {
    const claim =
      cleaned.replace(/^.*\b(believe|fact:|commit:)\s*/i, "").trim() || cleaned;
    belief = commitBelief(db, {
      type: "belief",
      text: claim,
      sources: [],
      authorFamily: "http",
      sessionId,
      path: "deep",
      turnId,
    });
  }

  if (/\b(remember|prefer)\b/i.test(message)) {
    const q = proposeWrite(db, {
      target: "memory",
      action: "add",
      subject: "user_preference",
      payload: { stakes: "routine", text: message.slice(0, 300) },
      origin: "foreground",
      authorFamily: "http",
      reason: "http turn preference",
    });
    if (q.status === "queued") evaluateWorkflows(db, q.writeId);
  }

  const completion = completeSync(db, {
    messages: [
      {
        role: "system",
        content:
          "You are Chamber. Prefer observations over assertions. Mark uncertainty explicitly.",
      },
      { role: "user", content: quarantineUntrustedText(cleaned, "http") },
    ],
    channel: "chat",
    turnId,
    sessionId,
    userText: message,
  });

  const contract = enforceReplyContract(db, completion.text, {
    sessionId,
    turnId,
    strict: process.env.CHAMBER_STRICT_CONTRACT === "1",
  });

  appendAudit(db, {
    category: "session",
    action: "turn_end",
    actor: "system",
    turnId,
    sessionId,
  });

  const spend = spendLastHours(db, 24);
  expireStalePending(db);

  appendMessage(db, sessionId, "assistant", completion.text, turnId);

  return {
    turnId,
    sessionId,
    observation: obs,
    belief,
    assistant: completion.text,
    model: completion.model,
    contract: contract.results.map((r, i) => ({
      claim: contract.claims[i]?.kind,
      status: r.status,
      reason: r.reason,
    })),
    spend: formatSpendFooter(spend),
    queue: listPendingQueue(db, 10),
    debts: listOpenDebts(db, 10),
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Chamber-Token",
      });
      res.end();
      return;
    }

    if (!requireAuth(req, res, path)) return;

    if (method === "GET" && path === "/health") {
      json(res, 200, {
        ok: true,
        service: "chamber",
        auth: API_TOKEN ? "required" : "open",
      });
      return;
    }

    if (method === "GET" && path === "/status") {
      const beliefs = (
        db.prepare(`SELECT COUNT(*) AS c FROM belief WHERE status = 'active'`).get() as {
          c: number;
        }
      ).c;
      const debts = listOpenDebts(db, 5);
      const mem = listMemory(db, { limit: 5 });
      json(res, 200, {
        beliefs,
        openDebts: debts.length,
        memory: mem.length,
        spend: formatSpendFooter(spendLastHours(db, 24)),
        queue: listPendingQueue(db, 10),
      });
      return;
    }

    if (method === "GET" && path === "/queue") {
      expireStalePending(db);
      json(res, 200, { queue: listPendingQueue(db, 50) });
      return;
    }

    if (method === "GET" && path === "/checkpoint") {
      json(res, 200, buildCheckpointReceipt(db));
      return;
    }

    if (method === "POST" && path === "/turn") {
      const body = await readJson(req);
      const message = String(body.message ?? body.text ?? "").trim();
      if (!message) {
        json(res, 400, { error: "message required" });
        return;
      }
      json(res, 200, runTurn(message));
      return;
    }

    if (method === "POST" && path === "/approve") {
      const body = await readJson(req);
      const writeId = String(body.writeId ?? "");
      if (!writeId) {
        json(res, 400, { error: "writeId required" });
        return;
      }
      const actor = String(body.actor ?? "human");
      const r = decideWrite(db, {
        writeId,
        decision: "approved",
        decidedBy: actor,
      });
      let applied = null;
      if (r.ok && (r.status === "approved" || r.idempotent)) {
        applied = markApplied(db, writeId);
      }
      const status = r.ok ? 200 : r.code === "not_found" ? 404
        : r.code === "conflict_opposite" || r.code === "concurrent_conflict" || r.code === "already_applied" || r.code === "already_rejected" || r.code === "already_approved" ? 409
        : r.code === "expired" ? 410
        : 400;
      json(res, status, { ...r, applied });
      return;
    }

    if (method === "POST" && path === "/reject") {
      const body = await readJson(req);
      const writeId = String(body.writeId ?? "");
      const actor = String(body.actor ?? "human");
      const r = decideWrite(db, {
        writeId,
        decision: "rejected",
        decidedBy: actor,
        note: body.note ? String(body.note) : undefined,
      });
      const status = r.ok ? 200 : r.code === "not_found" ? 404
        : r.code === "conflict_opposite" || r.code === "concurrent_conflict" || r.code === "already_applied" || r.code === "already_approved" ? 409
        : r.code === "expired" ? 410
        : 400;
      json(res, status, r);
      return;
    }

    if (method === "POST" && path === "/deliberate") {
      const body = await readJson(req);
      const kind = String(body.kind ?? "other") as
        | "skill"
        | "belief"
        | "memory"
        | "tool"
        | "other";
      const subjectId = String(body.subjectId ?? "unknown");
      const question = String(body.question ?? "").trim();
      if (!question) {
        json(res, 400, { error: "question required" });
        return;
      }
      const r = openDeliberation(db, {
        subjectKind: kind,
        subjectId,
        question,
        stakes: (body.stakes as "routine" | "elevated" | "consequential") ?? "routine",
        context: {
          openDebts: Number(body.openDebts ?? 0) || 0,
          hasSources: body.hasSources === false ? false : undefined,
          riskTags: Array.isArray(body.riskTags)
            ? (body.riskTags as string[])
            : undefined,
          isSkillMutation: kind === "skill",
        },
      });
      json(res, 200, {
        ...r,
        votes: r.votes.map((v) => ({
          ...v,
          label: FACULTY_LABEL[v.faculty],
        })),
      });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

function listenServer(): void {
  const listenFds = Number(process.env.LISTEN_FDS ?? 0);
  const listenPid = Number(process.env.LISTEN_PID ?? 0);
  // systemd socket activation: FDs start at 3 (SD_LISTEN_FDS_START)
  if (listenFds > 0 && listenPid === process.pid) {
    server.listen({ fd: 3 }, () => {
      console.log(`Chamber HTTP  (socket activation fd=3, LISTEN_FDS=${listenFds})`);
      console.log(`db=${process.env.CHAMBER_DB ?? "/tmp/chamber.sqlite"}`);
      console.log(
        `auth=${API_TOKEN ? "token-required" : "open (set CHAMBER_API_TOKEN)"}`,
      );
    });
    return;
  }
  server.listen(PORT, BIND, () => {
    console.log(`Chamber HTTP  http://${BIND}:${PORT}`);
    console.log(`db=${process.env.CHAMBER_DB ?? "/tmp/chamber.sqlite"}`);
    console.log(
      `auth=${API_TOKEN ? "token-required" : "open (set CHAMBER_API_TOKEN)"}`,
    );
  });
}

listenServer();