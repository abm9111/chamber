#!/usr/bin/env -S node --experimental-strip-types
/**
 * Chamber as an MCP server — the read side, over stdio.
 *
 * This is the opposite direction from `src/mcp_client.ts`. That module lets
 * Chamber *call* other MCP servers behind its allowlist; this one lets a host
 * (Claude Code, or anything else speaking MCP) call Chamber. The two share no
 * code and no trust assumptions, which is deliberate: an inbound caller is not
 * a peer, it is a client of three named queries.
 *
 * ## What is exposed, and what is not
 *
 * Three tools: ask, verify, corpus. No tool here can activate a skill, approve
 * a pending write, or run an ingest. `ingest` is excluded for a dull reason —
 * it is a long write the scheduled 08:30 job already owns, and two of them
 * racing is how this database got locked before.
 *
 * ## `chamber_ask` writes, and one of the things it writes is beliefs
 *
 * `chamber_verify` and `chamber_corpus` are pure SELECTs. `chamber_ask` is
 * not, and the distinction is bigger than accounting: `runAsk` puts every
 * claim through `enforceClaimContract`, which calls `commitBelief`. A claim
 * with verified citations lands in the ledger with its pins; an unsourced
 * assertion mints citation debt; spend is recorded. Measured: five MCP asks
 * during the first live test wrote five beliefs, one of them carrying five
 * pinned sources.
 *
 * That is not a hole — it is how beliefs enter the ledger at all, on this
 * surface exactly as on the command line, and it is what gives `verify`
 * something to detect drift *in*. But it does mean the honest claim is "the
 * gate is not bypassed", not "nothing is written". An earlier version of this
 * file asserted the latter in its own tool description, which was false in a
 * way a caller could act on.
 *
 * What stays off the surface is everything that would let a caller get *past*
 * a gate rather than through it: no skill activation, no approving a pending
 * write, no direct ledger access. The gates exist so a human passes through
 * them, and handing a model the approval side would not weaken them so much
 * as invert them — the audit chain would faithfully record a model clearing
 * its own conclusions.
 *
 * ## stdout belongs to the protocol
 *
 * Every frame is newline-delimited JSON on stdout, and a single stray
 * `console.log` from anywhere in the imported graph corrupts the stream and
 * takes the session down with a parse error that names no culprit. The
 * console is therefore rebound to stderr before anything else is imported;
 * see below.
 */

import type { DatabaseSync } from "node:sqlite";
import { openChamberDb } from "./db.ts";
import { loadConfig, applyModelEnv } from "./config.ts";
import { runAsk, stubDisclosure } from "./ask.ts";
import { verifyBeliefSources } from "./pins.ts";
import { corpusStats } from "./corpus.ts";
import { formatErrorChain } from "./error_chain.ts";

// `console.error` already writes to stderr, so it is left alone and the rest
// are aliased onto it: diagnostics still reach the host's MCP log, they just
// never reach the wire.
//
// This runs after the imports and cannot be moved earlier — ESM hoists import
// declarations above every statement, so a module that printed while being
// *evaluated* would still land on stdout. None do; every print in the graph
// happens inside a function, and no function here is called before this line.
// If that ever changes, the symptom is the host disconnecting on a JSON parse
// error that names no culprit.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const SERVER_NAME = "chamber";
const SERVER_VERSION = "0.1.5";
const DEFAULT_PROTOCOL = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Opened on first use, not at startup.
 *
 * A host may spawn this process and never call a tool. Opening the database
 * eagerly would then create it — `openChamberDb` creates parents and applies
 * schema — as a side effect of merely listing tools, which is a write nobody
 * asked for.
 */
let db: DatabaseSync | null = null;
function getDb(): DatabaseSync {
  if (!db) {
    const config = loadConfig();
    // Not optional, and not cosmetic: without it `complete()` reads its
    // default and every answer comes from the canned stub, in fluent prose,
    // while the config file says `"mode": "openai"`. Measured on this machine
    // — the first version of this file omitted it and `chamber_ask` returned
    // stub text that a reader would have taken for a real refusal.
    applyModelEnv(config);
    db = openChamberDb(config.database);
    // Announced because this process pins these values for its whole life.
    //
    // applyModelEnv seeds only what is unset, which is what makes env outrank
    // config — and it also means a config edit can never reach a server that
    // has already run one tool call. Editing the model base while a host held
    // this process open produced ECONNREFUSED against the *old* address, which
    // reads as a broken config rather than a stale daemon; the CLI answered
    // fine from the same file at the same moment. One line on stderr, which
    // the host keeps in its MCP log, is the difference between diagnosing that
    // in a minute and doubting the config file.
    console.error(
      `chamber mcp: db=${config.database} model=${process.env.CHAMBER_MODEL} ` +
        `base=${process.env.CHAMBER_API_BASE ?? "(unset)"} ` +
        `— pinned for this process; reconnect the server after editing config`,
    );
  }
  return db;
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

const TOOLS = [
  {
    name: "chamber_ask",
    description:
      "Ask a question of the local Chamber corpus and get an answer whose " +
      "every claim is judged against its own citations. Each claim comes back " +
      "ALLOWED (its cited passages verified against their stored hashes) or " +
      "UNSUPPORTED (no verified source — recorded, not load-bearing). Cited " +
      "sources are returned as file#passage references you can open. Answers " +
      "only from the indexed corpus; says so when nothing matches. NOTE: this " +
      "WRITES, exactly as `chamber ask` does — each claim goes through the " +
      "commit gate, so a claim with verified citations is recorded as a belief " +
      "with its pins (which is what `chamber_verify` later checks for drift), " +
      "an unsourced assertion mints citation debt, and spend is recorded. It " +
      "cannot bypass that gate, activate a skill, or approve a pending write.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask." },
        strict: {
          type: "boolean",
          description:
            "Refuse assertions that have no verified source instead of " +
            "minting citation debt for them. Default false.",
        },
        exact: {
          type: "boolean",
          description:
            "Retrieve only passages containing the question as a literal " +
            "phrase. Narrowing; use for identifiers and codenames.",
        },
        semantic: {
          type: "boolean",
          description:
            "Vector-only retrieval, switching off the lexical leg that runs " +
            "alongside it by default. Contradicts `exact`.",
        },
      },
      required: ["question"],
    },
    // readOnlyHint false is the load-bearing one: hosts that gate writes must
    // treat this tool as writing, because it is (beliefs, pins, debt, spend —
    // see the description). destructiveHint false because nothing existing is
    // altered or deleted; rows are only added through the gate. openWorldHint
    // is deliberately ABSENT: whether a model call leaves this machine
    // depends on config (loopback vs remote endpoint), and an annotation that
    // guesses is worse than one that abstains.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "chamber_verify",
    description:
      "Re-check every stored belief's pinned sources against the corpus as it " +
      "stands now, and report the ones whose evidence moved: a source that no " +
      "longer exists (not_found) or whose text changed under the pin " +
      "(hash_mismatch). This is drift detection — the conclusion did not " +
      "change, the ground under it did. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description:
            "Only check beliefs committed at or after this date (any format " +
            "Date can parse, e.g. 2026-07-01). Omit to check all.",
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "chamber_corpus",
    description:
      "Report what is actually in the index: passage and file counts, source " +
      "kinds and which of them are citable, the top contributing folders, and " +
      "any file far above the median passage count (the signature of an " +
      "export rather than a note). Use this before trusting a 'nothing " +
      "matches' answer. Read-only.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
];

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "chamber_ask": {
      const question = String(args.question ?? "").trim();
      if (!question) throw new Error("chamber_ask: `question` is required");
      const exact = args.exact === true;
      const semantic = args.semantic === true;
      // The CLI refuses this combination rather than silently picking one, and
      // a second surface that quietly resolves it would mean the same call
      // means different things depending on where it was made.
      if (exact && semantic) {
        throw new Error(
          "chamber_ask: `semantic` and `exact` contradict — `exact` is a lexical filter",
        );
      }
      const r = await runAsk(getDb(), question, {
        strict: args.strict === true,
        exact,
        hybrid: !semantic,
      });
      if (!r.modelCalled) return r.note ?? "no passages retrieved";

      const label = new Map(r.passages.map((p) => [p.documentId, p.label]));
      const out: string[] = [];
      // First, above the answer, and inside the tool result rather than on
      // stderr. The stderr announcement in getDb() reaches the host's MCP log;
      // it does not reach whoever reads this string, and on the config path
      // that lands here it prints `model=undefined` rather than the word stub.
      const disclosure = stubDisclosure(r.modelMode);
      if (disclosure) out.push(disclosure, "");
      out.push(r.answer, "");
      // Printed next to the answer, never in place of it: an answer produced
      // over a filtered view of the corpus is still an answer, but the caller
      // has to know the view was filtered.
      if (r.note) out.push(`note: ${r.note}`, "");
      out.push("per-claim citation verdicts:");
      for (const c of r.claims) {
        if (c.kind === "chatter") continue;
        out.push(`  [${c.status}] ${c.text}`);
        const cites = c.citedRefs.map((id) => label.get(id) ?? id);
        if (cites.length) out.push(`     sources: ${cites.join(", ")}`);
        for (const rj of c.rejected) {
          out.push(`     rejected ${rj.refId}: ${rj.reason}`);
        }
        if (c.debtIds.length) out.push(`     citation debt: ${c.debtIds.join(", ")}`);
      }
      return out.join("\n");
    }

    case "chamber_verify": {
      let since: string | undefined;
      if (args.since !== undefined && args.since !== null) {
        // An unparseable date must not degrade to "no filter". The underlying
        // query is a raw TEXT compare, so garbage silently excludes or
        // includes everything and reports a clean run either way — the one
        // failure mode a drift check cannot absorb.
        const parsed = new Date(String(args.since));
        if (Number.isNaN(parsed.getTime())) {
          throw new Error(
            `chamber_verify: \`since\` is not a valid date: ${JSON.stringify(args.since)}`,
          );
        }
        since = parsed.toISOString();
      }
      const report = verifyBeliefSources(getDb(), { since });
      const broken = report.filter((b) => b.verified === 0);
      const degraded = report.filter((b) => b.verified > 0 && b.failures.length > 0);
      // Same rendering rule as the CLI: moved is info, never drift. A pin in
      // this list verified — its title and body are byte-identical at a new
      // position in the same file (findMovedWithinFile) — so it appears in
      // neither count above.
      const moved = report.flatMap((b) => b.relocations);
      const movedLines =
        moved.length === 0
          ? []
          : [
              "",
              `${moved.length} pinned passage(s) found at a new position in the same file` +
                ` (pinned text intact there; a duplicate passage in the same file is` +
                ` indistinguishable from a move):`,
              ...moved.slice(0, 3).map((m) => `  ${m.from} → ${m.to ?? "(position unknown)"}`),
              ...(moved.length > 3 ? [`  … and ${moved.length - 3} more`] : []),
            ];
      const out = [
        `${report.length} belief(s) checked · ${broken.length} with no verified support left · ` +
          `${degraded.length} with some support lost`,
      ];
      if (broken.length === 0 && degraded.length === 0) {
        // "still says what it said" is only true of pins that verified in
        // place. A relocated pin was matched by content at a different
        // position, which cannot be told apart from a duplicate — so the
        // unconditional sentence is false whenever one is present, and a
        // reader takes it for a clean bill of health.
        out.push(
          "",
          moved.length === 0
            ? "No drift. Every pinned source still says what it said."
            : "No drift detected. Note the relocations below — those pins were matched by content, not position.",
        );
        out.push(...movedLines);
        return out.join("\n");
      }
      out.push(...movedLines);
      for (const b of [...broken, ...degraded]) {
        out.push("", `${b.beliefId}  ${b.verified}/${b.total} pins verified`);
        out.push(`  "${b.content}"`);
        for (const f of b.failures) {
          // not_found needs its own branch, as the CLI has. Its `sourceRef`
          // is the position the pin was MINTED against — historical, and no
          // longer resolving — so the shared rendering above printed it
          // exactly like a live location a reader could go and open.
          if (f.reason === "not_found") {
            out.push(
              f.sourceRef
                ? `  not_found: ${f.refId} — minted against ${f.sourceRef}, which no longer resolves`
                : `  not_found: ${f.refId}`,
            );
          } else {
            out.push(
              `  ${f.reason}: ${f.sourceRef ?? f.refId}` +
                (f.title ? ` (now holds: ${f.title})` : ""),
            );
          }
        }
      }
      return out.join("\n");
    }

    case "chamber_corpus": {
      const s = corpusStats(getDb());
      if (s.passages === 0) return "corpus is empty — run `chamber ingest`";
      const out = [
        `${s.passages.toLocaleString()} passages · ${s.files.toLocaleString()} files · ` +
          `${Math.round(s.bytes / 1024).toLocaleString()} KB · ` +
          `${(s.passages / s.files).toFixed(1)} passages/file`,
        "",
        `by kind: ${s.byKind.map((k) => `${k.kind} ${k.passages.toLocaleString()}`).join(" · ")}`,
      ];
      if (s.byKind.some((k) => k.kind !== "vault_page")) {
        out.push(
          "  only vault_page is citable — other kinds are searchable but `ask` will not retrieve them",
        );
      }
      out.push("", "top contributors (first path segment):");
      for (const g of s.groups.slice(0, 12)) {
        out.push(
          `  ${((g.passages / s.passages) * 100).toFixed(1).padStart(5)}%  ` +
            `${g.passages.toLocaleString().padStart(7)} passages  ` +
            `${String(g.files).padStart(5)} files  ${g.name}`,
        );
      }
      if (s.groups.length > 12) {
        const rest = s.groups.slice(12).reduce((a, g) => a + g.passages, 0);
        out.push(`  …and ${s.groups.length - 12} more, ${rest.toLocaleString()} passages`);
      }
      if (s.fattest.length > 0) {
        out.push("", `unusually large files (median is ${s.medianPassagesPerFile} passages):`);
        for (const f of s.fattest) out.push(`  ${f.passages} passages  ${f.file}`);
        out.push("  a file far above the median is usually an export, not a note");
      }
      return out.join("\n");
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function handle(msg: JsonRpcRequest): Promise<void> {
  const { id, method } = msg;
  // A notification carries no id and must never be answered — replying to one
  // is a protocol violation the host is entitled to hang up over.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      if (isNotification) return;
      // Echo the client's protocol version. This server implements only the
      // stable core — initialize, tools/list, tools/call — which no revision
      // has changed, so agreeing with the client beats asserting a version it
      // may not know and being hung up on.
      const asked = msg.params?.protocolVersion;
      send({
        id,
        result: {
          protocolVersion: typeof asked === "string" ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping": {
      if (!isNotification) send({ id, result: {} });
      return;
    }
    case "tools/list": {
      if (isNotification) return;
      send({ id, result: { tools: TOOLS } });
      return;
    }
    case "tools/call": {
      if (isNotification) return;
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = await callTool(name, args);
        send({ id, result: { content: [{ type: "text", text }] } });
      } catch (err) {
        // A tool that fails reports through the result, not a JSON-RPC error:
        // the distinction is that the *call* succeeded and the work did not,
        // and the host shows the model the difference. formatErrorChain keeps
        // the cause chain, which is usually where the real reason is — "model
        // unreachable" hides under "ask failed".
        send({
          id,
          result: {
            content: [{ type: "text", text: formatErrorChain(err).join("\n") }],
            isError: true,
          },
        });
      }
      return;
    }
    default: {
      if (isNotification) return;
      send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }
}

/**
 * Frames arrive newline-delimited and a read can split one mid-object, so the
 * tail is carried forward rather than parsed. Messages are handled in
 * sequence: `runAsk` is async, and letting two of them interleave on one
 * DatabaseSync connection is how a shared handle gets a write in the middle
 * of someone else's read.
 */
let buffer = "";
let chain: Promise<void> = Promise.resolve();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      send({ id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    chain = chain.then(() => handle(msg)).catch((err: unknown) => {
      console.error(formatErrorChain(err).join("\n"));
    });
  }
});

/**
 * EOF on stdin means no further requests will arrive — it does not mean the
 * requests already accepted are finished.
 *
 * This handler used to be a bare `process.exit(0)`, and it silently discarded
 * in-flight work: driving the server with a piped script, `initialize`
 * answered and the `tools/call` behind it produced nothing at all, exit 0. A
 * host that closes the pipe promptly would see a tool that returns empty
 * rather than one that failed, which is the reading this project exists to
 * make impossible.
 *
 * Awaiting the chain is sound precisely because stdin has ended: nothing can
 * append to it after this point, so the promise in hand is the last one.
 */
process.stdin.on("end", () => {
  void chain.finally(() => {
    process.exit(0);
  });
});
