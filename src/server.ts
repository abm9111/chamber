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
 *   POST /approve       { "writeId": "..." }   (decided_by is always "http")
 *   POST /reject        { "writeId": "...", "note": "..." }
 *   POST /deliberate    { "kind", "subjectId", "question", "stakes?" }
 *   GET  /checkpoint
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { openChamberDb } from "./db.ts";
import { configPath, loadConfig } from "./config.ts";
import { formatErrorChain } from "./error_chain.ts";
import { spendLastHours, formatSpendFooter } from "./spend.ts";
import {
  decideWrite,
  listPendingQueue,
  markApplied,
  expireStalePending,
} from "./approvals.ts";
import { openDeliberation, FACULTY_LABEL } from "./faculty.ts";
import { buildCheckpointReceipt } from "./checkpoint_export.ts";
import { listOpenDebts } from "./debt.ts";
import { listMemory } from "./memory.ts";
import { registerSlackPendingHook } from "./slack_ops.ts";
import { isSqliteBusy, runTurn } from "./turn.ts";
import { TurnPool, TurnWorkerError } from "./turn_pool.ts";

// Registered here for the one case where a turn still runs on this thread (an
// in-memory database, see `turns` below). A turn on the worker registers its own.
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

/** Hostnames a request may name when no token protects the port. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * With no token set, does this request's `Host` header name this machine?
 *
 * Binding 127.0.0.1 keeps other machines out, but not a web page the operator
 * is browsing: DNS rebinding points `attacker.example` at 127.0.0.1, the
 * browser then treats `http://attacker.example:8787` as that page's own origin,
 * and with no token nothing else stands in the way. The page's `Host` header is
 * still `attacker.example`, so refusing every Host that is not loopback closes
 * it. The hostname comes from parsing `http://<Host>`, which drops the port and
 * any userinfo (`127.0.0.1@attacker.example` has the host `attacker.example`);
 * a header that does not parse, or is missing, is refused.
 *
 * With a token the check is off: the token is the credential, and proxies that
 * forward `Host: $host` must keep working. Every proxy deployment in `deploy/`
 * sets one.
 */
function hostAllowed(req: IncomingMessage): boolean {
  if (API_TOKEN) return true;
  const header = req.headers.host;
  if (typeof header !== "string" || header === "") return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${header}`).hostname);
  } catch {
    return false;
  }
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

/** How long this thread's connection waits for the write lock the turn worker may hold. */
const MAIN_THREAD_BUSY_MS = 250;

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
    const opened = openChamberDb(dbPath, (actual) => {
      dbPath = actual;
    });
    // A turn on the worker holds SQLite's one write lock across an embedder
    // spawn (FM-6: the check and the write are one transaction, and that is
    // not negotiable). A route on this thread that writes would then wait on
    // that lock, and `DatabaseSync` waits with the whole event loop stopped.
    // `openChamberDb` leaves a 5 s wait, which is right for a command line and
    // wrong here: keep it short, so a contended write fails fast with the 503
    // below instead of freezing every other route. Reads are not affected (WAL).
    opened.exec(`PRAGMA busy_timeout = ${MAIN_THREAD_BUSY_MS}`);
    return opened;
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

/**
 * Where `POST /turn` runs.
 *
 * On a worker thread, with its own connection to the same file, unless the
 * database is `:memory:` (the dev and test mode, or the last-resort fallback
 * `openChamberDb` announces on stderr): an in-memory database belongs to the
 * connection that created it, so a second thread would see an empty one. There
 * the turn runs on this thread, as it always did.
 *
 * `.ts` when this file is running as TypeScript, `.js` from the compiled npm
 * package.
 */
const turns: TurnPool | null =
  dbPath === ":memory:"
    ? null
    : new TurnPool(
        new URL(
          `./turn_worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
          import.meta.url,
        ),
        dbPath,
      );

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

/** Largest request body Chamber will read: the `client_max_body_size 1m` of deploy/nginx-chamber.conf. */
const MAX_BODY_BYTES = 1_048_576;
/** After a 413, how much more of the body is thrown away before the socket is closed. */
const LINGER_BYTES = 8 * 1024 * 1024;
/** After a 413, how long the client has to finish sending before the socket is closed. */
const LINGER_MS = 2000;

/**
 * Answer 413 and close, without ever buffering the body.
 *
 * The response is written whole (it has a Content-Length, so the client has
 * everything it needs) and `res.end()` is held back while the rest of the
 * upload is read and discarded, up to LINGER_BYTES or LINGER_MS. Closing at
 * once is what a naive refusal does, and measured here it loses the response
 * more often than not: the client is still writing 2 MiB, the close resets the
 * connection, and the 413 never arrives (22 of 40 tries saw no response at
 * all). Discarding is not reading: nothing is kept.
 */
function refuseBody(req: IncomingMessage, res: ServerResponse): void {
  const payload = JSON.stringify({ error: "payload_too_large", limit: MAX_BODY_BYTES }, null, 2);
  res.writeHead(413, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    Connection: "close",
  });
  res.write(payload);
  let discarded = 0;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    res.end();
  };
  const timer = setTimeout(finish, LINGER_MS);
  req.on("data", (c: Buffer) => {
    discarded += c.length;
    if (discarded > LINGER_BYTES) finish();
  });
  req.on("end", finish);
  req.on("error", finish);
  req.on("close", finish);
}

/**
 * The request body as text, or null after answering 413 itself.
 *
 * A declared Content-Length over the cap is refused before a byte is read. A
 * body with no Content-Length (chunked) is refused the moment the running total
 * passes the cap, and what was buffered is dropped.
 */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    refuseBody(req, res);
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let refused = false;
    req.on("data", (c: Buffer) => {
      if (refused) return;
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        refused = true;
        chunks.length = 0;
        refuseBody(req, res);
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!refused) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * The request body as a JSON object, or null after answering the request itself
 * (413 for a body over the cap, 400 `invalid_json` for text that is not JSON or
 * is JSON but not an object). An empty body is `{}`.
 */
async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req, res);
  if (raw === null) return null;
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    json(res, 400, { error: "invalid_json" });
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    json(res, 400, { error: "invalid_json" });
    return null;
  }
  return parsed as Record<string, unknown>;
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

const server = createServer(async (req, res) => {
  try {
    // First, before CORS headers, the OPTIONS branch, the Origin check and auth,
    // and for every path including /health: see `hostAllowed`.
    if (!hostAllowed(req)) {
      json(res, 403, { error: "host_not_allowed" });
      return;
    }

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
      const body = await readJson(req, res);
      if (body === null) return;
      const message = String(body.message ?? body.text ?? "").trim();
      if (!message) {
        json(res, 400, { error: "message required" });
        return;
      }
      json(res, 200, turns === null ? runTurn(db, message) : await turns.run(message));
      return;
    }

    if (method === "POST" && path === "/approve") {
      const body = await readJson(req, res);
      if (body === null) return;
      const writeId = String(body.writeId ?? "");
      if (!writeId) {
        json(res, 400, { error: "writeId required" });
        return;
      }
      // The decider is "http", always. `body.actor` used to be written into
      // `pending_write.decided_by`, so a caller could sign its approval as
      // `human` or `slack:U123`. A route that cannot tell who is calling must
      // not let the caller say.
      const r = decideWrite(db, {
        writeId,
        decision: "approved",
        decidedBy: "http",
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
      const body = await readJson(req, res);
      if (body === null) return;
      const writeId = String(body.writeId ?? "");
      const r = decideWrite(db, {
        writeId,
        decision: "rejected",
        decidedBy: "http",
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
      const body = await readJson(req, res);
      if (body === null) return;
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
      // One transaction, so a 503 `busy` writes nothing and a failure part-way
      // leaves nothing. `openDeliberation` is a run of autocommit statements
      // (the deliberation row, one vote per faculty, the tally, the audit row,
      // the spend row); with this thread's 250 ms wait on the write lock
      // (`MAIN_THREAD_BUSY_MS`) a turn on the worker can take the lock between
      // two of them, and the client was told to retry a request that had half
      // happened. It is safe to wrap because everything it calls is synchronous
      // and local: `completeSync` is the stub (it throws on the openai mode and
      // `openDeliberation` catches that), and `appendAudit` joins a transaction
      // that is already open instead of starting its own. Nothing here awaits,
      // so no other request runs on this connection between BEGIN and COMMIT.
      db.exec("BEGIN IMMEDIATE");
      let r: ReturnType<typeof openDeliberation>;
      try {
        r = openDeliberation(db, {
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
        db.exec("COMMIT");
      } catch (e) {
        // SQLite rolls some failures back by itself (a full disk, an I/O error);
        // a ROLLBACK that then throws must not replace the error that matters.
        try {
          db.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        throw e;
      }
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
    // The write lock is held by a turn on the worker (see `MAIN_THREAD_BUSY_MS`).
    // That is a wait that ran out, not a fault: say so, tell the client when to
    // come back, and log nothing, so no error id points an operator at a bug.
    if (!res.headersSent && (isSqliteBusy(err) || (err instanceof TurnWorkerError && err.busy))) {
      res.setHeader("Retry-After", "1");
      json(res, 503, { error: "busy" });
      return;
    }
    // The client learns that something failed and a number to quote; the cause
    // goes to stderr beside the same number. `String(err)` used to be the body,
    // which sent paths, SQL and module names to whoever asked.
    const id = randomUUID().slice(0, 8);
    process.stderr.write(
      `chamber server error ${id}: ` +
        `${(err instanceof TurnWorkerError ? err.chain : formatErrorChain(err)).join("; ")}\n` +
        `${err instanceof Error && err.stack ? err.stack : ""}\n`,
    );
    if (res.headersSent) {
      res.end();
    } else {
      json(res, 500, { error: "internal_error", id });
    }
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