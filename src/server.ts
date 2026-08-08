/**
 * Minimal HTTP surface for Chamber.
 *
 *   node --experimental-strip-types src/server.ts
 *   PORT=8787
 *
 * The database is whichever one Chamber's settings name — CHAMBER_DB, then the
 * config file, then the durable default — so this process and the CLI share
 * one corpus. See src/config.ts and `openConfiguredDb` in src/db.ts.
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
import type { DatabaseSync } from "node:sqlite";
import { openChamberDb } from "./db.ts";
import { configPath, loadConfig } from "./config.ts";
import { formatErrorChain } from "./error_chain.ts";
import { sha256, newId } from "./hash.ts";
import { commitBelief } from "./commit_belief.ts";
import { completeSync } from "./model.ts";
import { enforceReplyContract } from "./contract.ts";
import { runExpiryJob } from "./expiry.ts";
import { spendLastHours, formatSpendFooter, assertSpendBudget } from "./spend.ts";
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
import { registerSlackPendingHook } from "./slack_ops.ts";
import { quarantineUntrustedText, stripInvisibleNoise, checkRateLimit, surfaceRateKey } from "./surface_harden.ts";

try { registerSlackPendingHook(); } catch { /* slack optional */ }
const PORT = Number(process.env.PORT ?? process.env.CHAMBER_PORT ?? 8787);
/** When set, all routes except GET /health require this bearer/token. */
const API_TOKEN = process.env.CHAMBER_API_TOKEN?.trim() || "";
/** Bind host: default loopback; compose may use 0.0.0.0 on internal network only. */
const BIND = process.env.CHAMBER_BIND ?? "127.0.0.1";

/**
 * Origins allowed to read a response, as an explicit allowlist. Empty by
 * default, which sends no CORS header at all.
 *
 * This used to be a flat `Access-Control-Allow-Origin: *` on every response,
 * including the ones above the auth check. Proven with curl against a running
 * server: `OPTIONS /approve` from `https://evil.example` returned 204 with
 * `ACAO: *`, and `GET /status` returned 200 with the same — so any page the
 * operator happened to be browsing could drive a loopback Chamber and read
 * what came back. `POST /turn` completed unauthenticated and committed a
 * belief.
 *
 * A wildcard is not a CORS configuration, it is the absence of one. Same-origin
 * is the only default that is right without knowing the deployment.
 */
const CORS_ORIGINS = new Set(
  (process.env.CHAMBER_CORS_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== ""),
);

/**
 * CORS headers for one request, or none.
 *
 * Echoes the request's own Origin rather than the allowlist entry, because a
 * response may name exactly one origin and echoing is what makes an allowlist
 * of more than one work. `Vary: Origin` is not optional once the value depends
 * on the request: without it a shared cache can hand one origin's response to
 * another, which turns a correct allowlist back into a wildcard.
 */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !CORS_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

/**
 * May this request run at all?
 *
 * Distinct from `corsHeaders`, which only decides who may read the reply. A
 * browser will happily *send* a cross-origin POST without asking permission
 * first — `Content-Type: text/plain` makes it a "simple request" — and discard
 * the response it is not allowed to read. For a route whose point is the side
 * effect, discarding the response is no protection at all.
 *
 * No Origin header means no browser, so it passes: curl, the CLI and
 * server-to-server callers never set one. A present Origin must be named in
 * the allowlist.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  // Same-origin form posts and some clients send `Origin: null`; it names no
  // allowlistable host, so it is treated as untrusted rather than absent.
  return CORS_ORIGINS.has(origin);
}

/**
 * Refuse to serve an unauthenticated port to a network.
 *
 * Loopback with no token stays allowed — that is `npm run serve` on a laptop,
 * and demanding a token there would only teach people to export a fixed one.
 * Binding somewhere reachable without a token is a different act, and the
 * shipped Dockerfile set `CHAMBER_BIND=0.0.0.0` while requiring no token, so
 * the image's own defaults produced exactly that. Fail closed at startup,
 * where it is one line to fix, rather than at the first unauthenticated
 * request, where nobody is watching.
 */
function assertBindIsSafe(): void {
  if (API_TOKEN) return;

  // Socket activation is checked first, because CHAMBER_BIND does not describe
  // it at all. Under systemd the listening socket is created by the .socket
  // unit and handed over as fd 3; `server.listen({ fd: 3 })` inherits whatever
  // address that unit declares. So a deployment whose chamber.socket says
  // `ListenStream=0.0.0.0:8787` — which deploy/systemd/README.md documents as
  // the way to expose it — served every route unauthenticated while this guard
  // read CHAMBER_BIND, found the default "127.0.0.1", and returned happily.
  //
  // The address behind an inherited fd cannot be read from the environment, so
  // there is nothing here to inspect and no safe assumption to make. Refuse
  // without a token and say why.
  const socketActivated =
    Number(process.env.LISTEN_FDS ?? 0) > 0 &&
    Number(process.env.LISTEN_PID ?? 0) === process.pid;
  if (socketActivated) {
    throw new Error(
      `refusing socket activation without CHAMBER_API_TOKEN: the listening ` +
        `address comes from the .socket unit, not from CHAMBER_BIND, so this ` +
        `process cannot tell whether it is about to serve the network. Set ` +
        `CHAMBER_API_TOKEN in the unit's environment.`,
    );
  }

  const loopback = BIND === "127.0.0.1" || BIND === "::1" || BIND === "localhost";
  if (loopback) return;
  throw new Error(
    `refusing to bind ${BIND} without CHAMBER_API_TOKEN: every route except ` +
      `GET /health would be open to anyone who can reach this port. ` +
      `Set CHAMBER_API_TOKEN, or bind 127.0.0.1.`,
  );
}
/**
 * The database this process actually opened.
 *
 * Starts as the path the settings resolve to and is repointed by `onRedirect`
 * if `openChamberDb` had to store the data somewhere else. Read only by the
 * startup lines in `listenServer`, which used to print
 * `process.env.CHAMBER_DB ?? "/tmp/chamber.sqlite"` — a *request*, and after a
 * redirect not even that. An operator reads that line to learn where their
 * data is; it has to name the file the rows are in.
 */
let dbPath = "";

/**
 * Open the configured database, or refuse to start.
 *
 * The open is at module scope, which means a malformed config throws during
 * import rather than somewhere a request handler could catch it. That is the
 * right shape for a server and it stays: this process exists to hold an audit
 * chain, and the alternatives to failing here are all worse. Deferring the
 * open to the first request would leave a listening socket that answers
 * `GET /health` with 200 while no database exists — a server that looks alive
 * and cannot record anything. Falling back to a scratch database would accept
 * writes and discard them, which is the exact failure this whole change is
 * about. So it fails closed, before the port is bound, and nothing can send it
 * work it will lose.
 *
 * What was missing is not the failure but its legibility: an uncaught throw
 * during module evaluation prints a stack trace through node's ESM loader,
 * which does not say "your config file is bad" to anyone who is not reading
 * the source. This catch names the config file, the reason, and what the
 * server did about it, then exits non-zero so a supervisor sees a failure
 * rather than a silent daemon. It deliberately does not retry or relocate —
 * `openChamberDb` has already exhausted the relocations that are safe, and
 * everything that reaches here (a config that will not parse, a corrupt
 * database, a broken schema file) is a fault an operator has to see.
 */
const db: DatabaseSync = ((): DatabaseSync => {
  try {
    dbPath = loadConfig().database;
    return openChamberDb(dbPath, (actual) => {
      dbPath = actual;
    });
  } catch (err) {
    process.stderr.write(
      `chamber-server: FATAL — cannot open Chamber's database: ` +
        `${formatErrorChain(err).join("; ")}\n` +
        `chamber-server: config is ${configPath()}; CHAMBER_DB overrides it. ` +
        `Not starting — a server that cannot record is worse than one that is down.\n`,
    );
    process.exit(1);
  }
})();

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
    // Still walk both sides. `acc` is deliberately discarded: the loop exists
    // for its duration, not its result, so that a wrong-length token costs the
    // same time as a wrong-value one. Deleting it would remove the defence this
    // branch exists to provide.
    let acc = 0;
    const a = provided || " ";
    const b = API_TOKEN;
    for (let i = 0; i < b.length; i++) {
      acc |= (a.charCodeAt(i % a.length) || 0) ^ b.charCodeAt(i);
    }
    void acc;
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

// CORS is applied once per request with `res.setHeader` in the handler below,
// not named here. Node carries setHeader values through `writeHead` for keys
// the call does not itself specify, so every response — including the 401 and
// the error paths — gets the same treatment without threading `req` through
// each of the twenty-odd call sites and relying on nobody forgetting one.
function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
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

    // Applied before anything branches, so the 401, the 404 and the 500 all
    // carry the same policy as a 200. An allowlist that covers only the happy
    // path is not an allowlist.
    const cors = corsHeaders(req);
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

    if (method === "OPTIONS") {
      // No allowlist match means no CORS headers, so the preflight fails and
      // the browser never sends the real request. Previously this answered
      // every origin with a wildcard, which is what made POST /approve
      // reachable from any page.
      res.writeHead(204, {
        ...cors,
        ...(Object.keys(cors).length > 0
          ? {
              "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
              "Access-Control-Allow-Headers":
                "Content-Type, Authorization, X-Chamber-Token",
            }
          : {}),
      });
      res.end();
      return;
    }

    // Refuse the request, rather than merely withholding the response.
    //
    // The CORS allowlist above decides who may *read* a reply. It does not
    // decide who may cause one, and those are different questions: a POST with
    // `Content-Type: text/plain` is a CORS "simple request", so the browser
    // sends it with no preflight at all and only discards the response
    // afterwards. The write has already happened by then.
    //
    // Proven against this build before the fix: a cross-origin
    // `POST /turn` with `Content-Type: text/plain;charset=UTF-8` returned 200,
    // started a session, called the model and committed two beliefs. The reply
    // was unreadable to the page that sent it, which is worth exactly nothing
    // when the route's purpose is the side effect. `POST /approve` is the same
    // shape and decides whether a queued write is applied.
    //
    // So an Origin that the allowlist does not name is rejected outright.
    // Requests with no Origin header — curl, the CLI, a server-to-server call,
    // any non-browser client — are unaffected, because a browser always sets
    // Origin on a cross-origin request and it is the browser case this exists
    // to stop. This runs before requireAuth so the refusal does not depend on
    // whether a token happens to be configured.
    if (!originAllowed(req)) {
      json(res, 403, {
        error: "origin_not_allowed",
        hint:
          "This request carried a browser Origin that is not in CHAMBER_CORS_ORIGIN. " +
          "Add it there to allow cross-origin use.",
      });
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
  assertBindIsSafe();
  const listenPid = Number(process.env.LISTEN_PID ?? 0);
  // systemd socket activation: FDs start at 3 (SD_LISTEN_FDS_START)
  if (listenFds > 0 && listenPid === process.pid) {
    server.listen({ fd: 3 }, () => {
      console.log(`Chamber HTTP  (socket activation fd=3, LISTEN_FDS=${listenFds})`);
      console.log(`db=${dbPath}`);
      console.log(
        `auth=${API_TOKEN ? "token-required" : "open (set CHAMBER_API_TOKEN)"}` +
          `  cors=${CORS_ORIGINS.size > 0 ? [...CORS_ORIGINS].join(",") : "same-origin only"}`,
      );
    });
    return;
  }
  server.listen(PORT, BIND, () => {
    console.log(`Chamber HTTP  http://${BIND}:${PORT}`);
    console.log(`db=${dbPath}`);
    console.log(
      `auth=${API_TOKEN ? "token-required" : "open (set CHAMBER_API_TOKEN)"}` +
        `  cors=${CORS_ORIGINS.size > 0 ? [...CORS_ORIGINS].join(",") : "same-origin only"}`,
    );
  });
}

listenServer();