# Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix audit findings HIGH-3, M1-M5, M7 and the related Lows: model calls time out, the HTTP server checks `Host`, caps and validates bodies and stops leaking error text, OAuth URLs are parsed, the database file is private, no secret rides on a curl command line, `POST /turn` stops blocking the server, the sandbox and the talk allowlists fail closed.

**Architecture:** Eight tasks on one branch, each ending green and committed. Server work (Host, body, 500, actor) is tested by starting `src/server.ts` as a real process and talking HTTP to it. `POST /turn` moves into a persistent worker thread (`src/turn_worker.ts`) managed by a small pool class (`src/turn_pool.ts`); the turn itself becomes a function of a database (`src/turn.ts`) that both threads can call. Curl calls that carry secrets go through one helper (`src/http_sync.ts`) that passes the URL, headers and body on stdin as a curl config. The Slack and Discord runners are tested by running the real modules with their two libraries replaced by stubs.

**Tech Stack:** TypeScript run directly by Node (type stripping, no build step), `node:sqlite`, `node:worker_threads`, `node:http`, curl. No runtime dependencies are added.

**Spec:** `docs/superpowers/specs/2026-10-21-runtime-hardening-design.md` (binding; its choices are closed). Read it, and read `CLAUDE.md` at the repo root, before Task 1.

## What running the design found

The spec was checked against the code and by experiment before this plan was written. Everything below was observed, not assumed. **A9 works as specified.** It needed additions the spec did not name (items 2 to 5), and the tasks contain them.

1. **A9, worker and `/health`.** With an embedder that takes 3 s, `/health` answered in about 2 ms while `POST /turn` was inside it. With the turn left on the main thread the same test fails; that is its mutation proof.
2. **A9, the write lock is the catch.** FM-6 keeps the paraphrase check and the write in one `BEGIN IMMEDIATE`, and that transaction spans the embedder spawn. SQLite has one write lock, so the main thread's connection waits for it, and a `DatabaseSync` wait stops the whole event loop. Measured against a real server during the 3 s wait: `/health` and `/checkpoint` answer in about 2 ms; `/status`, `/queue`, `/approve` (for a write that exists) and `/deliberate` wait for the lock, for up to SQLite's default 5 s, with the whole event loop stopped while they wait. (`/status` and `/queue` write because they run the TTL sweep, `expireStalePending`, an `UPDATE`.) **Resolution (Task 5):** the main connection's `busy_timeout` is lowered to 250 ms, so those routes answer `500 internal_error` after about 280 ms instead of freezing, and `docs/KNOWN_LIMITATIONS.md` entry 21 says so. Making them succeed would mean changing `src/approvals.ts`, which is out of scope. Only `/health` is guaranteed during a turn, which is what the spec's test checks.
3. **A9, module state that `/turn` depends on.** A scan of every module-level `let`, `Map`, `Set` and listener array in `src/` found these on the turn path: the rate-limit buckets in `src/surface_harden.ts` (live in the worker for the life of the thread; a restarted worker starts with a full bucket, documented), the embedder caches in `src/embedder.ts` (per-thread caches, harmless), and `pendingListeners` in `src/approvals.ts` (a listener registered on the main thread never fires for a `proposeWrite` that runs in the worker, so the worker registers the Slack hook itself and a test proves it). The server never calls `applyModelEnv`, so it runs on `process.env` alone; a worker copies the environment at start, which is the same thing. Spend, the approval queue and the audit chain tip are rows in the database. The audit chain reads its tip inside `BEGIN IMMEDIATE`, so two connections cannot fork it.
4. **A9, `:memory:`.** An in-memory database belongs to the connection that created it; a worker would open an empty one. When the server's database path is `:memory:` (the tests' mode, or `openChamberDb`'s announced last-resort fallback) the turn runs inline, as it always did.
5. **A9, the compiled package.** The worker file is `turn_worker.ts` from source and `turn_worker.js` from `dist/`; the server picks the extension from `import.meta.url`. Task 5 builds `dist/` and runs it once to prove the worker loads from the compiled package, then deletes `dist/` (a leftover `dist/` makes `bin/chamber.js` run it instead of `src/`).
6. **A1.** `AbortSignal.timeout` does not refuse a delay above 2147483647: it logs `TimeoutOverflowWarning` and fires at once (measured: a 2147483648 ms timeout aborted within 300 ms). The spec's validation (digits only, not `0`) lets such a value through, so the ceiling 2147483647 is added to the refusal. An empty `CHAMBER_MODEL_TIMEOUT_MS` is refused too (it is "not a string of digits"); only an unset variable means the default.
7. **A3, delivering the 413.** A server that answers 413 and closes at once loses the response more often than not: the client is still writing 2 MiB, the close resets the connection (22 of 40 tries saw no response). The refusal is written whole with a `Content-Length`, then the rest of the upload is read and thrown away (at most 8 MiB or 2 s) before the socket closes. Nothing is buffered. Without this the spec's "2 MiB gives 413" test is flaky.
8. **A5.** The schema comment must list every value written to `decided_by`. The spec lists five; the TTL sweep also writes `system`, so the comment lists six.
9. **A7.** "A file owned by someone else is left alone with one stderr line" is implemented as: the line is printed when that file has group or other bits set (nothing to say about a 0600 file you cannot read). A path whose `stat` fails (a dangling symlink) is left to SQLite.
10. **A8, `curl -K -`.** Verified with a local server before the rules were written: a header and a body holding `"`, `\`, LF, CRLF, TAB, non-ASCII text, a leading `@`, `%{http_code}`, `$HOME` and a backtick arrive byte for byte, 3.6 MB included. Three curl details are built in: the body is `data-raw` (a `data` value starting with `@` makes curl send that file), `globoff` is set (otherwise `[::1]` or `{a}` in a URL is a glob), and the timeout, `write-out` and redirect flag go in the config so the argv is the constant `-s -K -`. Header names must be HTTP tokens and the URL must be http(s); those are closed sets, not escapes (CLAUDE.md), and go beyond the spec's minimum.
11. **D1.** The old default only differed from the new one for unset and empty. Four tests pin the old default (`T1_sandbox_self_test`, `T2_allowlist_echo`, `T4_synth_pass_queues` and "an unset sandbox requirement still runs the subprocess fallback"), found by running the whole suite with the new default. `T5_synth_fail_rejects` still passed but for the wrong reason (the refusal), so it is pinned to the opt-out too.
12. **D2.** The Discord runner already calls `canDiscordTalk` at messages and at `/chamber`; only the predicate changes. The Slack runner had no gate at all. (`CHAMBER_DISCORD_ALLOWED_USERS` set but empty is read before the older `DISCORD_ALLOWED_USERS` and shadows it; that is unchanged, and it fails closed.) A predicate test cannot show a runner calls it, so Task 7 runs the real runner modules with `@slack/bolt` and `discord.js` replaced through a module-resolution hook.
13. **Suites.** `suiteFromArg` maps an unknown `--suite=` to `all`, and `server`, `model`, `db` were used but not listed. Tasks add `model`, `db`, `server`, `http_sync` and `turn_pool` to both the `Suite` union and the list.

## Global Constraints

Every task includes these. They are not repeated inside tasks.

- **Where.** Work only in `/Users/shadow/Projects/chamber/.worktrees/runtime-hardening` (branch `feat/runtime-hardening`). Never `cd` into `/Users/shadow/Projects/chamber`. Run every command from the worktree root.
- **Node.** Node >= 23.6 (`engines` in `package.json`; type stripping is how every `.ts` file runs). TypeScript is `erasableSyntaxOnly`: no enums, namespaces or constructor parameter properties. Check with `node --version`.
- **`node_modules`.** `npm run typecheck` and `npm run lint` need it. If `ls node_modules` shows nothing, run `npm ci` once. The tests and the server need nothing installed.
- **`tests/harness.ts` is 17,000 lines and holds a fixture a secret scanner rejects. Never read it whole and never `cat` it.** Find places with `grep -n` and read bounded ranges with `Read` (`offset` and `limit`). Make every change with the find-and-replace text the step gives you. Each "find" text appears exactly once; `grep -n -F` on its first line shows where. The Edit tool refuses a file you have not read in this session, so first `Read` a short window of `tests/harness.ts` (say 20 lines starting at the line `grep -n` printed); that satisfies it.
- **Where tests go.** New tests and their helper functions go immediately above the line `// ─── report ──────────────────────────────────────────────────────────────────` (the steps do this by replacing that line with the new block followed by the same line). An `async` test declared below that divider is silently never run. A `--suite=NAME` the harness does not know runs everything; the steps add the new names.
- **Gates.** Before Task 1, and again after Task 8, run all four and record the numbers: `npm run typecheck`, `npm run lint`, `npm test`, `npm run probes`. Baseline before this plan: `npm test` reports `535/535 passed`. Every task also ends with `typecheck`, `lint` and the full `npm test`; Task 6 adds `npm run probes`.
- **Commits.** One commit per task, format `type: description`, ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use `git add` with every file named (the task lists them). Never `git add .`, `-A`, `-u` or a directory. Run `git status --short` first; it must show exactly the files the task lists.
- **No push.** Do not run `git push`. Never use `--no-verify` or otherwise bypass a hook, and never edit hooks, `.git/config` or settings.
- **If a command is blocked or fails, quote it verbatim and stop.** That includes a pre-commit hook that refuses a commit. Do not retry around it, and do not report a passing, zero or empty result for a command you did not run.
- **Red before green, and prove the test can fail.** Each task writes its tests first and runs them to see them fail for the stated reason, then implements. After the task is committed, a mutation step removes the fix, shows which test goes red, reverts it with `git checkout -- <file>` and confirms `git diff --exit-code` is silent.
- **Stay in scope.** Do not reformat or refactor code a step does not name, and do not touch `src/commit_belief.ts` (FM-6: the gate check and the write are one transaction). Secrets in tests are obviously fake strings. Do not leave `dist/` in the tree.

## File Structure

| File | Task | Change |
|------|------|--------|
| `src/model.ts` | 1 | timeout on the model request, `modelTimeoutMs` |
| `src/mcp_oauth.ts` | 2, 4 | `requireHttps` parses the URL and is exported; HTTP goes through `httpSync` |
| `src/db.ts` | 2 | `secureDatabaseFile`, directories made `0700` |
| `src/server.ts` | 3, 5 | Host check, body limits, 500 shape, actor; then the worker pool |
| `sql/schema_spend_approvals.sql` | 3 | `decided_by` comment |
| `src/http_sync.ts` (new) | 4 | curl with nothing secret on the command line |
| `src/mcp_client.ts`, `src/slack_ops.ts`, `src/discord_ops.ts`, `src/gateway.ts`, `src/gateway_runner.ts` | 4 | use `httpSync` |
| `src/turn.ts` (new) | 5 | `runTurn(db, message)` and the wire types |
| `src/turn_pool.ts` (new) | 5 | `TurnPool`, `TurnWorkerError` |
| `src/turn_worker.ts` (new) | 5 | the worker-thread entry |
| `src/sandbox.ts` | 6 | required unless explicitly off |
| `src/slack_ops.ts`, `src/discord_ops.ts`, `src/slack_runner.ts`, `src/discord_runner.ts` | 7 | fail-closed talk allowlists enforced in the runners |
| `tests/harness.ts` | 1-7 | all new tests and helpers |
| `docs/KNOWN_LIMITATIONS.md`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `deploy/*` | 1, 5, 6, 7, 8 | documentation |

## Spec coverage

| Spec section | Task | Proved by |
|---|---|---|
| A1 model timeout | 1 | four tests in `model` (silent server, stalled body, refused values, queued MCP call); KNOWN_LIMITATIONS 4 |
| A2 Host check | 3 | `with no token, a Host that is not loopback is refused on every path`, `with a token, the Host header is not policed ...` |
| A3 body cap, invalid JSON | 3 | `a request body over 1 MiB is refused with 413 ...`, `a body that is not a JSON object is a 400 ...` |
| A4 the 500 shape | 3 | `a handler error answers 500 internal_error with an id ...` |
| A5 `/approve` and `/reject` actor | 3 | `/approve and /reject record decided_by 'http' ...`; schema comment |
| A6 OAuth URL parsing | 2 | `requireHttps judges the parsed host ...` |
| A7 database permissions | 2 | four `db` tests |
| A8 no secret on a command line | 4 | four `http_sync` tests; every site through `src/http_sync.ts` |
| A9 `/turn` off the event loop | 5 | `POST /turn runs off the event loop ...`, four `turn_pool` tests, rate-limit, Slack-hook and in-memory tests; KNOWN_LIMITATIONS 21 |
| D1 sandbox default | 6 | three new `tools` tests, five rewritten ones; README, KNOWN_LIMITATIONS 1, SECURITY.md |
| D2 talk allowlists | 7 | `D6_talk_allowlist`, `S_talk_allowlist_fails_closed`, two runner tests; SLACK.md, DISCORD.md |
| CHANGELOG (D1, D2 breaking) and final gates | 8 | |

---

### Task 0: Baseline

**Files:** none changed.

- [ ] **Step 1: Confirm where you are**

Run: `pwd && git branch --show-current && git log --oneline -2 && git status --short && node --version`
Expected: the path ends in `.worktrees/runtime-hardening`; branch `feat/runtime-hardening`; the top commit is `docs: record the runtime hardening design`; `git status --short` prints nothing; Node is v23.6 or newer.

- [ ] **Step 2: Run all four gates and write the results down**

Run each and keep the last lines:

```bash
npm run typecheck
npm run lint
npm test
npm run probes
```

Expected: `typecheck` and `lint` print their command line and nothing else. `npm test` ends with `── 535/535 passed · 0 failed ──` (about two minutes). `npm run probes` exits 0; the last probes print their own pass lines. If any gate is not green before you have changed anything, quote its output and stop.

---

### Task 1: Model calls time out (A1)

**Files:**
- Modify: `src/model.ts`
- Modify: `tests/harness.ts`
- Modify: `docs/KNOWN_LIMITATIONS.md` (entry 4)
- Modify: `deploy/systemd/env.example`

**Interfaces:**
- Produces: `export function modelTimeoutMs(env?: NodeJS.ProcessEnv): number` in `src/model.ts`.
- Produces, in `tests/harness.ts` (later tasks use them): `scriptedModel(script, answerText?)`, `withEnvAsync(vars, fn)`, `rejectionWithin(promise, ms): Promise<Error>`, `resolvesWithin(promise, ms, what)`.

- [ ] **Step 1: Write the failing tests**

Four edits to `tests/harness.ts`. First the import:

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { completeSync } from "../src/model.ts";' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { completeSync } from "../src/model.ts";
```

Replace with:

```ts
import { complete, completeSync, modelTimeoutMs } from "../src/model.ts";
```

Then the tests (they go above the report divider):

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '// ─── report ──────────────────────────────────────────────────────────────────' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
// ─── report ──────────────────────────────────────────────────────────────────
```

Replace with:

```ts
// ─── MODEL TIMEOUT (src/model.ts, CHAMBER_MODEL_TIMEOUT_MS) ──────────────────

type ModelStep = "silent" | "partial" | "answer";

/**
 * A fake OpenAI-compatible server whose behaviour is scripted per request.
 *
 * `silent` accepts the request and never answers. `partial` sends the status
 * line and part of a JSON body and then stalls, which is a different failure:
 * `fetch()` resolves, and only reading the body hangs. `answer` replies. A
 * request past the end of the script gets `answer`.
 */
async function scriptedModel(
  script: ModelStep[],
  answerText = "scripted answer",
): Promise<{ base: string; requests: () => number; close: () => void }> {
  const { createServer } = await import("node:http");
  let seen = 0;
  const server = createServer((req, res) => {
    const step: ModelStep = script[seen] ?? "answer";
    seen++;
    req.resume();
    if (step === "silent") return;
    req.on("end", () => {
      if (step === "partial") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"choices":[{"message":{"content":"par');
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: answerText } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: "fake",
        }),
      );
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    requests: () => seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Set environment variables for the duration of `fn`; `undefined` deletes. */
async function withEnvAsync<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, prev] of saved) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

/**
 * The error `p` rejects with, or a test failure if it is still pending after
 * `ms` or resolves. The watchdog is what makes "hangs forever" a red test
 * instead of a hung test run.
 */
async function rejectionWithin(p: Promise<unknown>, ms: number): Promise<Error> {
  let timer: NodeJS.Timeout | undefined;
  const outcome: unknown = await Promise.race([
    p.then(
      () => "resolved" as const,
      (err: unknown) => err,
    ),
    new Promise<"pending">((ok) => {
      timer = setTimeout(() => ok("pending"), ms);
    }),
  ]);
  clearTimeout(timer);
  assert(outcome !== "pending", `still pending after ${ms} ms`);
  assert(outcome !== "resolved", "expected a rejection, but the call resolved");
  assert(outcome instanceof Error, `expected an Error, got ${String(outcome)}`);
  return outcome;
}

/** `p`'s value, or a test failure if it is still pending after `ms`. */
async function resolvesWithin<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what}: still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

test("model", "a model endpoint that never answers is abandoned at CHAMBER_MODEL_TIMEOUT_MS", async () => {
  const model = await scriptedModel(["silent"]);
  const db = freshDb();
  try {
    const err = await withEnvAsync(
      {
        CHAMBER_MODEL: "openai",
        CHAMBER_API_BASE: model.base,
        CHAMBER_API_KEY: undefined,
        CHAMBER_MODEL_TIMEOUT_MS: "200",
      },
      () =>
        rejectionWithin(
          complete(db, { messages: [{ role: "user", content: "hi" }] }),
          2000,
        ),
    );
    assert(
      err.message ===
        `model endpoint ${model.base} did not answer within 0.2 s (CHAMBER_MODEL_TIMEOUT_MS)`,
      `wrong message: ${err.message}`,
    );
  } finally {
    model.close();
  }
});

test("model", "a body that stalls after the headers is bounded by the same timeout", async () => {
  const model = await scriptedModel(["partial"]);
  const db = freshDb();
  try {
    const err = await withEnvAsync(
      {
        CHAMBER_MODEL: "openai",
        CHAMBER_API_BASE: model.base,
        CHAMBER_API_KEY: undefined,
        CHAMBER_MODEL_TIMEOUT_MS: "300",
      },
      () =>
        rejectionWithin(
          complete(db, { messages: [{ role: "user", content: "hi" }] }),
          2000,
        ),
    );
    assert(
      err.message ===
        `model endpoint ${model.base} did not answer within 0.3 s (CHAMBER_MODEL_TIMEOUT_MS)`,
      `wrong message: ${err.message}`,
    );
  } finally {
    model.close();
  }
});

test("model", "an unusable CHAMBER_MODEL_TIMEOUT_MS is refused by name, never replaced by the default", async () => {
  const db = freshDb();
  for (const bad of ["", "abc", "0", "000", "-5", "1.5", " 200", "200 ", "2147483648"]) {
    const model = await scriptedModel(["answer"]);
    try {
      const err = await withEnvAsync(
        {
          CHAMBER_MODEL: "openai",
          CHAMBER_API_BASE: model.base,
          CHAMBER_API_KEY: undefined,
          CHAMBER_MODEL_TIMEOUT_MS: bad,
        },
        () =>
          rejectionWithin(
            complete(db, { messages: [{ role: "user", content: "hi" }] }),
            1000,
          ),
      );
      assert(
        err.message.includes("CHAMBER_MODEL_TIMEOUT_MS") &&
          err.message.includes(JSON.stringify(bad)),
        `${JSON.stringify(bad)}: the refusal must name the variable and the value: ${err.message}`,
      );
      assert(
        model.requests() === 0,
        `${JSON.stringify(bad)}: refused, but a request still reached the model`,
      );
    } finally {
      model.close();
    }
  }
  assert(modelTimeoutMs({}) === 180_000, "unset means the 180000 ms default");
  assert(
    modelTimeoutMs({ CHAMBER_MODEL_TIMEOUT_MS: "2500" }) === 2500,
    "a whole number of milliseconds is taken as written",
  );
});

test("model", "a timed-out MCP call does not wedge the calls queued behind it", async () => {
  const { env, dir } = stubAskFixture();
  const model = await scriptedModel(["silent"], "SECOND The audit store is SQLite. [1]");
  writeFileSync(
    env.CHAMBER_CONFIG!,
    `${JSON.stringify({ database: env.CHAMBER_DB, ingest: [], model: { base: model.base, name: "fake", mode: "openai" } })}\n`,
  );
  const s = mcpSession({ ...env, CHAMBER_MODEL_TIMEOUT_MS: "500" });
  try {
    // Both are sent before either is answered, so the second really is queued
    // behind the first in the server's serial chain.
    const first = s.ask("what is the audit store");
    const second = s.ask("what is the audit store");
    const [a, b] = await resolvesWithin(
      Promise.all([first, second]),
      15_000,
      "both queued calls",
    );
    assert(
      a.includes("did not answer within 0.5 s (CHAMBER_MODEL_TIMEOUT_MS)"),
      `the first call must fail with the timeout:\n${a}`,
    );
    assert(b.includes("SECOND"), `the queued call must complete:\n${b}`);
  } finally {
    s.stop();
    model.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── report ──────────────────────────────────────────────────────────────────
```

And the two places that list suite names, so `--suite=model` works:

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '  | "release"' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  | "release"
  | "all";
```

Replace with:

```ts
  | "release"
  | "model"
  | "all";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '    "daemon",' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    "daemon",
    "release",
    "all",
  ].includes(v)
```

Replace with:

```ts
    "daemon",
    "release",
    "model",
    "all",
  ].includes(v)
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=model`
Expected: the harness does not start: `SyntaxError: The requested module '../src/model.ts' does not provide an export named 'modelTimeoutMs'`. That is the failure: the feature does not exist.

- [ ] **Step 3: Implement the timeout**

<!-- apply: replace src/model.ts -->
**Edit `src/model.ts`.** Find this text, which appears exactly once (`grep -n -F 'async function openaiComplete(' src/model.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
async function openaiComplete(
  input: CompleteInput,
): Promise<Omit<CompleteResult, "spendId">> {
```

Replace with:

```ts
const DEFAULT_MODEL_TIMEOUT_MS = 180_000;

/**
 * `AbortSignal.timeout` takes a 32-bit signed millisecond count and does not
 * refuse a larger one: it logs TimeoutOverflowWarning and fires after 1 ms.
 * Measured on Node 26.10 — a 2147483648 ms timeout aborted within 300 ms. So the
 * ceiling is enforced here, where the operator can be told, instead of being
 * discovered as a model call that dies at once.
 */
const MAX_MODEL_TIMEOUT_MS = 2_147_483_647;

/**
 * How long one model request may take, from `CHAMBER_MODEL_TIMEOUT_MS`.
 *
 * Unset means the default. Any set value that is not a string of digits naming
 * 1..2147483647 throws and names the variable — including the empty string and
 * `0`. It is never replaced by the default: a typo that silently turned a
 * 20 s budget into 180 s is the same defect as having no budget.
 */
export function modelTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHAMBER_MODEL_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_MODEL_TIMEOUT_MS;
  const ms = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_MODEL_TIMEOUT_MS) {
    throw new Error(
      `CHAMBER_MODEL_TIMEOUT_MS must be a whole number of milliseconds from 1 ` +
        `to ${MAX_MODEL_TIMEOUT_MS}, got ${JSON.stringify(raw)}. Unset it to use ` +
        `the ${DEFAULT_MODEL_TIMEOUT_MS} ms default.`,
    );
  }
  return ms;
}

/** `ms` as seconds, to at most one decimal place: 200 -> "0.2", 180000 -> "180". */
function secondsLabel(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

function isTimeoutError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "TimeoutError"
  );
}

async function openaiComplete(
  input: CompleteInput,
): Promise<Omit<CompleteResult, "spendId">> {
```

<!-- apply: replace src/model.ts -->
**Edit `src/model.ts`.** Find this text, which appears exactly once (`grep -n -F '  const model = process.env.CHAMBER_API_MODEL ?? "gpt-4o-mini";' src/model.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  const model = process.env.CHAMBER_API_MODEL ?? "gpt-4o-mini";
  // Omitted entirely rather than sent as "Bearer undefined", which some local
  // servers reject outright and others log as a credential.
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: input.messages,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`openai complete ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };
```

Replace with:

```ts
  const model = process.env.CHAMBER_API_MODEL ?? "gpt-4o-mini";
  // Read before the request exists, so a bad value fails the call before any
  // network traffic.
  const timeoutMs = modelTimeoutMs();
  // One signal for the whole exchange: connecting, waiting for headers and
  // reading the body all run on this clock. A server that sends a status line
  // and then stalls is abandoned exactly like one that never answers.
  const signal = AbortSignal.timeout(timeoutMs);
  type CompletionBody = {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };
  let data: CompletionBody;
  try {
    // Omitted entirely rather than sent as "Bearer undefined", which some local
    // servers reject outright and others log as a credential.
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: input.messages,
        temperature: 0.3,
      }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`openai complete ${res.status}: ${body.slice(0, 300)}`);
    }
    data = (await res.json()) as CompletionBody;
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(
        `model endpoint ${base} did not answer within ${secondsLabel(timeoutMs)} s ` +
          `(CHAMBER_MODEL_TIMEOUT_MS)`,
        { cause: err },
      );
    }
    throw err;
  }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=model`
Expected: five lines `[PASS]` (the four new tests and the existing `model/openai mode needs no API key for a loopback base`) and `── 5/5 passed · 0 failed ──`. The MCP test takes about 2.5 s.

- [ ] **Step 5: Document it**

Rewrite entry 4 of `docs/KNOWN_LIMITATIONS.md` (it said the call has no timeout):

<!-- apply: replace docs/KNOWN_LIMITATIONS.md -->
**Edit `docs/KNOWN_LIMITATIONS.md`.** Find this text, which appears exactly once (`grep -n -F '## 4. A stalled model endpoint hangs the process forever' docs/KNOWN_LIMITATIONS.md` finds its first line), and replace all of it with the new text.

Find:

```md
## 4. A stalled model endpoint hangs the process forever

`src/model.ts:93-104` calls `fetch` with no `signal`, no `AbortController`, and no
timeout. There is no `CHAMBER_TURN_DEADLINE_MS` or any other implemented deadline on the
model path.

**What it costs.** `chamber ask` routes through `complete()` and inherits this. A model
server that accepts the connection and then stops responding — a local LM Studio that
has wedged, a remote endpoint that black-holes the request — hangs the command
indefinitely with no output and no error. Under the scheduled job this is worse than a
crash: a hung run produces no log line at all, so the absence of a failure reads as
success. Note the inconsistency, which is a useful signal that this is an oversight
rather than a decision: MCP calls are bounded (`curl -m 30`, `src/mcp_client.ts:53-58`)
and embedding subprocesses are bounded (`src/embedder.ts:140,163`). Only the model call
is not.

**What would fix it.** An `AbortSignal.timeout` on the request plus a per-turn wall
clock. Specified in `docs/NEXT_LEVEL_PLAN.md` Phase 2A, which calls out this exact line
of code.
```

Replace with:

```md
## 4. A stalled model endpoint is abandoned after 180 seconds, and nothing bounds the whole turn

`src/model.ts` gives every model request one `AbortSignal.timeout`. The signal covers
connecting, waiting for headers and reading the body, so a server that sends a status
line and then stalls is abandoned on the same clock as one that never answers. The
default is 180 000 ms; `CHAMBER_MODEL_TIMEOUT_MS` sets it. A set value that is not a
string of digits naming 1 to 2 147 483 647 is refused with an error that names the
variable, including `0` and the empty string; it is never replaced by the default. The
ceiling is the largest value `AbortSignal.timeout` honours: a larger one fires at once.
On timeout the error reads `model endpoint <base> did not answer within <N> s
(CHAMBER_MODEL_TIMEOUT_MS)`. The MCP server's serial queue moves on to the next call.

**What it still costs.** The bound is per request. There is no wall clock across a whole
turn, which also spends time in retrieval and in the embedding subprocess (itself
bounded at 180 s in `src/embedder.ts`). A turn is therefore bounded by the sum of its
parts, not by one number. What changed is that a stalled model is now an error with a
message, where it used to be a run that never finished and wrote nothing.

**What would fix it.** A per-turn deadline that the model request, the embedder and the
retrieval all draw from. Specified in `docs/NEXT_LEVEL_PLAN.md` Phase 2A; the model
request is the part that is done.
```

List the variable in the systemd example:

<!-- apply: replace deploy/systemd/env.example -->
**Edit `deploy/systemd/env.example`.** Find this text, which appears exactly once (`grep -n -F 'CHAMBER_MODEL=stub' deploy/systemd/env.example` finds its first line), and replace all of it with the new text.

Find:

```sh
CHAMBER_MODEL=stub
# CHAMBER_MODEL=openai
# CHAMBER_API_KEY=
```

Replace with:

```sh
CHAMBER_MODEL=stub
# CHAMBER_MODEL=openai
# CHAMBER_API_KEY=
# Whole milliseconds, 1 to 2147483647. Unset means 180000. A bad value is refused.
# CHAMBER_MODEL_TIMEOUT_MS=180000
```

- [ ] **Step 6: Gates**

Run: `npm run typecheck`, `npm run lint`, `npm test`.
Expected: no errors from the first two; `npm test` ends `── 539/539 passed · 0 failed ──`.

- [ ] **Step 7: Commit**

```bash
git status --short
git add tests/harness.ts src/model.ts docs/KNOWN_LIMITATIONS.md deploy/systemd/env.example
git commit -m "fix: time out model calls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
`git status --short` must have listed exactly those four files.

- [ ] **Step 8: Mutation proof 1 (no signal on the request)**

Mutation, in `src/model.ts`. Find:

```ts
      signal,
    });
```

and replace it with:

```ts
    });
```


Run: `node --experimental-strip-types tests/harness.ts --suite=model`
Expected: `[FAIL]` for `a model endpoint that never answers is abandoned at CHAMBER_MODEL_TIMEOUT_MS` (message `still pending after 2000 ms`), `a body that stalls after the headers is bounded by the same timeout`, and `a timed-out MCP call does not wedge the calls queued behind it`; `── 2/5 passed · 3 failed ──`. The MCP test takes about 15 s to fail.
Then revert: `git checkout -- src/model.ts && git diff --exit-code` (prints nothing, exit 0).

- [ ] **Step 9: Mutation proof 2 (a bad value silently becomes the default)**

Mutation, in `src/model.ts`. Find:

```ts
  if (raw === undefined) return DEFAULT_MODEL_TIMEOUT_MS;
```

and replace it with:

```ts
  if (raw === undefined || !/^[0-9]+$/.test(raw) || Number(raw) < 1) return DEFAULT_MODEL_TIMEOUT_MS;
```


Run: `node --experimental-strip-types tests/harness.ts --suite=model`
Expected: `[FAIL] model/an unusable CHAMBER_MODEL_TIMEOUT_MS is refused by name, never replaced by the default`; `── 4/5 passed · 1 failed ──`.
Then revert: `git checkout -- src/model.ts && git diff --exit-code`.

---

### Task 2: OAuth URL check and private database files (A6, A7)

**Files:**
- Modify: `src/mcp_oauth.ts` (`requireHttps`)
- Modify: `src/db.ts`
- Modify: `tests/harness.ts`

**Interfaces:**
- Produces: `export function requireHttps(url: string, label: string): void` (now exported) in `src/mcp_oauth.ts`; `export function secureDatabaseFile(path: string, uid?: number): void` in `src/db.ts`.
- Produces, in `tests/harness.ts`: `captureStderr(fn): { value, stderr }`, `modeOf(path): number`.

- [ ] **Step 1: Write the failing tests**

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { openChamberDb } from "../src/db.ts";' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { openChamberDb } from "../src/db.ts";
```

Replace with:

```ts
import { openChamberDb, secureDatabaseFile } from "../src/db.ts";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '  formatRefreshError,' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  formatRefreshError,
} from "../src/mcp_oauth.ts";
```

Replace with:

```ts
  formatRefreshError,
  requireHttps,
} from "../src/mcp_oauth.ts";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '// ─── report ──────────────────────────────────────────────────────────────────' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
// ─── report ──────────────────────────────────────────────────────────────────
```

Replace with:

```ts
// ─── OAUTH ENDPOINTS: requireHttps parses the URL ───────────────────────────

test("oauth", "requireHttps judges the parsed host, not a prefix of the string", () => {
  // The old check was `startsWith("http://127.0.0.1")`, which accepts
  // `http://127.0.0.1.attacker.invalid/x` and `http://127.0.0.1@attacker.invalid/x`
  // (the host of that last one is attacker.invalid). It guards where a refresh
  // token and a client secret are sent.
  const saved = process.env.CHAMBER_OAUTH_ALLOW_HTTP;
  delete process.env.CHAMBER_OAUTH_ALLOW_HTTP;
  try {
    const refused = [
      "http://127.0.0.1.attacker.invalid/x",
      "http://localhost.attacker.invalid/x",
      "http://127.0.0.1@attacker.invalid/x",
      "http://example.com/x",
      "ftp://127.0.0.1/x",
      "not a url",
      "",
    ];
    for (const url of refused) {
      let message = "";
      try {
        requireHttps(url, "resource");
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assert(
        message === "resource must be HTTPS (or set CHAMBER_OAUTH_ALLOW_HTTP=1 for lab)",
        `${JSON.stringify(url)} must be refused with the existing message, got ${JSON.stringify(message)}`,
      );
    }
    const accepted = [
      "http://127.0.0.1:9/x",
      "http://localhost/x",
      "http://[::1]/x",
      "https://example.com/x",
    ];
    for (const url of accepted) requireHttps(url, "resource");
    process.env.CHAMBER_OAUTH_ALLOW_HTTP = "1";
    requireHttps("http://example.com/x", "resource"); // the lab switch keeps its meaning
  } finally {
    if (saved === undefined) delete process.env.CHAMBER_OAUTH_ALLOW_HTTP;
    else process.env.CHAMBER_OAUTH_ALLOW_HTTP = saved;
  }
});

// ─── DATABASE FILE PERMISSIONS (src/db.ts) ──────────────────────────────────

/** Run `fn` and return what it wrote to stderr, without letting it through. */
function captureStderr<T>(fn: () => T): { value: T; stderr: string } {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

/** The permission bits of `path`, e.g. 0o600. */
function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}

test("db", "an existing world-readable database is tightened to 0600 with one notice, once", () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-dbmode-"));
  try {
    const path = join(dir, "c.sqlite");
    openChamberDb(path).close();
    // A closed WAL database has no sidecar files, so make the stale ones a
    // crashed run would have left behind.
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (!existsSync(file)) writeFileSync(file, "");
      chmodSync(file, 0o644);
    }
    const first = captureStderr(() => openChamberDb(path));
    try {
      const lines = first.stderr.split("\n").filter((l) => l !== "");
      assert(lines.length === 1, `exactly one notice expected, got ${JSON.stringify(lines)}`);
      assert(
        lines[0] ===
          `chamber: tightened ${path} from 0644 to 0600 (it holds note text and tokens)`,
        `wrong notice: ${lines[0]}`,
      );
      assert(modeOf(path) === 0o600, `database is ${modeOf(path).toString(8)}, want 600`);
      for (const side of [`${path}-wal`, `${path}-shm`]) {
        assert(modeOf(side) === 0o600, `${side} is ${modeOf(side).toString(8)}, want 600`);
      }
    } finally {
      first.value.close();
    }
    const second = captureStderr(() => openChamberDb(path));
    second.value.close();
    assert(second.stderr === "", `a second open must print nothing, got ${JSON.stringify(second.stderr)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db", "a database Chamber creates is 0600 from the start, in directories made 0700", () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-dbnew-"));
  // umask 0 is what makes this a test: without an explicit mode SQLite would
  // create the file 0644 and mkdir would create 0777.
  const previousUmask = process.umask(0);
  try {
    const path = join(dir, "a", "b", "c.sqlite");
    const opened = captureStderr(() => openChamberDb(path));
    try {
      assert(opened.stderr === "", `a new database needs no notice, got ${JSON.stringify(opened.stderr)}`);
      assert(modeOf(path) === 0o600, `database is ${modeOf(path).toString(8)}, want 600`);
      for (const side of [`${path}-wal`, `${path}-shm`]) {
        if (existsSync(side)) {
          assert(modeOf(side) === 0o600, `${side} is ${modeOf(side).toString(8)}, want 600`);
        }
      }
      for (const made of [join(dir, "a"), join(dir, "a", "b")]) {
        assert(modeOf(made) === 0o700, `${made} is ${modeOf(made).toString(8)}, want 700`);
      }
    } finally {
      opened.value.close();
    }
  } finally {
    process.umask(previousUmask);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db", "a loose database owned by someone else is left alone, with a notice", () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-dbforeign-"));
  try {
    const path = join(dir, "c.sqlite");
    openChamberDb(path).close();
    chmodSync(path, 0o644);
    // Another user is simulated by passing a uid that is not ours.
    const { stderr } = captureStderr(() => secureDatabaseFile(path, process.getuid!() + 1));
    assert(modeOf(path) === 0o644, `a foreign file must not be chmod-ed, now ${modeOf(path).toString(8)}`);
    assert(/owned by another user/.test(stderr), `expected a notice, got ${JSON.stringify(stderr)}`);
    assert(stderr.split("\n").filter((l) => l !== "").length === 1, "exactly one line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db", "an in-memory database touches no file and prints nothing", () => {
  const { value, stderr } = captureStderr(() => openChamberDb(":memory:"));
  value.close();
  assert(stderr === "", `got ${JSON.stringify(stderr)}`);
});

// ─── report ──────────────────────────────────────────────────────────────────
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '  | "model"' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  | "model"
  | "all";
```

Replace with:

```ts
  | "model"
  | "db"
  | "all";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '    "model",' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    "model",
    "all",
  ].includes(v)
```

Replace with:

```ts
    "model",
    "db",
    "all",
  ].includes(v)
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=db`
Expected: `SyntaxError: The requested module '../src/db.ts' does not provide an export named 'secureDatabaseFile'`.

- [ ] **Step 3: Implement `requireHttps`**

<!-- apply: replace src/mcp_oauth.ts -->
**Edit `src/mcp_oauth.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { canSealSecrets, sealSecret, openSecret } from "./secret_box.ts";' src/mcp_oauth.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { canSealSecrets, sealSecret, openSecret } from "./secret_box.ts";
```

Replace with:

```ts
import { canSealSecrets, sealSecret, openSecret } from "./secret_box.ts";
import { isLoopbackBase } from "./config.ts";
```

<!-- apply: replace src/mcp_oauth.ts -->
**Edit `src/mcp_oauth.ts`.** Find this text, which appears exactly once (`grep -n -F 'function requireHttps(url: string, label: string): void {' src/mcp_oauth.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
function requireHttps(url: string, label: string): void {
  if (process.env.CHAMBER_OAUTH_ALLOW_HTTP === "1") return;
  if (!url.startsWith("https://") && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
    throw new Error(`${label} must be HTTPS (or set CHAMBER_OAUTH_ALLOW_HTTP=1 for lab)`);
  }
}
```

Replace with:

```ts
/**
 * Refuse to send OAuth traffic anywhere but TLS or this machine.
 *
 * This used to test the *string*: `startsWith("http://127.0.0.1")` accepts
 * `http://127.0.0.1.attacker.invalid/x` and `http://127.0.0.1@attacker.invalid/x`,
 * and a refresh token and client secret go to whatever host the URL really
 * names. The decision is now made on the parsed URL. `https:` passes; `http:`
 * passes only for the loopback hosts `isLoopbackBase` accepts; anything else,
 * including a string that does not parse, is refused with the same message.
 */
export function requireHttps(url: string, label: string): void {
  if (process.env.CHAMBER_OAUTH_ALLOW_HTTP === "1") return;
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    // Not a URL: protocol stays "" and the refusal below applies.
  }
  const ok = protocol === "https:" || (protocol === "http:" && isLoopbackBase(url));
  if (!ok) {
    throw new Error(`${label} must be HTTPS (or set CHAMBER_OAUTH_ALLOW_HTTP=1 for lab)`);
  }
}
```

- [ ] **Step 4: Implement the file permissions**

<!-- apply: replace src/db.ts -->
**Edit `src/db.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { mkdirSync, readFileSync } from "node:fs";' src/db.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { mkdirSync, readFileSync } from "node:fs";
```

Replace with:

```ts
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  type Stats,
} from "node:fs";
```

<!-- apply: replace src/db.ts -->
**Edit `src/db.ts`.** Find this text, which appears exactly once (`grep -n -F 'export function openChamberDb(' src/db.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
export function openChamberDb(
  path = ":memory:",
```

Replace with:

```ts
/** Permission bits that grant anything to the group or to others. */
const GROUP_AND_OTHER_BITS = 0o077;

function modeLabel(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

/**
 * Make sure the database file is readable by its owner alone.
 *
 * The file holds note text and OAuth tokens. SQLite creates it with the
 * process umask applied to 0644, and creates `-wal` and `-shm` with whatever
 * mode the main file has, so the only moment to get this right for a new
 * database is before SQLite opens it:
 *
 *  - Not there yet: create it empty with mode 0600 (`wx` fails if it appeared in
 *    the meantime) and let SQLite open an existing file.
 *  - There, owned by `uid`, with any group or other bit set: chmod 0600, say so
 *    once on stderr, and give an existing `-wal` and `-shm` the same treatment
 *    without further lines.
 *  - There, loose, owned by someone else: leave it alone and say so once.
 *
 * `uid` is a parameter so a test can stand in for "someone else". Windows has no
 * such bits and is skipped. A path that cannot be examined (a dangling symlink)
 * is left to SQLite, which reports it the way it always did.
 */
export function secureDatabaseFile(
  path: string,
  uid: number | undefined = process.getuid?.(),
): void {
  if (process.platform === "win32" || uid === undefined) return;
  try {
    closeSync(openSync(path, "wx", 0o600));
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  let info: Stats;
  try {
    info = statSync(path);
  } catch {
    return;
  }
  if (!info.isFile()) return;
  const loose = (info.mode & GROUP_AND_OTHER_BITS) !== 0;
  if (info.uid !== uid) {
    if (loose) {
      process.stderr.write(
        `chamber: ${path} is readable by other users (${modeLabel(info.mode)}) and ` +
          `owned by another user (uid ${info.uid}), so it was left as it is\n`,
      );
    }
    return;
  }
  if (loose) {
    try {
      chmodSync(path, 0o600);
      process.stderr.write(
        `chamber: tightened ${path} from ${modeLabel(info.mode)} to 0600 ` +
          `(it holds note text and tokens)\n`,
      );
    } catch (err) {
      process.stderr.write(
        `chamber: could not tighten ${path} from ${modeLabel(info.mode)}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  for (const suffix of ["-wal", "-shm"]) {
    const side = `${path}${suffix}`;
    try {
      const sideInfo = statSync(side);
      if (sideInfo.uid === uid && (sideInfo.mode & GROUP_AND_OTHER_BITS) !== 0) {
        chmodSync(side, 0o600);
      }
    } catch {
      // No such sidecar, or one we cannot change: the main file is what holds
      // the data and the notice above already covered it.
    }
  }
}

export function openChamberDb(
  path = ":memory:",
```

<!-- apply: replace src/db.ts -->
**Edit `src/db.ts`.** Find this text, which appears exactly once (`grep -n -F '      if (p !== ":memory:") mkdirSync(dirname(p), { recursive: true });' src/db.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
      if (p !== ":memory:") mkdirSync(dirname(p), { recursive: true });
      const db = new DatabaseSync(p);
```

Replace with:

```ts
      // Directories Chamber creates are 0700; one that already exists is not
      // changed. The file is secured before SQLite sees it (see
      // `secureDatabaseFile`), so a new database is never briefly 0644.
      if (p !== ":memory:") {
        mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
        secureDatabaseFile(p);
      }
      const db = new DatabaseSync(p);
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=db` then `node --experimental-strip-types tests/harness.ts --suite=oauth`
Expected: `db` ends `── 6/6 passed · 0 failed ──` (the four new tests and two that already existed); `oauth` ends `── 20/20 passed · 0 failed ──`.

- [ ] **Step 6: Gates**

Run: `npm run typecheck`, `npm run lint`, `npm test`.
Expected: clean; `npm test` ends `── 544/544 passed · 0 failed ──`.

- [ ] **Step 7: Commit**

```bash
git status --short
git add tests/harness.ts src/mcp_oauth.ts src/db.ts
git commit -m "fix: parse OAuth URLs and keep the database file private

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Mutation proofs**

(a) The permission call. Mutation, in `src/db.ts`. Find:

```ts
        secureDatabaseFile(p);
      }
```

and replace it with:

```ts
      }
```

Run `node --experimental-strip-types tests/harness.ts --suite=db`. Expected: `[FAIL]` for `an existing world-readable database is tightened to 0600 with one notice, once` and `a database Chamber creates is 0600 from the start, in directories made 0700`. Revert: `git checkout -- src/db.ts && git diff --exit-code`.

(b) The directory mode. Mutation, in `src/db.ts`. Find:

```ts
        mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
```

and replace it with:

```ts
        mkdirSync(dirname(p), { recursive: true });
```

Run the same command. Expected: `[FAIL]` for `a database Chamber creates is 0600 from the start, in directories made 0700` only. Revert: `git checkout -- src/db.ts && git diff --exit-code`.

(c) The prefix check. Mutation, in `src/mcp_oauth.ts`. Find:

```ts
  const ok = protocol === "https:" || (protocol === "http:" && isLoopbackBase(url));
```

and replace it with:

```ts
  const ok = protocol === "https:" || url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost");
```

Run `node --experimental-strip-types tests/harness.ts --suite=oauth`. Expected: `[FAIL] oauth/requireHttps judges the parsed host, not a prefix of the string`. Revert: `git checkout -- src/mcp_oauth.ts && git diff --exit-code`.

---

### Task 3: The HTTP server: Host, body, error, actor (A2, A3, A4, A5)

**Files:**
- Modify: `src/server.ts`
- Modify: `sql/schema_spend_approvals.sql`
- Modify: `tests/harness.ts`

**Interfaces:**
- Produces, in `tests/harness.ts` (Task 5 uses them): `startLiveServer(overrides?, setup?): Promise<LiveServer>` where `LiveServer` has `port`, `dbPath`, `stdout()`, `stderr()`, `request({method?, path, headers?, body?}): Promise<{status, headers, text, json, ms}>` and `stop()`; `freePort()`.
- Behaviour other tasks rely on: `readJson(req, res)` in `src/server.ts` returns `Record<string, unknown> | null` (null means it already answered 413 or 400).

- [ ] **Step 1: Write the failing tests**

They start the real server as a child process on a free port, with a database file in a temp directory, and talk HTTP to it.

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { isAsyncFunction } from "node:util/types";' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { isAsyncFunction } from "node:util/types";
```

Replace with:

```ts
import { isAsyncFunction } from "node:util/types";
import type { AddressInfo } from "node:net";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '// ─── report ──────────────────────────────────────────────────────────────────' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
// ─── report ──────────────────────────────────────────────────────────────────
```

Replace with:

```ts
// ─── LIVE SERVER FIXTURE (src/server.ts as a real process) ───────────────────

/** A TCP port that was free a moment ago. */
async function freePort(): Promise<number> {
  const { createServer: createNetServer } = await import("node:net");
  return new Promise<number>((ok, fail) => {
    const probe = createNetServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => ok(port));
    });
  });
}

interface LiveReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** The body parsed as JSON, or null when it is not JSON. */
  json: unknown;
  /** Milliseconds from sending the request to the end of the response. */
  ms: number;
}

interface LiveRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

interface LiveServer {
  port: number;
  dbPath: string;
  stdout: () => string;
  stderr: () => string;
  request: (req: LiveRequest) => Promise<LiveReply>;
  stop: () => Promise<void>;
}

/**
 * Start `src/server.ts` as its own process on a free port and wait for its
 * "Chamber HTTP" line.
 *
 * It is a process, not an import, because the server opens its database and
 * listens at module scope, and because these tests exist to catch what a stubbed
 * handler cannot: the event loop, the socket and the response a client really
 * sees. The database is a file in a temp directory (a worker thread cannot share
 * `:memory:`). `setup` runs before the process starts and may seed that file.
 * Config-deciding variables, any ambient token and the embedder selectors are
 * removed first, so the developer's shell cannot change what a test proves.
 */
async function startLiveServer(
  overrides: Record<string, string> = {},
  setup?: (dbPath: string) => void,
): Promise<LiveServer> {
  const { request: httpRequest } = await import("node:http");
  const dir = mkdtempSync(join(tmpdir(), "chamber-live-"));
  const dbPath = join(dir, "live.sqlite");
  setup?.(dbPath);
  const port = await freePort();
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of CONFIG_ENV_KEYS) delete env[key];
  delete env.CHAMBER_API_TOKEN;
  delete env.CHAMBER_CORS_ORIGIN;
  delete env.CHAMBER_EMBEDDER;
  delete env.CHAMBER_PYTHON;
  const child = spawn(process.execPath, ["--experimental-strip-types", SERVER_PATH], {
    env: { ...env, PORT: String(port), CHAMBER_BIND: "127.0.0.1", CHAMBER_DB: dbPath, ...overrides },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    err += d.toString();
  });
  const exited = new Promise<number | null>((ok) => child.once("exit", (code) => ok(code)));
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`server did not start within 15 s:\n${out}${err}`));
    }, 15_000);
    const poll = setInterval(() => {
      if (out.includes("Chamber HTTP")) {
        clearInterval(poll);
        clearTimeout(timer);
        ok();
      }
    }, 25);
    void exited.then((code) => {
      clearInterval(poll);
      clearTimeout(timer);
      fail(new Error(`server exited ${code} before listening:\n${out}${err}`));
    });
  });
  const request = (req: LiveRequest): Promise<LiveReply> =>
    new Promise<LiveReply>((ok, fail) => {
      const started = Date.now();
      const payload =
        req.body === undefined
          ? undefined
          : typeof req.body === "string"
            ? Buffer.from(req.body, "utf8")
            : req.body;
      const headers: Record<string, string> = { ...(req.headers ?? {}) };
      const chunked = Object.keys(headers).some((k) => k.toLowerCase() === "transfer-encoding");
      if (payload !== undefined && !chunked) headers["Content-Length"] = String(payload.length);
      const clientReq = httpRequest(
        { host: "127.0.0.1", port, method: req.method ?? "GET", path: req.path, agent: false, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(text);
            } catch {
              // Not JSON; `text` still carries it.
            }
            ok({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text,
              json: parsed,
              ms: Date.now() - started,
            });
          });
        },
      );
      clientReq.on("error", fail);
      clientReq.end(payload);
    });
  return {
    port,
    dbPath,
    stdout: () => out,
    stderr: () => err,
    request,
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ─── SERVER: Host check, body limits, 500 shape, /approve actor ─────────────

test("server", "with no token, a Host that is not loopback is refused on every path", async () => {
  const s = await startLiveServer();
  try {
    for (const [method, path] of [["GET", "/status"], ["GET", "/health"], ["OPTIONS", "/approve"], ["POST", "/turn"]] as const) {
      const r = await s.request({ method, path, headers: { Host: "attacker.example" }, body: method === "POST" ? "{}" : undefined });
      assert(r.status === 403, `${method} ${path} with a foreign Host gave ${r.status}`);
      assert(
        JSON.stringify(r.json) === '{"error":"host_not_allowed"}',
        `${method} ${path}: wrong body ${r.text}`,
      );
    }
    // A name that merely starts like a loopback one is still foreign.
    for (const host of ["127.0.0.1.attacker.example", "localhost.attacker.example:80", "127.0.0.1@attacker.example"]) {
      const r = await s.request({ path: "/status", headers: { Host: host } });
      assert(r.status === 403, `Host ${host} gave ${r.status}`);
    }
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`, "LOCALHOST"]) {
      const r = await s.request({ path: "/status", headers: { Host: host } });
      assert(r.status === 200, `Host ${host} gave ${r.status}: ${r.text}`);
    }
  } finally {
    await s.stop();
  }
});

test("server", "with a token, the Host header is not policed and the token still is", async () => {
  const s = await startLiveServer({ CHAMBER_API_TOKEN: "test-token-value" });
  try {
    const ok = await s.request({
      path: "/status",
      headers: { Host: "chamber.example.com", Authorization: "Bearer test-token-value" },
    });
    assert(ok.status === 200, `a proxied Host with a valid token gave ${ok.status}: ${ok.text}`);
    const noToken = await s.request({ path: "/status", headers: { Host: "chamber.example.com" } });
    assert(noToken.status === 401, `no token gave ${noToken.status}`);
  } finally {
    await s.stop();
  }
});

test("server", "a request body over 1 MiB is refused with 413 and the server keeps serving", async () => {
  const s = await startLiveServer();
  try {
    const two = Buffer.alloc(2 * 1024 * 1024, 97);
    const declared = await s.request({ method: "POST", path: "/turn", body: two });
    assert(declared.status === 413, `a 2 MiB Content-Length body gave ${declared.status}`);
    assert(
      JSON.stringify(declared.json) === '{"error":"payload_too_large","limit":1048576}',
      `wrong 413 body: ${declared.text}`,
    );
    assert(
      String(declared.headers.connection).toLowerCase() === "close",
      `the 413 must say Connection: close, got ${String(declared.headers.connection)}`,
    );
    const chunked = await s.request({
      method: "POST",
      path: "/turn",
      headers: { "Transfer-Encoding": "chunked" },
      body: two,
    });
    assert(chunked.status === 413, `a 2 MiB chunked body gave ${chunked.status}`);
    const after = await s.request({ path: "/health" });
    assert(after.status === 200, `the server must answer the next request, got ${after.status}`);

    // The boundary: exactly 1 MiB passes the size check, one byte more does not.
    const shell = '{"writeId":"","pad":""}';
    const atCap = Buffer.from(`{"writeId":"","pad":"${"a".repeat(1_048_576 - shell.length)}"}`);
    assert(atCap.length === 1_048_576, `setup: ${atCap.length}`);
    const exact = await s.request({ method: "POST", path: "/approve", body: atCap });
    assert(exact.status === 400 && /writeId required/.test(exact.text), `exactly 1 MiB must be read: ${exact.status} ${exact.text.slice(0, 100)}`);
    const over = await s.request({ method: "POST", path: "/approve", body: Buffer.concat([atCap, Buffer.from(" ")]) });
    assert(over.status === 413, `1 MiB + 1 byte gave ${over.status}`);
  } finally {
    await s.stop();
  }
});

test("server", "a body that is not a JSON object is a 400 invalid_json, an empty body is {}", async () => {
  const s = await startLiveServer();
  try {
    for (const body of ["{", "[]", '"text"', "5", "null", "not json"]) {
      const r = await s.request({ method: "POST", path: "/approve", body });
      assert(r.status === 400, `${JSON.stringify(body)} gave ${r.status}`);
      assert(
        JSON.stringify(r.json) === '{"error":"invalid_json"}',
        `${JSON.stringify(body)}: wrong body ${r.text}`,
      );
    }
    const empty = await s.request({ method: "POST", path: "/approve", body: "" });
    assert(
      empty.status === 400 && JSON.stringify(empty.json) === '{"error":"writeId required"}',
      `an empty body is {}, which then fails on its own terms: ${empty.status} ${empty.text}`,
    );
  } finally {
    await s.stop();
  }
});

test("server", "a handler error answers 500 internal_error with an id, and the detail goes to stderr", async () => {
  // CHAMBER_MODEL=openai makes POST /turn throw "turn unavailable" before it
  // writes anything: a real handler error through the real path.
  const s = await startLiveServer({ CHAMBER_MODEL: "openai" });
  try {
    const r = await s.request({ method: "POST", path: "/turn", body: '{"message":"hello"}' });
    assert(r.status === 500, `expected 500, got ${r.status}: ${r.text}`);
    const body = r.json as { error?: string; id?: string } | null;
    assert(body !== null && Object.keys(body).sort().join(",") === "error,id", `wrong shape: ${r.text}`);
    assert(body.error === "internal_error", `wrong error: ${r.text}`);
    assert(/^[0-9a-f]{8}$/.test(body.id ?? ""), `id must be 8 hex characters: ${r.text}`);
    assert(!/turn unavailable/.test(r.text), `no error text may reach the client: ${r.text}`);
    // stderr is a separate pipe; give it a moment to arrive.
    const deadline = Date.now() + 3000;
    while (!s.stderr().includes(`chamber server error ${body.id}:`) && Date.now() < deadline) {
      await new Promise((ok) => setTimeout(ok, 25));
    }
    assert(
      s.stderr().includes(`chamber server error ${body.id}: `) && /turn unavailable/.test(s.stderr()),
      `stderr must carry the same id and the detail:\n${s.stderr()}`,
    );
  } finally {
    await s.stop();
  }
});

test("server", "/approve and /reject record decided_by 'http' whatever actor the caller names", async () => {
  const ids: string[] = [];
  const s = await startLiveServer({}, (dbPath) => {
    const seed = openChamberDb(dbPath);
    for (const subject of ["approve-me", "reject-me"]) {
      const q = proposeWrite(seed, {
        target: "skill",
        action: "create",
        subject,
        payload: { body: "x" },
        origin: "background_review",
        reason: "test",
      });
      assert(q.status === "queued", `setup: ${JSON.stringify(q)}`);
      ids.push(q.writeId);
    }
    seed.close();
  });
  try {
    const approved = await s.request({
      method: "POST",
      path: "/approve",
      body: JSON.stringify({ writeId: ids[0], actor: "admin" }),
    });
    assert(approved.status === 200, `approve gave ${approved.status}: ${approved.text}`);
    const rejected = await s.request({
      method: "POST",
      path: "/reject",
      body: JSON.stringify({ writeId: ids[1], actor: "admin" }),
    });
    assert(rejected.status === 200, `reject gave ${rejected.status}: ${rejected.text}`);
    const check = openChamberDb(s.dbPath);
    try {
      const rows = check
        .prepare(`SELECT id, decided_by FROM pending_write WHERE id IN (?, ?) ORDER BY id`)
        .all(ids[0]!, ids[1]!) as { id: string; decided_by: string }[];
      assert(rows.length === 2, `setup: expected both rows, got ${rows.length}`);
      for (const row of rows) {
        assert(row.decided_by === "http", `${row.id} was decided by ${row.decided_by}, want http`);
      }
    } finally {
      check.close();
    }
  } finally {
    await s.stop();
  }
});

// ─── report ──────────────────────────────────────────────────────────────────
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '  | "db"' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  | "db"
  | "all";
```

Replace with:

```ts
  | "db"
  | "server"
  | "all";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '    "db",' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    "db",
    "all",
  ].includes(v)
```

Replace with:

```ts
    "db",
    "server",
    "all",
  ].includes(v)
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=server`
Expected: five `[FAIL]` (the Host test, the 1 MiB test, the invalid-JSON test, the 500 test, the decided_by test) and `[PASS]` for `with a token, the Host header is not policed and the token still is` and the six older server tests; `── 7/12 passed · 5 failed ──`. The 500 test's failure shows the old behaviour: a body containing `"error": "Error: turn unavailable: ...`.

- [ ] **Step 3: Implement**

The import, then the Host check and its constant (above `assertBindIsSafe`):

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { createServer, type IncomingMessage, type ServerResponse } from "node:http";' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
```

Replace with:

```ts
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
```

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F '/**' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
/**
 * Refuse to serve an unauthenticated port to a network.
```

Replace with:

```ts
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
```

The body reader. `readBody` and `readJson` are replaced, and `refuseBody` is new:

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F 'function readBody(req: IncomingMessage): Promise<string> {' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
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
```

Replace with:

```ts
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
```

The check runs first in the handler:

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F 'const server = createServer(async (req, res) => {' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
```

Replace with:

```ts
const server = createServer(async (req, res) => {
  try {
    // First, before CORS headers, the OPTIONS branch, the Origin check and auth,
    // and for every path including /health: see `hostAllowed`.
    if (!hostAllowed(req)) {
      json(res, 403, { error: "host_not_allowed" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
```

Every `readJson` call passes `res` and stops when it returns null:

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F '    if (method === "POST" && path === "/turn") {' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    if (method === "POST" && path === "/turn") {
      const body = await readJson(req);
      const message = String(body.message ?? body.text ?? "").trim();
```

Replace with:

```ts
    if (method === "POST" && path === "/turn") {
      const body = await readJson(req, res);
      if (body === null) return;
      const message = String(body.message ?? body.text ?? "").trim();
```

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F '    if (method === "POST" && path === "/approve") {' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
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
```

Replace with:

```ts
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
```

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F '    if (method === "POST" && path === "/reject") {' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
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
```

Replace with:

```ts
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
```

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F '    if (method === "POST" && path === "/deliberate") {' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    if (method === "POST" && path === "/deliberate") {
      const body = await readJson(req);
      const kind = String(body.kind ?? "other") as
```

Replace with:

```ts
    if (method === "POST" && path === "/deliberate") {
      const body = await readJson(req, res);
      if (body === null) return;
      const kind = String(body.kind ?? "other") as
```

The 500 response:

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F '  } catch (err) {' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});
```

Replace with:

```ts
  } catch (err) {
    // The client learns that something failed and a number to quote; the cause
    // goes to stderr beside the same number. `String(err)` used to be the body,
    // which sent paths, SQL and module names to whoever asked.
    const id = randomUUID().slice(0, 8);
    process.stderr.write(
      `chamber server error ${id}: ${formatErrorChain(err).join("; ")}\n` +
        `${err instanceof Error && err.stack ? err.stack : ""}\n`,
    );
    if (res.headersSent) {
      res.end();
    } else {
      json(res, 500, { error: "internal_error", id });
    }
  }
});
```

The route comment, and the schema comment for `decided_by`:

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F ' *   POST /approve       { "writeId": "..." }' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
 *   POST /approve       { "writeId": "..." }
 *   POST /reject        { "writeId": "...", "note": "..." }
```

Replace with:

```ts
 *   POST /approve       { "writeId": "..." }   (decided_by is always "http")
 *   POST /reject        { "writeId": "...", "note": "..." }
```

<!-- apply: replace sql/schema_spend_approvals.sql -->
**Edit `sql/schema_spend_approvals.sql`.** Find this text, which appears exactly once (`grep -n -F '  decided_by        TEXT,                  -- human | auto_policy' sql/schema_spend_approvals.sql` finds its first line), and replace all of it with the new text.

Find:

```sql
  decided_by        TEXT,                  -- human | auto_policy
```

Replace with:

```sql
  decided_by        TEXT,                  -- human (CLI) | auto_policy | system (TTL expiry) | http | slack:<id> | discord:<id>
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=server`
Expected: all twelve `[PASS]`; `── 12/12 passed · 0 failed ──`.

- [ ] **Step 5: Gates**

Run: `npm run typecheck`, `npm run lint`, `npm test`.
Expected: clean; `npm test` ends `── 550/550 passed · 0 failed ──`.

- [ ] **Step 6: Commit**

```bash
git status --short
git add tests/harness.ts src/server.ts sql/schema_spend_approvals.sql
git commit -m "fix: harden the HTTP server's host, body, error and actor handling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Mutation proofs**

For each, apply the change, run `node --experimental-strip-types tests/harness.ts --suite=server`, check the one expected failure and the tally `── 11/12 passed · 1 failed ──`, then revert with `git checkout -- src/server.ts && git diff --exit-code`.

(a) Host check off. Mutation, in `src/server.ts`. Find:

```ts
  if (API_TOKEN) return true;
  const header = req.headers.host;
```

and replace it with:

```ts
  return true;
  const header = req.headers.host;
```

Expected failure: `server/with no token, a Host that is not loopback is refused on every path`.

(b) Actor taken from the body. Mutation, in `src/server.ts`. Find:

```ts
        decision: "approved",
        decidedBy: "http",
```

and replace it with:

```ts
        decision: "approved",
        decidedBy: String(body.actor ?? "human"),
```

Expected: `server//approve and /reject record decided_by 'http' whatever actor the caller names`.

(c) Cap raised to 64 MiB. Mutation, in `src/server.ts`. Find:

```ts
const MAX_BODY_BYTES = 1_048_576;
```

and replace it with:

```ts
const MAX_BODY_BYTES = 1_048_576 * 64;
```

Expected: `server/a request body over 1 MiB is refused with 413 and the server keeps serving`.

(d) Error text back in the body. Mutation, in `src/server.ts`. Find:

```ts
      json(res, 500, { error: "internal_error", id });
```

and replace it with:

```ts
      json(res, 500, { error: String(err) });
```

Expected: `server/a handler error answers 500 internal_error with an id, and the detail goes to stderr`.

(e) Arrays accepted as bodies. Mutation, in `src/server.ts`. Find:

```ts
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
```

and replace it with:

```ts
  if (typeof parsed !== "object" || parsed === null) {
```

Expected: `server/a body that is not a JSON object is a 400 invalid_json, an empty body is {}`.

---

### Task 4: No secret on a curl command line (A8)

**Files:**
- Create: `src/http_sync.ts`
- Modify: `src/mcp_client.ts`, `src/mcp_oauth.ts`, `src/slack_ops.ts`, `src/discord_ops.ts`, `src/gateway.ts`, `src/gateway_runner.ts`
- Modify: `tests/harness.ts`

**Interfaces:**
- Consumes: `withEnvAsync` (Task 1), `freshDb`, `spawn` (already in the harness).
- Produces: in `src/http_sync.ts`: `CURL_FIXED_ARGV`, `quoteCurlConfigValue(value)`, `buildCurlInvocation(req): { argv, config }`, `httpSync(req): { status, body, exitStatus, stderr }`, and the types `HttpSyncRequest`, `HttpSyncResult`.
- Produces, in `tests/harness.ts` (Task 5 uses them): `writeCurlShim(dir)`, `shimCalls(dir)`.
- `DiscordGateway` and `SlackGateway` in `src/gateway_runner.ts` become exported classes (the test calls them).

- [ ] **Step 1: Write the failing tests**

Imports first:

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { openChamberDb, secureDatabaseFile } from "../src/db.ts";' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { openChamberDb, secureDatabaseFile } from "../src/db.ts";
```

Replace with:

```ts
import { openChamberDb, secureDatabaseFile } from "../src/db.ts";
import { CURL_FIXED_ARGV, buildCurlInvocation, httpSync } from "../src/http_sync.ts";
import { mcpDiscover } from "../src/mcp_client.ts";
import { TelegramGateway } from "../src/gateway.ts";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '  formatRefreshError,' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  formatRefreshError,
  requireHttps,
} from "../src/mcp_oauth.ts";
```

Replace with:

```ts
  formatRefreshError,
  requireHttps,
  exchangeAuthorizationCode,
  fetchProtectedResourceMetadata,
} from "../src/mcp_oauth.ts";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '  slackScopeId,' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  slackScopeId,
  openSlackDb,
} from "../src/slack_ops.ts";
```

Replace with:

```ts
  slackScopeId,
  openSlackDb,
  postPendingWriteToOps,
} from "../src/slack_ops.ts";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '  chunkDiscordMessage,' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  chunkDiscordMessage,
  openDiscordDb,
} from "../src/discord_ops.ts";
// Importing this module must not start a gateway; see `invokedDirectly` there.
import { openGatewayDb } from "../src/gateway_runner.ts";
```

Replace with:

```ts
  chunkDiscordMessage,
  openDiscordDb,
  postPendingWriteToDiscordOps,
} from "../src/discord_ops.ts";
// Importing this module must not start a gateway; see `invokedDirectly` there.
import { openGatewayDb, DiscordGateway, SlackGateway } from "../src/gateway_runner.ts";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '  mkdtempSync,' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  mkdtempSync,
  readFileSync,
  realpathSync,
```

Replace with:

```ts
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
```

Then the tests. Four of them: every secret-carrying site keeps its secret off argv (a `curl` shim first on `PATH` records argv and stdin); refusals happen before curl runs; the escaping rules; and a real receiver in its own process gets the header and body byte for byte, including a 1.4 MB body and the timeout.

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '// ─── report ──────────────────────────────────────────────────────────────────' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
// ─── report ──────────────────────────────────────────────────────────────────
```

Replace with:

```ts
// ─── NO SECRET ON A COMMAND LINE (src/http_sync.ts) ─────────────────────────

/**
 * Write a `curl` into `dir` that records how it was invoked and answers `{}`
 * with status 200. It writes one `argv.<pid>` file (one argument per line) and
 * one `stdin.<pid>` file per call into `$CHAMBER_SHIM_DIR`, which `shimCalls`
 * reads back. `withCurlShim` also puts `dir` first on this process's PATH.
 */
function writeCurlShim(dir: string): void {
  writeFileSync(
    join(dir, "curl"),
    `#!/bin/sh\n` +
      `printf '%s\\n' "$@" > "$CHAMBER_SHIM_DIR/argv.$$"\n` +
      `cat > "$CHAMBER_SHIM_DIR/stdin.$$"\n` +
      `printf '{}\\n200'\n`,
    { mode: 0o755 },
  );
}

async function withCurlShim<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chamber-curlshim-"));
  writeCurlShim(dir);
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${dir}:${savedPath ?? ""}`;
    return await withEnvAsync({ CHAMBER_SHIM_DIR: dir }, () => fn(dir));
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function shimCalls(dir: string): { argv: string[]; stdin: string }[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith("argv."))
    .sort()
    .map((f) => ({
      argv: readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l !== ""),
      stdin: readFileSync(join(dir, f.replace("argv.", "stdin.")), "utf8"),
    }));
}

test("http_sync", "every site that carries a secret keeps it off the curl command line", async () => {
  const secret = {
    slack: "SHIMSECRET-slack",
    discord: "SHIMSECRET-discord",
    telegram: "SHIMSECRET-telegram",
    mcp: "SHIMSECRET-mcp",
    code: "SHIMSECRET-code",
    verifier: "SHIMSECRET-verifier",
    client: "SHIMSECRET-client",
  };
  await withCurlShim(async (dir) => {
    const event = { writeId: "pw_shim", target: "skill", action: "create", subject: "s", origin: "cron" };
    await withEnvAsync(
      {
        SLACK_BOT_TOKEN: secret.slack,
        CHAMBER_SLACK_OPS_CHANNEL: "C0OPS",
        DISCORD_BOT_TOKEN: secret.discord,
        CHAMBER_DISCORD_OPS_CHANNEL: "1234",
        CHAMBER_MCP_ACCESS_TOKEN: secret.mcp,
      },
      async () => {
        postPendingWriteToOps(event);
        postPendingWriteToDiscordOps(event);
        await new TelegramGateway(secret.telegram).send({ channel: "telegram", chatId: "42", text: 'say "hi"' });
        await new DiscordGateway(secret.discord).send({ channel: "discord", chatId: "1234", text: "hi" });
        await new SlackGateway(secret.slack).send({ channel: "slack", chatId: "C1", text: "hi" });
        try {
          mcpDiscover("http://127.0.0.1:9/mcp"); // the shim's {} is not a discover reply; only the call matters
        } catch {
          // expected
        }
        const db = freshDb();
        try {
          exchangeAuthorizationCode(db, {
            tokenEndpoint: "http://127.0.0.1:9/token",
            clientId: "client-id",
            clientSecret: secret.client,
            code: secret.code,
            redirectUri: "http://127.0.0.1:8765/callback",
            codeVerifier: secret.verifier,
            resource: "http://127.0.0.1:9/mcp",
            issuer: "http://127.0.0.1:9",
          });
        } catch {
          // expected: the shim's {} carries no access_token
        }
        try {
          fetchProtectedResourceMetadata(db, "http://127.0.0.1:9/mcp");
        } catch {
          // expected: the shim's {} names no authorization server
        }
      },
    );
    const calls = shimCalls(dir);
    assert(calls.length >= 9, `expected a call from every site, saw ${calls.length}`);
    for (const call of calls) {
      assert(
        call.argv.length === CURL_FIXED_ARGV.length && call.argv.every((a, i) => a === CURL_FIXED_ARGV[i]),
        `argv must be exactly the fixed flags, got ${JSON.stringify(call.argv)}`,
      );
    }
    const argvText = calls.map((c) => c.argv.join("\n")).join("\n");
    const stdinText = calls.map((c) => c.stdin).join("\n");
    for (const [site, value] of Object.entries(secret)) {
      assert(!argvText.includes(value), `${site}: the secret is on the command line`);
      assert(stdinText.includes(value), `${site}: no call carried this secret on stdin, so the site never ran`);
    }
  });
});

test("http_sync", "a line break, a NUL, a bad scheme or a bad header name is refused before curl runs", async () => {
  await withCurlShim(async (dir) => {
    const base = { url: "http://127.0.0.1:9/x", timeoutSec: 5 };
    const cases: [string, Parameters<typeof httpSync>[0]][] = [
      ["CRLF in a header value", { ...base, headers: { "X-A": "b\r\nX-Injected: yes" } }],
      ["LF in a header value", { ...base, headers: { "X-A": "b\nc" } }],
      ["CR in a header name", { ...base, headers: { "X-A\r": "b" } }],
      ["LF in the URL", { ...base, url: "http://127.0.0.1:9/x\nHost: other" }],
      ["NUL in the body", { ...base, method: "POST", body: "a\0b" }],
      ["NUL in a header value", { ...base, headers: { "X-A": "a\0b" } }],
      ["a header name that is not a token", { ...base, headers: { "Bad Name": "b" } }],
      ["a header name with a colon", { ...base, headers: { "X:A": "b" } }],
      ["a file: URL", { ...base, url: "file:///etc/hostname" }],
      ["no timeout", { ...base, timeoutSec: 0 }],
      ["a body on a GET", { ...base, method: "GET", body: "x" }],
    ];
    for (const [label, req] of cases) {
      let message = "";
      try {
        httpSync(req);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assert(message.startsWith("http_sync:"), `${label}: expected a refusal, got ${JSON.stringify(message)}`);
    }
    // The refusal never repeats the value it refused.
    let leaked = "";
    try {
      httpSync({ ...base, headers: { Authorization: "Bearer SHIMSECRET-leak\r\nX: y" } });
    } catch (err) {
      leaked = err instanceof Error ? err.message : String(err);
    }
    assert(leaked !== "" && !leaked.includes("SHIMSECRET-leak"), `the error must not echo the value: ${leaked}`);
    assert(shimCalls(dir).length === 0, "a refused request must not start curl");
  });
});

test("http_sync", "values are double-quoted with backslash, quote, LF, CR and TAB escaped", () => {
  const { argv, config } = buildCurlInvocation({
    url: "https://example.com/a?b=c",
    method: "POST",
    headers: { "X-Test": 'a"b\\c\td' },
    body: 'x"y\\z\r\nq',
    timeoutSec: 12,
    followRedirects: true,
  });
  assert(JSON.stringify(argv) === '["-s","-K","-"]', `argv: ${JSON.stringify(argv)}`);
  const expected = [
    'url = "https://example.com/a?b=c"',
    "globoff",
    'max-time = "12"',
    'write-out = "\\n%{http_code}"',
    "location",
    'request = "POST"',
    'header = "X-Test: a\\"b\\\\c\\td"',
    'data-raw = "x\\"y\\\\z\\r\\nq"',
    "",
  ].join("\n");
  assert(config === expected, `config was:\n${config}\nwant:\n${expected}`);
});

/** A receiver in its own process, so the test can block on curl without blocking the receiver. */
const HTTP_RECEIVER = `
const http = require("node:http");
const fs = require("node:fs");
const out = process.argv[1];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    if (req.url.startsWith("/hang")) {
      // Never answers. It hangs up after 8 s so that a curl with no timeout
      // fails the test below instead of hanging the suite.
      setTimeout(() => req.socket.destroy(), 8000);
      return;
    }
    fs.appendFileSync(out, JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("base64"),
    }) + "\\n");
    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
  });
});
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
`;

test("http_sync", "a header and a body with quotes, backslashes, newlines and non-ASCII arrive byte for byte", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-httpsync-"));
  const outFile = join(dir, "received.jsonl");
  const receiver = spawn(process.execPath, ["-e", HTTP_RECEIVER, outFile]);
  try {
    const port = await new Promise<number>((ok, fail) => {
      let seen = "";
      const timer = setTimeout(() => fail(new Error("receiver did not start")), 10_000);
      receiver.stdout.on("data", (d: Buffer) => {
        seen += d.toString();
        const m = /PORT (\d+)/.exec(seen);
        if (m) {
          clearTimeout(timer);
          ok(Number(m[1]));
        }
      });
    });
    const sent =
      'He said "hi" \\ back\nline2\r\nline3\ttab é 漢字 😀 @/etc/hostname %{http_code} $HOME `x` ';
    const authorization = 'Bearer tok"en\\x';
    const r = httpSync({
      url: `http://127.0.0.1:${port}/echo?x=[1]&y={a}`,
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: sent,
      timeoutSec: 10,
    });
    assert(r.status === 201 && r.body === '{"ok":true}', `reply: ${r.status} ${JSON.stringify(r.body)}`);
    const big = "x\n\"\\é".repeat(200_000); // about 1.4 MB
    const r2 = httpSync({
      url: `http://127.0.0.1:${port}/big`,
      method: "POST",
      body: big,
      timeoutSec: 20,
    });
    assert(r2.status === 201, `a large body gave ${r2.status}`);
    const lines = readFileSync(outFile, "utf8").trim().split("\n");
    assert(lines.length === 2, `expected two requests, got ${lines.length}`);
    const first = JSON.parse(lines[0]!) as { method: string; url: string; headers: Record<string, string>; body: string };
    assert(first.method === "POST", `method: ${first.method}`);
    assert(first.url === "/echo?x=[1]&y={a}", `URL: ${first.url}`);
    assert(first.headers.authorization === authorization, `Authorization: ${first.headers.authorization}`);
    assert(Buffer.from(first.body, "base64").equals(Buffer.from(sent, "utf8")), "the body changed on the way");
    const second = JSON.parse(lines[1]!) as { body: string };
    assert(Buffer.from(second.body, "base64").equals(Buffer.from(big, "utf8")), "the large body changed on the way");

    // The timeout lives in the config now, so prove curl still honours it.
    const started = Date.now();
    const hung = httpSync({ url: `http://127.0.0.1:${port}/hang`, timeoutSec: 1 });
    assert(hung.status === 0 && hung.exitStatus === 28, `a silent server: status ${hung.status}, curl exit ${hung.exitStatus}`);
    assert(Date.now() - started < 5000, `the timeout took ${Date.now() - started} ms`);
  } finally {
    receiver.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── report ──────────────────────────────────────────────────────────────────
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '  | "server"' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  | "server"
  | "all";
```

Replace with:

```ts
  | "server"
  | "http_sync"
  | "all";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '    "server",' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    "server",
    "all",
  ].includes(v)
```

Replace with:

```ts
    "server",
    "http_sync",
    "all",
  ].includes(v)
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=http_sync`
Expected: the harness does not start: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/http_sync.ts'`.

- [ ] **Step 3: Create the helper**

<!-- apply: create src/http_sync.ts -->
**Create `src/http_sync.ts`** with exactly this content:

```ts
/**
 * Synchronous HTTP through curl, with nothing secret on the command line.
 *
 * Every call here used to put its URL, its `Authorization` header and its body
 * into curl's argv. argv is world-readable for as long as the process lives
 * (`ps`, `/proc/<pid>/cmdline`), and agent hosts record the commands they run:
 * a bot token, a refresh token, an OAuth client secret and a Telegram token (it
 * is in the URL path) were all one `ps` away.
 *
 * So the argv is a constant, `CURL_FIXED_ARGV`, and everything that varies goes
 * to curl as a config file on stdin (`-K -`): the URL, the timeout, the headers
 * and the body. Verified with a local server that a header and a body holding
 * a double quote, a backslash, a newline, a carriage return, a tab, non-ASCII
 * text, a leading `@`, `%{http_code}` and `$HOME` arrive unchanged, 3 MB of it
 * included.
 *
 * Three details of curl's config format matter and are deliberate:
 *  - the body is `data-raw`, never `data`: a `data` value starting with `@`
 *    makes curl read that file and send its contents;
 *  - `globoff` turns off URL globbing, so `[::1]`, `[1]` and `{a}` in a URL are
 *    literal rather than a range or a set;
 *  - the status line is printed after the body by `write-out`, as it was by the
 *    `-w` this replaces.
 *
 * Values are double-quoted. Inside the quotes `\` becomes `\\`, `"` becomes
 * `\"`, LF `\n`, CR `\r` and TAB `\t`; nothing else is special. A NUL anywhere is
 * refused. A CR or LF in the URL, a header name or a header value is refused
 * rather than escaped: it could only be an attempt to add a header or to split
 * the config, and escaping would hide that. Header names must be HTTP tokens and
 * the URL must be http or https, so the set of things this can be asked to do is
 * closed rather than filtered.
 *
 * Errors name what was refused and never repeat the value.
 */

import { spawnSync } from "node:child_process";

/** The whole argv. Silent mode, then the config on stdin. Nothing else is ever passed. */
export const CURL_FIXED_ARGV: readonly string[] = ["-s", "-K", "-"];

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface HttpSyncRequest {
  url: string;
  /** Defaults to POST when there is a body, GET otherwise. */
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Sent exactly as written. Never interpreted by curl. */
  body?: string;
  /** Whole or fractional seconds for the entire transfer. Required: nothing here may wait forever. */
  timeoutSec: number;
  followRedirects?: boolean;
  /** Largest reply kept, in bytes. Default 8 MiB. */
  maxBytes?: number;
}

export interface HttpSyncResult {
  /** The HTTP status, or 0 when curl got no reply. */
  status: number;
  /** The reply body, without the status line `write-out` adds. */
  body: string;
  /** curl's exit code, or null if it could not be started or was killed. 28 means the timeout hit. */
  exitStatus: number | null;
  stderr: string;
}

function refuse(what: string): never {
  throw new Error(`http_sync: ${what}`);
}

function checkText(value: string, label: string, allowLineBreaks: boolean): void {
  if (value.includes("\0")) refuse(`${label} contains a NUL byte`);
  if (!allowLineBreaks && /[\r\n]/.test(value)) refuse(`${label} contains a line break`);
}

/** `value` as one double-quoted curl config string. */
export function quoteCurlConfigValue(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * The argv and the stdin config for `req`, or a thrown refusal. Pure: nothing is
 * spawned, so a test can inspect exactly what curl would be given.
 */
export function buildCurlInvocation(req: HttpSyncRequest): { argv: string[]; config: string } {
  checkText(req.url, "the URL", false);
  if (!/^https?:\/\//i.test(req.url)) refuse("the URL must start with http:// or https://");
  if (!Number.isFinite(req.timeoutSec) || req.timeoutSec <= 0) {
    refuse("timeoutSec must be a positive number of seconds");
  }
  const method = req.method ?? (req.body === undefined ? "GET" : "POST");
  if (method === "GET" && req.body !== undefined) refuse("a GET request cannot carry a body");

  const lines = [
    `url = ${quoteCurlConfigValue(req.url)}`,
    "globoff",
    `max-time = ${quoteCurlConfigValue(String(req.timeoutSec))}`,
    `write-out = ${quoteCurlConfigValue("\n%{http_code}")}`,
  ];
  if (req.followRedirects) lines.push("location");
  if (method === "POST") lines.push(`request = ${quoteCurlConfigValue("POST")}`);
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (!HEADER_NAME.test(name)) refuse("a header name is not an HTTP token");
    checkText(value, `the value of header ${name}`, false);
    lines.push(`header = ${quoteCurlConfigValue(`${name}: ${value}`)}`);
  }
  if (req.body !== undefined) {
    checkText(req.body, "the body", true);
    lines.push(`data-raw = ${quoteCurlConfigValue(req.body)}`);
  }
  return { argv: [...CURL_FIXED_ARGV], config: `${lines.join("\n")}\n` };
}

/** Run `req` through curl and wait for it. Throws only for a refused request. */
export function httpSync(req: HttpSyncRequest): HttpSyncResult {
  const { argv, config } = buildCurlInvocation(req);
  const r = spawnSync("curl", argv, {
    input: config,
    encoding: "utf-8",
    maxBuffer: req.maxBytes ?? DEFAULT_MAX_BYTES,
  });
  const out = r.stdout ?? "";
  const nl = out.lastIndexOf("\n");
  return {
    status: Number(out.slice(nl + 1)) || 0,
    body: nl >= 0 ? out.slice(0, nl) : out,
    exitStatus: r.status,
    stderr: r.stderr ?? "",
  };
}
```

- [ ] **Step 4: Move every site onto it**

`src/mcp_client.ts` (Bearer token, 30 s):

<!-- apply: replace src/mcp_client.ts -->
**Edit `src/mcp_client.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { spawnSync } from "node:child_process";' src/mcp_client.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "./audit.ts";
import { newId } from "./hash.ts";
```

Replace with:

```ts
import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "./audit.ts";
import { newId } from "./hash.ts";
import { httpSync } from "./http_sync.ts";
```

<!-- apply: replace src/mcp_client.ts -->
**Edit `src/mcp_client.ts`.** Find this text, which appears exactly once (`grep -n -F '  const headerArgs: string[] = [];' src/mcp_client.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  const headerArgs: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    headerArgs.push("-H", `${k}: ${v}`);
  }
  const r = spawnSync(
    "curl",
    [
      "-s",
      "-m",
      "30",
      "-w",
      "\n%{http_code}",
      "-X",
      "POST",
      url,
      ...headerArgs,
      "-H",
      "Content-Type: application/json",
      "-H",
      `MCP-Protocol-Version: ${MCP_PROTOCOL_VERSION}`,
      "-d",
      JSON.stringify(body),
    ],
    { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
  );
  const out = r.stdout || "";
  const nl = out.lastIndexOf("\n");
  const status = Number(out.slice(nl + 1)) || 0;
  const bodyText = nl >= 0 ? out.slice(0, nl) : out;
  return { status, body: bodyText };
}
```

Replace with:

```ts
  const r = httpSync({
    url,
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify(body),
    timeoutSec: 30,
    maxBytes: 8 * 1024 * 1024,
  });
  return { status: r.status, body: r.body };
}
```

`src/mcp_oauth.ts` (`httpGet`, `httpPostForm`: refresh token, client secret, auth code, code verifier). `spawnSync` stays imported there; two other functions use it:

<!-- apply: replace src/mcp_oauth.ts -->
**Edit `src/mcp_oauth.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { isLoopbackBase } from "./config.ts";' src/mcp_oauth.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { isLoopbackBase } from "./config.ts";
```

Replace with:

```ts
import { isLoopbackBase } from "./config.ts";
import { httpSync } from "./http_sync.ts";
```

<!-- apply: replace src/mcp_oauth.ts -->
**Edit `src/mcp_oauth.ts`.** Find this text, which appears exactly once (`grep -n -F 'function httpGet(url: string): { status: number; body: string } {' src/mcp_oauth.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
function httpGet(url: string): { status: number; body: string } {
  const r = spawnSync(
    "curl",
    ["-s", "-m", "15", "-w", "\n%{http_code}", "-L", url],
    { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
  );
  const out = r.stdout || "";
  const nl = out.lastIndexOf("\n");
  const status = Number(out.slice(nl + 1)) || 0;
  const body = nl >= 0 ? out.slice(0, nl) : out;
  return { status, body };
}
```

Replace with:

```ts
function httpGet(url: string): { status: number; body: string } {
  const r = httpSync({
    url,
    timeoutSec: 15,
    followRedirects: true,
    maxBytes: 2 * 1024 * 1024,
  });
  return { status: r.status, body: r.body };
}
```

<!-- apply: replace src/mcp_oauth.ts -->
**Edit `src/mcp_oauth.ts`.** Find this text, which appears exactly once (`grep -n -F '  const r = spawnSync(' src/mcp_oauth.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  const r = spawnSync(
    "curl",
    [
      "-s",
      "-m",
      "20",
      "-w",
      "\n%{http_code}",
      "-X",
      "POST",
      url,
      "-H",
      "Content-Type: application/x-www-form-urlencoded",
      "-d",
      data,
    ],
    { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
  );
  const out = r.stdout || "";
  const nl = out.lastIndexOf("\n");
  const status = Number(out.slice(nl + 1)) || 0;
  const body = nl >= 0 ? out.slice(0, nl) : out;
  return { status, body };
}
```

Replace with:

```ts
  const r = httpSync({
    url,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: data,
    timeoutSec: 20,
    maxBytes: 2 * 1024 * 1024,
  });
  return { status: r.status, body: r.body };
}
```

`src/slack_ops.ts` (bot token):

<!-- apply: replace src/slack_ops.ts -->
**Edit `src/slack_ops.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { spawnSync } from "node:child_process";' src/slack_ops.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { openConfiguredDb } from "./db.ts";
```

Replace with:

```ts
import type { DatabaseSync } from "node:sqlite";
import { openConfiguredDb } from "./db.ts";
import { httpSync } from "./http_sync.ts";
```

<!-- apply: replace src/slack_ops.ts -->
**Edit `src/slack_ops.ts`.** Find this text, which appears exactly once (`grep -n -F '  const r = spawnSync(' src/slack_ops.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  const r = spawnSync(
    "curl",
    [
      "-s",
      "-m",
      "10",
      "-X",
      "POST",
      "https://slack.com/api/chat.postMessage",
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
    ],
    { encoding: "utf-8", maxBuffer: 1_000_000 },
  );
  const body = r.stdout || "";
  try {
```

Replace with:

```ts
  const r = httpSync({
    url: "https://slack.com/api/chat.postMessage",
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: payload,
    timeoutSec: 10,
    maxBytes: 1_000_000,
  });
  const body = r.body;
  try {
```

`src/discord_ops.ts` (bot token):

<!-- apply: replace src/discord_ops.ts -->
**Edit `src/discord_ops.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { spawnSync } from "node:child_process";' src/discord_ops.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { openConfiguredDb } from "./db.ts";
```

Replace with:

```ts
import type { DatabaseSync } from "node:sqlite";
import { openConfiguredDb } from "./db.ts";
import { httpSync } from "./http_sync.ts";
```

<!-- apply: replace src/discord_ops.ts -->
**Edit `src/discord_ops.ts`.** Find this text, which appears exactly once (`grep -n -F '  const r = spawnSync(' src/discord_ops.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  const r = spawnSync(
    "curl",
    [
      "-s",
      "-m",
      "10",
      "-X",
      "POST",
      `https://discord.com/api/v10/channels/${channel}/messages`,
      "-H",
      `Authorization: Bot ${token}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
    ],
    { encoding: "utf-8", maxBuffer: 1_000_000 },
  );
  try {
    const j = JSON.parse(r.stdout || "{}") as { id?: string; message?: string };
```

Replace with:

```ts
  const r = httpSync({
    url: `https://discord.com/api/v10/channels/${channel}/messages`,
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: payload,
    timeoutSec: 10,
    maxBytes: 1_000_000,
  });
  try {
    const j = JSON.parse(r.body || "{}") as { id?: string; message?: string };
```

`src/gateway.ts` (the Telegram token is in the URL):

<!-- apply: replace src/gateway.ts -->
**Edit `src/gateway.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { spawnSync } from "node:child_process";' src/gateway.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { spawnSync } from "node:child_process";

export type GatewayChannel =
```

Replace with:

```ts
import { httpSync } from "./http_sync.ts";

export type GatewayChannel =
```

<!-- apply: replace src/gateway.ts -->
**Edit `src/gateway.ts`.** Find this text, which appears exactly once (`grep -n -F '    const url = `https://api.telegram.org/bot${this.token}/${method}`;' src/gateway.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const res = spawnSync(
      "curl",
      [
        "-s",
        "-m",
        "35",
        "-X",
        "POST",
        url,
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify(body ?? {}),
      ],
      { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 },
    );
    if (res.status !== 0) {
      throw new Error(String(res.stderr || "telegram api failed"));
    }
    return JSON.parse(res.stdout || "{}");
  }
```

Replace with:

```ts
    // The bot token is part of the URL path, which is why this goes through
    // `httpSync`: the URL is on curl's stdin, not on its command line.
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const res = httpSync({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      timeoutSec: 35,
      maxBytes: 4 * 1024 * 1024,
    });
    if (res.exitStatus !== 0) {
      throw new Error(String(res.stderr || "telegram api failed"));
    }
    return JSON.parse(res.body || "{}");
  }
```

`src/gateway_runner.ts`, both calls, which had no timeout and now have 30 s. The classes are exported so the test can call them:

<!-- apply: replace src/gateway_runner.ts -->
**Edit `src/gateway_runner.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { sha256, newId } from "./hash.ts";' src/gateway_runner.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { sha256, newId } from "./hash.ts";
import { spawnSync } from "node:child_process";

class DiscordGateway implements GatewayAdapter {
```

Replace with:

```ts
import { sha256, newId } from "./hash.ts";
import { httpSync } from "./http_sync.ts";

export class DiscordGateway implements GatewayAdapter {
```

<!-- apply: replace src/gateway_runner.ts -->
**Edit `src/gateway_runner.ts`.** Find this text, which appears exactly once (`grep -n -F '    if (!this.token) return;' src/gateway_runner.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    if (!this.token) return;
    spawnSync(
      "curl",
      [
        "-s",
        "-X",
        "POST",
        `https://discord.com/api/v10/channels/${msg.chatId}/messages`,
        "-H",
        `Authorization: Bot ${this.token}`,
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify({ content: msg.text.slice(0, 1900) }),
      ],
      { encoding: "utf-8" },
    );
  }
}

class SlackGateway implements GatewayAdapter {
```

Replace with:

```ts
    if (!this.token) return;
    // This call had no timeout at all; a stalled Discord would have held the
    // runner's only thread indefinitely.
    httpSync({
      url: `https://discord.com/api/v10/channels/${msg.chatId}/messages`,
      method: "POST",
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: msg.text.slice(0, 1900) }),
      timeoutSec: 30,
    });
  }
}

export class SlackGateway implements GatewayAdapter {
```

<!-- apply: replace src/gateway_runner.ts -->
**Edit `src/gateway_runner.ts`.** Find this text, which appears exactly once (`grep -n -F '    if (!this.token) return;' src/gateway_runner.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    if (!this.token) return;
    spawnSync(
      "curl",
      [
        "-s",
        "-X",
        "POST",
        "https://slack.com/api/chat.postMessage",
        "-H",
        `Authorization: Bearer ${this.token}`,
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify({ channel: msg.chatId, text: msg.text.slice(0, 3900) }),
      ],
      { encoding: "utf-8" },
    );
  }
}
```

Replace with:

```ts
    if (!this.token) return;
    httpSync({
      url: "https://slack.com/api/chat.postMessage",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: msg.chatId, text: msg.text.slice(0, 3900) }),
      timeoutSec: 30,
    });
  }
}
```

`src/embedder.ts` is not touched: its Ollama calls carry no secret.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=http_sync`
Expected: four `[PASS]` and `── 4/4 passed · 0 failed ──`.
Then confirm nothing else builds a curl argv by hand: `grep -n '"curl"' src/*.ts`. Expected: exactly three lines: `src/embedder.ts:153`, `src/embedder.ts:190` (its loopback Ollama probe and Ollama embedding calls, which carry no secret and stay as they are) and `src/http_sync.ts:126` (the helper itself). Line numbers may drift by a few; the point is that no other file appears.

- [ ] **Step 6: Gates**

Run: `npm run typecheck`, `npm run lint`, `npm test`.
Expected: clean (lint fails on an unused `spawnSync` import, so each file's import must have been removed as the steps say); `npm test` ends `── 554/554 passed · 0 failed ──`.

- [ ] **Step 7: Commit**

```bash
git status --short
git add tests/harness.ts src/http_sync.ts src/mcp_client.ts src/mcp_oauth.ts src/slack_ops.ts src/discord_ops.ts src/gateway.ts src/gateway_runner.ts
git commit -m "fix: keep secrets off curl command lines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Mutation proofs**

For each, apply it, run `node --experimental-strip-types tests/harness.ts --suite=http_sync`, check the failure, then revert with `git checkout -- <file> && git diff --exit-code`.

(a) Backslash no longer escaped (file `src/http_sync.ts`). Mutation, in `src/http_sync.ts`. Find:

```ts
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
```

and replace it with:

```ts
    .replace(/"/g, '\\"')
```

Expected: `[FAIL]` for `values are double-quoted with backslash, quote, LF, CR and TAB escaped` and `a header and a body with quotes, backslashes, newlines and non-ASCII arrive byte for byte`; `── 2/4 passed · 2 failed ──`.

(b) Line breaks no longer refused (file `src/http_sync.ts`). Mutation, in `src/http_sync.ts`. Find:

```ts
  if (!allowLineBreaks && /[\r\n]/.test(value)) refuse(`${label} contains a line break`);
```

and delete it. (Leave the file otherwise unchanged.)

Expected: `[FAIL] http_sync/a line break, a NUL, a bad scheme or a bad header name is refused before curl runs`.

(c) One site back on a hand-built argv (file `src/slack_ops.ts`). Mutation, in `src/slack_ops.ts`. Find:

```ts
  const r = httpSync({
    url: "https://slack.com/api/chat.postMessage",
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: payload,
    timeoutSec: 10,
    maxBytes: 1_000_000,
  });
  const body = r.body;
```

and replace it with:

```ts
  const r = process.getBuiltinModule("node:child_process").spawnSync(
    "curl",
    ["-s", "-m", "10", "-X", "POST", "https://slack.com/api/chat.postMessage", "-H", `Authorization: Bearer ${token}`, "-H", "Content-Type: application/json", "-d", payload],
    { encoding: "utf-8", maxBuffer: 1_000_000 },
  );
  const body = r.stdout || "";
```

Expected: `[FAIL] http_sync/every site that carries a secret keeps it off the curl command line`.

(d) No timeout in the config (file `src/http_sync.ts`). Mutation, in `src/http_sync.ts`. Find:

```ts
    `max-time = ${quoteCurlConfigValue(String(req.timeoutSec))}`,
```

and delete it. (Leave the file otherwise unchanged.)

Expected: `[FAIL] http_sync/a header and a body with quotes, backslashes, newlines and non-ASCII arrive byte for byte` after about 8 s (the receiver hangs up on a curl with no timeout, so the suite does not hang).

---

### Task 5: `POST /turn` runs off the event loop (A9)

**Files:**
- Create: `src/turn.ts`, `src/turn_pool.ts`, `src/turn_worker.ts`
- Modify: `src/server.ts`
- Modify: `tests/harness.ts`
- Modify: `docs/KNOWN_LIMITATIONS.md` (new entry 21)

**Interfaces:**
- Consumes: `startLiveServer`, `LiveServer.request/stderr/stop` (Task 3); `rejectionWithin`, `resolvesWithin` (Task 1); `writeCurlShim`, `shimCalls` (Task 4); `openChamberDb`, `commitBelief`, `listOpenDebts` (already imported in the harness).
- Produces: `runTurn(db: DatabaseSync, message: string): Record<string, unknown>`, `TurnJob`, `TurnReply` in `src/turn.ts`; `class TurnPool { constructor(entry: URL, dbPath: string); run(message: string): Promise<Record<string, unknown>>; close(): Promise<void> }` and `class TurnWorkerError extends Error { chain: string[] }` in `src/turn_pool.ts`.

**Design, in short.** `src/turn.ts` holds the old `runTurn` body, unchanged, with `db` as a parameter. `src/turn_worker.ts` opens its own connection to the database path it is given, registers the Slack pending-write hook, and answers one `TurnJob` at a time with `runTurn`; every reply is the JSON round trip of the result, or `{ ok: false, chain, stack }`. `src/turn_pool.ts` starts that worker on first use, matches replies to requests by id, fails everything in flight if the worker errors or exits, and starts a fresh worker for the next request. `src/server.ts` keeps one pool, or none when the database is `:memory:`.

- [ ] **Step 1: Write the failing tests**

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { fileURLToPath } from "node:url";' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { fileURLToPath } from "node:url";
```

Replace with:

```ts
import { fileURLToPath, pathToFileURL } from "node:url";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { CURL_FIXED_ARGV, buildCurlInvocation, httpSync } from "../src/http_sync.ts";' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { CURL_FIXED_ARGV, buildCurlInvocation, httpSync } from "../src/http_sync.ts";
```

Replace with:

```ts
import { CURL_FIXED_ARGV, buildCurlInvocation, httpSync } from "../src/http_sync.ts";
import { TurnPool, TurnWorkerError } from "../src/turn_pool.ts";
```

Tests (above the report divider): four pool tests that drive `TurnPool` with workers that crash, throw, fail and count; and four tests against the real server. The main one plants one open blocking debt, points `CHAMBER_PYTHON` at a stub that answers the availability probe at once and answers the embedding request after 3 s (having first created a marker file), sends `POST /turn "believe: ..."`, waits for the marker, and then requires `/health` in under 500 ms, `/queue` in under 1.5 s, and the turn to finish with the normal shape after at least 2.5 s.

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '// ─── report ──────────────────────────────────────────────────────────────────' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
// ─── report ──────────────────────────────────────────────────────────────────
```

Replace with:

```ts
// ─── POST /turn OFF THE EVENT LOOP (src/turn_pool.ts, src/turn_worker.ts) ───

/**
 * Worker bodies for exercising the pool without a database. The pool hands each
 * worker `{ dbPath }` as `workerData`; these treat that string as a marker file.
 */
const POOL_WORKER_CRASH_ONCE = `
import { parentPort, workerData } from "node:worker_threads";
import { existsSync, writeFileSync } from "node:fs";
parentPort.on("message", (job) => {
  if (!existsSync(workerData.dbPath)) {
    writeFileSync(workerData.dbPath, "crashed once");
    process.exit(3);
  }
  parentPort.postMessage({ id: job.id, ok: true, result: { echoed: job.message } });
});
`;

const POOL_WORKER_THROWS = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", () => {
  setTimeout(() => { throw new Error("boom outside a turn"); }, 0);
});
`;

const POOL_WORKER_FAILS = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (job) => {
  parentPort.postMessage({
    id: job.id,
    ok: false,
    chain: ["Error: first", "  caused by: Error: second"],
    stack: "Error: first\\n    at fake (fake.ts:1:1)",
  });
});
`;

const POOL_WORKER_COUNTS = `
import { parentPort } from "node:worker_threads";
let seq = 0;
parentPort.on("message", (job) => {
  seq += 1;
  parentPort.postMessage({ id: job.id, ok: true, result: { echoed: job.message, seq } });
});
`;

/** A pool whose worker is `source`, run from a temp dir that is returned for cleanup. */
function poolOf(source: string): { pool: TurnPool; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chamber-pool-"));
  const entry = join(dir, "worker.mjs");
  writeFileSync(entry, source);
  return { pool: new TurnPool(pathToFileURL(entry), join(dir, "marker")), dir };
}

test("turn_pool", "a worker that exits mid-turn fails that request, and the next request gets a fresh worker", async () => {
  const { pool, dir } = poolOf(POOL_WORKER_CRASH_ONCE);
  try {
    const err = await rejectionWithin(pool.run("first"), 10_000);
    assert(/exited/.test(err.message) && /3/.test(err.message), `wrong message: ${err.message}`);
    const second = await resolvesWithin(pool.run("second"), 10_000, "the restarted worker");
    assert(second.echoed === "second", `the restarted worker answered ${JSON.stringify(second)}`);
  } finally {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("turn_pool", "a worker that throws outside a turn fails the request in flight with the thrown error", async () => {
  const { pool, dir } = poolOf(POOL_WORKER_THROWS);
  try {
    const err = await rejectionWithin(pool.run("anything"), 10_000);
    assert(/boom outside a turn/.test(err.message), `wrong message: ${err.message}`);
  } finally {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("turn_pool", "a failure reply becomes a TurnWorkerError that keeps the chain and the stack", async () => {
  const { pool, dir } = poolOf(POOL_WORKER_FAILS);
  try {
    const err = await rejectionWithin(pool.run("x"), 10_000);
    assert(err instanceof TurnWorkerError, `expected a TurnWorkerError, got ${err.name}`);
    assert(
      JSON.stringify(err.chain) === JSON.stringify(["Error: first", "  caused by: Error: second"]),
      `chain: ${JSON.stringify(err.chain)}`,
    );
    assert(/at fake/.test(err.stack ?? ""), `stack: ${err.stack}`);
  } finally {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("turn_pool", "requests run one at a time, in the order they were made", async () => {
  const { pool, dir } = poolOf(POOL_WORKER_COUNTS);
  try {
    const all = await resolvesWithin(
      Promise.all([pool.run("a"), pool.run("b"), pool.run("c")]),
      10_000,
      "three queued runs",
    );
    assert(
      all.map((r) => `${String(r.echoed)}${String(r.seq)}`).join(",") === "a1,b2,c3",
      `got ${JSON.stringify(all)}`,
    );
  } finally {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Stands in for the Python interpreter: answers the embedder's availability
 * probe at once, and answers a real embedding request after 3 s, having first
 * created `embedding` beside itself so the test knows the turn is waiting on it.
 * Every vector is the same unit vector, so every comparison scores 1.0.
 */
const SLOW_PYTHON_JS = `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const vector = Array(384).fill(1 / Math.sqrt(384));
if (args[1] === "--json") {
  const texts = JSON.parse(fs.readFileSync(0, "utf8"));
  fs.writeFileSync(path.join(__dirname, "embedding"), "waiting\\n");
  setTimeout(() => {
    process.stdout.write(JSON.stringify(texts.map(() => vector)) + "\\n");
  }, 3000);
} else {
  process.stdout.write(JSON.stringify(vector) + "\\n");
}
`;

test("server", "POST /turn runs off the event loop: /health answers while the paraphrase check waits on the embedder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chamber-slowpy-"));
  // CHAMBER_PYTHON must be one executable, so a one-line shell wrapper runs the
  // Node script with the Node that is running this harness.
  const stub = join(dir, "slow-python");
  writeFileSync(join(dir, "slow-python.js"), SLOW_PYTHON_JS);
  writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "slow-python.js")}" "$@"\n`, {
    mode: 0o755,
  });
  const s = await startLiveServer({ CHAMBER_PYTHON: stub }, (dbPath) => {
    // An open blocking debt is what makes the next assertion reach the
    // embedder: the paraphrase check has something to compare against.
    const seed = openChamberDb(dbPath);
    commitBelief(seed, {
      type: "belief",
      text: "Customers may return goods within 30 days of purchase.",
      sources: [],
      authorFamily: "test",
      path: "deep",
    });
    assert(listOpenDebts(seed, 5).length === 1, "setup: exactly one blocking debt must be open");
    seed.close();
  });
  try {
    const turn = s.request({
      method: "POST",
      path: "/turn",
      body: JSON.stringify({ message: "believe: Customers may return goods within 14 days of purchase." }),
    });
    // If an assertion below fails first, this request is abandoned when the
    // server is stopped. Without this line that rejection is unhandled and
    // takes the whole harness down, hiding the failure that mattered.
    void turn.catch(() => undefined);
    const marker = join(dir, "embedding");
    const deadline = Date.now() + 15_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((ok) => setTimeout(ok, 25));
    }
    assert(existsSync(marker), `setup: the turn never reached the embedder.\n${s.stderr()}`);

    // The turn is now inside the 3 s embedder wait, holding the write lock.
    const health = await s.request({ path: "/health" });
    assert(health.status === 200, `/health gave ${health.status}`);
    assert(health.ms < 500, `/health took ${health.ms} ms while a turn was running; the loop is blocked`);

    // A route that writes needs the lock the turn holds. It must give up
    // quickly (500 internal_error), not freeze the loop for SQLite's default 5 s.
    const queue = await s.request({ path: "/queue" });
    assert(queue.ms < 1500, `/queue took ${queue.ms} ms; the main connection waited on the turn's lock`);

    const done = await turn;
    assert(done.status === 200, `the turn gave ${done.status}: ${done.text.slice(0, 300)}`);
    assert(done.ms >= 2500, `the turn took ${done.ms} ms, so the 3 s embedder wait never happened`);
    const body = done.json as Record<string, unknown>;
    for (const key of ["turnId", "sessionId", "observation", "assistant", "model", "contract", "spend", "queue", "debts"]) {
      assert(key in body, `the turn reply lacks "${key}": ${done.text.slice(0, 300)}`);
    }
    const after = await s.request({ path: "/queue" });
    assert(after.status === 200, `once the turn is over /queue must work: ${after.status} ${after.text.slice(0, 200)}`);
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server", "the /turn rate limit survives between turns, and the other thread sees what the worker wrote", async () => {
  // capacity 1 and a one-hour refill: the second turn is refused only if the
  // bucket from the first is still there, i.e. the worker is one long-lived thread.
  const s = await startLiveServer({
    CHAMBER_SURFACE_RATE_CAPACITY: "1",
    CHAMBER_SURFACE_RATE_REFILL_MS: "3600000",
  });
  try {
    const first = await s.request({
      method: "POST",
      path: "/turn",
      body: JSON.stringify({ message: "believe: the audit store is SQLite" }),
    });
    assert(first.status === 200 && "turnId" in (first.json as object), `first turn: ${first.status} ${first.text.slice(0, 200)}`);
    const second = await s.request({ method: "POST", path: "/turn", body: JSON.stringify({ message: "hello again" }) });
    const refused = second.json as { ok?: boolean; error?: string };
    assert(
      second.status === 200 && refused.ok === false && /Rate limited/.test(refused.error ?? ""),
      `second turn must be rate limited: ${second.status} ${second.text.slice(0, 200)}`,
    );
    // /status reads on the server's own connection; the belief was written on the worker's.
    const status = await s.request({ path: "/status" });
    assert(((status.json as { beliefs?: number }).beliefs ?? 0) >= 1, `main thread sees: ${status.text.slice(0, 200)}`);
  } finally {
    await s.stop();
  }
});

test("server", "a turn run on the worker still posts its pending write to the Slack ops channel", async () => {
  // registerSlackPendingHook() registers a listener in the module that holds it.
  // proposeWrite now runs in the worker, so the worker has to register it too;
  // the main thread's registration can no longer fire. Observed through a curl
  // shim: the card is posted with the token on curl's stdin.
  const dir = mkdtempSync(join(tmpdir(), "chamber-slackshim-"));
  writeCurlShim(dir);
  const s = await startLiveServer({
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    CHAMBER_SHIM_DIR: dir,
    SLACK_BOT_TOKEN: "SHIMSECRET-worker-slack",
    CHAMBER_SLACK_OPS_CHANNEL: "C0OPS",
  });
  try {
    const r = await s.request({
      method: "POST",
      path: "/turn",
      body: JSON.stringify({ message: "please remember I prefer tea" }),
    });
    assert(r.status === 200, `turn: ${r.status} ${r.text.slice(0, 300)}`);
    const calls = shimCalls(dir);
    assert(
      calls.some((c) => c.stdin.includes("chat.postMessage") && c.stdin.includes("SHIMSECRET-worker-slack")),
      `no Slack card was posted; curl calls: ${JSON.stringify(calls.map((c) => c.argv))}\n${s.stderr()}`,
    );
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server", "with an in-memory database the turn runs inline, because a thread cannot share it", async () => {
  const s = await startLiveServer({ CHAMBER_DB: ":memory:" });
  try {
    const r = await s.request({ method: "POST", path: "/turn", body: JSON.stringify({ message: "hello" }) });
    assert(r.status === 200 && "turnId" in (r.json as object), `inline turn: ${r.status} ${r.text.slice(0, 300)}`);
  } finally {
    await s.stop();
  }
});

// ─── report ──────────────────────────────────────────────────────────────────
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '  | "http_sync"' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  | "http_sync"
  | "all";
```

Replace with:

```ts
  | "http_sync"
  | "turn_pool"
  | "all";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '    "http_sync",' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    "http_sync",
    "all",
  ].includes(v)
```

Replace with:

```ts
    "http_sync",
    "turn_pool",
    "all",
  ].includes(v)
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=turn_pool`
Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/turn_pool.ts'`.

- [ ] **Step 3: Move the turn into `src/turn.ts`**

This is the old `runTurn` from `src/server.ts` with `db` as the first parameter. The wire types come with it.

<!-- apply: create src/turn.ts -->
**Create `src/turn.ts`** with exactly this content:

```ts
/**
 * One `POST /turn`, as a function of a database and a message.
 *
 * Lived in `src/server.ts` and ran on the event loop. A turn that reaches the
 * paraphrase check holds `BEGIN IMMEDIATE` across a Python embedding spawn (that
 * is FM-6 and it stays), so on the main thread it froze every other route for
 * as long as the embedder took: `/health` included, which is what a load
 * balancer reads. It now runs in `src/turn_worker.ts`, on its own connection to
 * the same database file, and this module is the part both threads share.
 *
 * The wire types are here, and not in the worker or the pool, so the pool can
 * import them as types without ever loading this module's dependencies.
 */

import type { DatabaseSync } from "node:sqlite";
import { sha256, newId } from "./hash.ts";
import { commitBelief } from "./commit_belief.ts";
import { completeSync, syncCompletionAvailable } from "./model.ts";
import { enforceReplyContract } from "./contract.ts";
import { runExpiryJob } from "./expiry.ts";
import { spendLastHours, formatSpendFooter, assertSpendBudget } from "./spend.ts";
import { proposeWrite, listPendingQueue, expireStalePending } from "./approvals.ts";
import { evaluateWorkflows } from "./approval_workflows.ts";
import { appendAudit } from "./audit.ts";
import { listOpenDebts } from "./debt.ts";
import { startSession, appendMessage } from "./sessions.ts";
import {
  quarantineUntrustedText,
  stripInvisibleNoise,
  checkRateLimit,
  surfaceRateKey,
} from "./surface_harden.ts";

/** Main thread to worker: run this message. */
export interface TurnJob {
  id: number;
  message: string;
}

/** Worker to main thread. A failure carries the error chain and stack as text, which survive a thread boundary. */
export type TurnReply =
  | { id: number; ok: true; result: Record<string, unknown> }
  | { id: number; ok: false; chain: string[]; stack: string };

export function runTurn(db: DatabaseSync, message: string): Record<string, unknown> {
  // Asked before anything is written. Every one of these surfaces commits an
  // observation, opens a session and writes audit rows before it reaches
  // completeSync, which refuses the openai mode by design — so the ledger gained
  // rows and the caller gained an exception, in that order. Guarding only the
  // CLI left four other surfaces reproducing the exact defect the guard was
  // written to remove.
  const model = syncCompletionAvailable();
  if (!model.ok) throw new Error(`turn unavailable: ${model.reason}`);

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
```

- [ ] **Step 4: Create the pool and the worker**

<!-- apply: create src/turn_pool.ts -->
**Create `src/turn_pool.ts`** with exactly this content:

```ts
/**
 * The main thread's side of the `/turn` worker: one long-lived thread, one job
 * at a time.
 *
 * `run()` posts the message and resolves with the worker's reply. The worker is
 * started on first use, handles jobs in the order they arrive (its message
 * handler is synchronous, so the port's queue is the queue), and is restarted on
 * the next `run()` if it ever dies. Anything that was in flight when it died
 * fails with an error, and so does anything queued behind it: whether a turn
 * that was mid-flight committed is not knowable from here, so none is retried.
 *
 * The worker file is a parameter so the tests can drive this class with a
 * worker that crashes on purpose. The protocol types live in `src/turn.ts` and
 * are imported as types only, so this module loads nothing of the turn itself.
 */

import { Worker } from "node:worker_threads";
import type { TurnJob, TurnReply } from "./turn.ts";

/** A failure reported by the worker. The chain and stack are the worker's own text. */
export class TurnWorkerError extends Error {
  readonly chain: string[];

  constructor(chain: string[], stack: string) {
    super(chain[0] ?? "turn failed");
    this.name = "TurnWorkerError";
    this.chain = chain;
    if (stack !== "") this.stack = stack;
  }
}

interface InFlight {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

export class TurnPool {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly inFlight = new Map<number, InFlight>();
  private readonly entry: URL;
  private readonly dbPath: string;

  /** `entry` is the worker module; `dbPath` is handed to it as `workerData.dbPath`. */
  constructor(entry: URL, dbPath: string) {
    this.entry = entry;
    this.dbPath = dbPath;
  }

  run(message: string): Promise<Record<string, unknown>> {
    const worker = this.worker ?? this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.inFlight.set(id, { resolve, reject });
      const job: TurnJob = { id, message };
      worker.postMessage(job);
    });
  }

  /** Stop the worker. Anything still in flight fails. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failAll(new Error("turn worker closed"));
    if (worker) await worker.terminate();
  }

  private start(): Worker {
    const worker = new Worker(this.entry, { workerData: { dbPath: this.dbPath } });
    worker.on("message", (reply: TurnReply) => {
      const job = this.inFlight.get(reply.id);
      if (!job) return;
      this.inFlight.delete(reply.id);
      if (reply.ok) job.resolve(reply.result);
      else job.reject(new TurnWorkerError(reply.chain, reply.stack));
    });
    // An uncaught exception in the worker: 'error', then 'exit'. Forget the
    // worker at the first of them, so a request that arrives in between starts a
    // new one instead of posting to a thread that is going away.
    worker.on("error", (err) => {
      if (this.worker === worker) this.worker = null;
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      void worker.terminate();
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.worker = null;
      this.failAll(new Error(`turn worker exited (code ${code}) before answering`));
    });
    this.worker = worker;
    return worker;
  }

  private failAll(reason: Error): void {
    const jobs = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const job of jobs) job.reject(reason);
  }
}
```

<!-- apply: create src/turn_worker.ts -->
**Create `src/turn_worker.ts`** with exactly this content:

```ts
/**
 * Worker-thread entry point for `POST /turn`. Started by `src/turn_pool.ts`.
 *
 * It opens its own connection to the server's database file (`workerData.dbPath`,
 * the path the server actually opened, after any redirect) and answers `TurnJob`
 * messages one at a time with `runTurn`. The paraphrase check and the write stay
 * in one `BEGIN IMMEDIATE` inside `commitBelief`, on this thread (FM-6); nothing
 * about that changes, only which thread waits for the embedder.
 *
 * What it has to set up for itself, because a thread shares nothing with the
 * main thread but the environment (copied when the thread starts):
 *  - the pending-write hook: `proposeWrite` runs here now, and a listener
 *    registered on the main thread never sees it;
 *  - the model and embedder settings: the server never calls `applyModelEnv`,
 *    so it runs on `process.env` alone, and so does this thread.
 * Spend and the approval queue are rows in the database, so both connections
 * share them. The `/turn` rate-limit bucket is in memory and lives here, for as
 * long as this thread does.
 */

import { parentPort, workerData } from "node:worker_threads";
import { openChamberDb } from "./db.ts";
import { formatErrorChain } from "./error_chain.ts";
import { registerSlackPendingHook } from "./slack_ops.ts";
import { runTurn, type TurnJob, type TurnReply } from "./turn.ts";

if (parentPort === null) {
  throw new Error("turn_worker.ts is a worker-thread entry point; it cannot be run directly");
}
const port = parentPort;
const { dbPath } = workerData as { dbPath: string };

try {
  registerSlackPendingHook();
} catch {
  /* slack optional */
}
const db = openChamberDb(dbPath);

port.on("message", (job: TurnJob) => {
  let reply: TurnReply;
  try {
    // Through JSON, so what crosses the thread is exactly what the HTTP reply
    // would have carried, and nothing that cannot be cloned.
    const result = JSON.parse(JSON.stringify(runTurn(db, job.message))) as Record<string, unknown>;
    reply = { id: job.id, ok: true, result };
  } catch (err) {
    reply = {
      id: job.id,
      ok: false,
      chain: formatErrorChain(err),
      stack: err instanceof Error && err.stack ? err.stack : "",
    };
  }
  port.postMessage(reply);
});
```

- [ ] **Step 5: Use them from the server**

Imports (the server no longer needs most of what the turn imported):

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F 'import { openChamberDb } from "./db.ts";' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
import { openChamberDb } from "./db.ts";
import { configPath, loadConfig } from "./config.ts";
import { formatErrorChain } from "./error_chain.ts";
import { sha256, newId } from "./hash.ts";
import { commitBelief } from "./commit_belief.ts";
import { completeSync, syncCompletionAvailable } from "./model.ts";
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
```

Replace with:

```ts
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
import { runTurn } from "./turn.ts";
import { TurnPool, TurnWorkerError } from "./turn_pool.ts";

// Registered here for the one case where a turn still runs on this thread (an
// in-memory database, see `turns` below). A turn on the worker registers its own.
try { registerSlackPendingHook(); } catch { /* slack optional */ }
```

The main connection's short lock wait (the cost of FM-6, see "What running the design found", item 2):

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F '    dbPath = loadConfig().database;' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    dbPath = loadConfig().database;
    return openChamberDb(dbPath, (actual) => {
      dbPath = actual;
    });
  } catch (err) {
```

Replace with:

```ts
    dbPath = loadConfig().database;
    const opened = openChamberDb(dbPath, (actual) => {
      dbPath = actual;
    });
    // A turn on the worker holds SQLite's one write lock across an embedder
    // spawn (FM-6: the check and the write are one transaction, and that is
    // not negotiable). A route on this thread that writes would then wait on
    // that lock, and `DatabaseSync` waits with the whole event loop stopped.
    // `openChamberDb` leaves a 5 s wait, which is right for a command line and
    // wrong here: keep it short, so a contended write fails fast with the 500
    // below instead of freezing every other route. Reads are not affected (WAL).
    opened.exec(`PRAGMA busy_timeout = ${MAIN_THREAD_BUSY_MS}`);
    return opened;
  } catch (err) {
```

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F 'let dbPath = "";' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
let dbPath = "";
```

Replace with:

```ts
let dbPath = "";

/** How long this thread's connection waits for the write lock the turn worker may hold. */
const MAIN_THREAD_BUSY_MS = 250;
```

The pool, created once the database path is final:

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F 'function extractToken(req: IncomingMessage): string {' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
function extractToken(req: IncomingMessage): string {
```

Replace with:

```ts
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
```

Remove the old function. This deletes `runTurn` from `src/server.ts`, from its first line to the first line that is exactly `}`. (This is the macOS `sed`; with GNU sed on Linux drop the `''` after `-i`.)

<!-- apply: shell -->
```bash
sed -i '' '/^function runTurn(message: string): Record<string, unknown> {$/,/^}$/d' src/server.ts
```

Check: `grep -c 'function runTurn' src/server.ts` prints `0`, and `grep -n 'runTurn' src/server.ts` shows only the import and the route.

The route:

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F '      json(res, 200, runTurn(message));' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
      json(res, 200, runTurn(message));
      return;
```

Replace with:

```ts
      json(res, 200, turns === null ? runTurn(db, message) : await turns.run(message));
      return;
```

The error line for a failure reported by the worker keeps the worker's own chain:

<!-- apply: replace src/server.ts -->
**Edit `src/server.ts`.** Find this text, which appears exactly once (`grep -n -F '      `chamber server error ${id}: ${formatErrorChain(err).join("; ")}\n` +' src/server.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
      `chamber server error ${id}: ${formatErrorChain(err).join("; ")}\n` +
```

Replace with:

```ts
      `chamber server error ${id}: ` +
        `${(err instanceof TurnWorkerError ? err.chain : formatErrorChain(err)).join("; ")}\n` +
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=turn_pool` then `node --experimental-strip-types tests/harness.ts --suite=server`
Expected: `turn_pool` ends `── 4/4 passed · 0 failed ──`; `server` ends `── 16/16 passed · 0 failed ──`. The blocking test takes about 7 s.

- [ ] **Step 7: Prove the compiled package finds its worker**

```bash
npm run build
ls dist | grep -E '^turn'
CHAMBER_DB="$(mktemp -d)/smoke.sqlite" PORT=18893 node dist/server.js &
SERVER_PID=$!
sleep 3
curl -s -X POST -H 'Content-Type: application/json' -d '{"message":"hello"}' http://127.0.0.1:18893/turn | head -5
kill $SERVER_PID
rm -rf dist
git status --short
```
Expected: `ls` shows `turn.js`, `turn_pool.js`, `turn_worker.js`; curl prints the start of a JSON reply (`{`, `"turnId": "trn_...`, ...); after `rm -rf dist`, `git status --short` shows only the files this task changed (`dist/` is ignored, but it must be gone).

- [ ] **Step 8: Document the contention**

<!-- apply: replace docs/KNOWN_LIMITATIONS.md -->
**Edit `docs/KNOWN_LIMITATIONS.md`.** Find this text, which appears exactly once (`grep -n -F 'vectors would trade a scanner number for a correctness regression.' docs/KNOWN_LIMITATIONS.md` finds its first line), and replace all of it with the new text.

Find:

```md
vectors would trade a scanner number for a correctness regression.
```

Replace with:

```md
vectors would trade a scanner number for a correctness regression.

## 21. While a turn waits on the embedder, only `/health` is certain to answer

`POST /turn` runs on a worker thread (`src/turn_worker.ts`), on its own connection to the
same database file, so a turn no longer stops the event loop. What it cannot stop is
SQLite's single write lock. A turn that reaches the paraphrase check holds `BEGIN
IMMEDIATE` across a Python embedding spawn, which can take up to 180 s, because the check
and the write are one transaction (FM-6, `src/commit_belief.ts`) and that is not up for
negotiation.

**What it costs.** Measured against a real server with an embedder that takes 3 s:
`/health` and `/checkpoint` answer in about 2 ms. `/status` and `/queue` answer `500
internal_error` after about 280 ms, with `database is locked` on stderr beside the same id,
because both run the TTL sweep (`expireStalePending`), which is an `UPDATE` even when
nothing has expired. `/approve` for a write that exists, and `/deliberate`, need the same
lock and fail the same way (`/reject` makes the same `decideWrite` call). A second `POST /turn`
waits behind the first. Before the worker, every one of those routes, `/health` included,
froze for the whole wait; the main thread's connection now gives up after 250 ms
(`MAIN_THREAD_BUSY_MS` in `src/server.ts`) instead of SQLite's default 5 s.

Two smaller things follow from the turn living in another thread. The `/turn` rate-limit
bucket is in memory in that thread, so a worker that dies and is restarted starts with a
full bucket. And an in-memory database (`CHAMBER_DB=:memory:`, or the last-resort fallback
`openChamberDb` announces on stderr) cannot be shared with a thread, so there the turn runs
on the main thread as it always did, and blocks.

**What would fix it.** Skip the TTL sweep when the lock is held (`decideWrite` already
refuses an expired write by itself, so only the listing is momentarily stale), or run it
from the worker. Not done here: it changes `src/approvals.ts`, which this change does not
otherwise touch.
```

- [ ] **Step 9: Gates**

Run: `npm run typecheck`, `npm run lint`, `npm test`.
Expected: clean; `npm test` ends `── 562/562 passed · 0 failed ──`.

- [ ] **Step 10: Commit**

```bash
git status --short
git add tests/harness.ts src/turn.ts src/turn_pool.ts src/turn_worker.ts src/server.ts docs/KNOWN_LIMITATIONS.md
git commit -m "feat: run POST /turn on a worker thread

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Mutation proofs**

For each: apply, run the stated command, check the failure, revert with `git checkout -- <file> && git diff --exit-code`.

(a) The turn back on the event loop (file `src/server.ts`; run `--suite=server`). Mutation, in `src/server.ts`. Find:

```ts
      json(res, 200, turns === null ? runTurn(db, message) : await turns.run(message));
```

and replace it with:

```ts
      json(res, 200, runTurn(db, message));
```

Expected: `[FAIL] server/POST /turn runs off the event loop: /health answers while the paraphrase check waits on the embedder` (about 7 s; its message says `/health took ... ms while a turn was running`). `── 15/16 passed · 1 failed ──`.

(b) The main connection keeps SQLite's 5 s wait (file `src/server.ts`; `--suite=server`). Mutation, in `src/server.ts`. Find:

```ts
    opened.exec(`PRAGMA busy_timeout = ${MAIN_THREAD_BUSY_MS}`);
```

and delete it. (Leave the file otherwise unchanged.)

Expected: the same test fails, with `/queue took ... ms`. `── 15/16 passed · 1 failed ──`.

(c) The worker does not register the Slack hook (file `src/turn_worker.ts`; `--suite=server`). Mutation, in `src/turn_worker.ts`. Find:

```ts
try {
  registerSlackPendingHook();
} catch {
  /* slack optional */
}
```

and delete it. (Leave the file otherwise unchanged.)

Expected: `[FAIL] server/a turn run on the worker still posts its pending write to the Slack ops channel`.

(d) The pool does not forget a worker that exited (file `src/turn_pool.ts`; run `--suite=turn_pool`). Mutation, in `src/turn_pool.ts`. Find:

```ts
      if (this.worker === worker) this.worker = null;
      this.failAll(new Error(`turn worker exited (code ${code}) before answering`));
```

and replace it with:

```ts
      this.failAll(new Error(`turn worker exited (code ${code}) before answering`));
```

Expected: `[FAIL] turn_pool/a worker that exits mid-turn fails that request, and the next request gets a fresh worker` after about 10 s; `── 3/4 passed · 1 failed ──`.

---

### Task 6: The sandbox is required unless the operator opts out (D1)

**Files:**
- Modify: `src/sandbox.ts`
- Modify: `tests/harness.ts`
- Modify: `README.md`, `docs/KNOWN_LIMITATIONS.md` (entry 1, the default only), `SECURITY.md`, `deploy/systemd/env.example`

**Interfaces:**
- Consumes: `withSandboxEnv({ required?, backend? }, fn)` (already in the harness; it clears both variables first, so `required: undefined` means unset).
- Changes: `runInSandbox` refuses when `CHAMBER_SANDBOX_REQUIRED` is unset, empty, blank or anything but `0`, `false`, `no`, `off` (any case, trimmed) and the backend does not isolate. Every caller gets the refusal: `tool-run`, `tool-synth`, `sandbox-test` (`src/cli.ts`), `runTool` and `synthesizeTool` (`src/tools.ts`), `verifyMcpToolSource` (`src/mcp_bridge.ts`).

- [ ] **Step 1: Write the failing tests, and pin the old default's tests to the opt-out**

These four existing tests ran tool code with the variable unset and now need the explicit opt-out; the fifth (`T5`) is pinned too so it keeps failing for its own reason.

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F 'test("tools", "T1_sandbox_self_test", () => {' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
test("tools", "T1_sandbox_self_test", () => {
  const r = sandboxSelfTest();
  assert(r.ok, `sandbox failed: ${r.stderr || r.error}`);
  assert(r.stdout.includes("ok"), r.stdout);
});

test("tools", "T2_allowlist_echo", () => {
  const db = freshDb();
  const r = runTool(db, "echo", ["hello-chamber"]);
  assert(r.allowed, r.reason);
```

Replace with:

```ts
// The sandbox is required unless an operator opts out, so a test that needs
// tool code to actually run says so: `required: "0"` is the opt-out, and these
// hosts (macOS, a CI runner without bubblewrap) have nothing that isolates.
test("tools", "T1_sandbox_self_test", () => {
  const r = withSandboxEnv({ required: "0" }, () => sandboxSelfTest());
  assert(r.ok, `sandbox failed: ${r.stderr || r.error}`);
  assert(r.stdout.includes("ok"), r.stdout);
});

test("tools", "T2_allowlist_echo", () => {
  const db = freshDb();
  const r = withSandboxEnv({ required: "0" }, () => runTool(db, "echo", ["hello-chamber"]));
  assert(r.allowed, r.reason);
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F 'test("tools", "T4_synth_pass_queues", () => {' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
test("tools", "T4_synth_pass_queues", () => {
  const db = freshDb();
  const r = synthesizeTool(db, {
    name: "double",
    description: "double a number",
    source: `const n = Number(process.argv[2]||1); console.log(n*2);`,
    risk: ["compute"],
  });
  assert(r.sandbox.ok, r.sandbox.stderr);
  assert(r.status === "queued", r.reason);
  assert(!!r.writeId, "writeId required");
});

test("tools", "T5_synth_fail_rejects", () => {
  const db = freshDb();
  const r = synthesizeTool(db, {
    name: "boom",
    description: "fails",
    source: `process.exit(2)`,
    risk: ["compute"],
  });
  assert(!r.sandbox.ok, "expected sandbox fail");
```

Replace with:

```ts
test("tools", "T4_synth_pass_queues", () => {
  const db = freshDb();
  const r = withSandboxEnv({ required: "0" }, () =>
    synthesizeTool(db, {
      name: "double",
      description: "double a number",
      source: `const n = Number(process.argv[2]||1); console.log(n*2);`,
      risk: ["compute"],
    }),
  );
  assert(r.sandbox.ok, r.sandbox.stderr);
  assert(r.status === "queued", r.reason);
  assert(!!r.writeId, "writeId required");
});

test("tools", "T5_synth_fail_rejects", () => {
  const db = freshDb();
  // With the opt-out, so that the rejection comes from the source failing and
  // not from the default refusing to run anything.
  const r = withSandboxEnv({ required: "0" }, () =>
    synthesizeTool(db, {
      name: "boom",
      description: "fails",
      source: `process.exit(2)`,
      risk: ["compute"],
    }),
  );
  assert(!r.sandbox.ok, "expected sandbox fail");
  assert(r.sandbox.exitCode === 2, `the source must have run and exited 2, got ${r.sandbox.exitCode}`);
```

The test that pinned the old default is replaced by three: unset, empty and blank all refuse and nothing runs; with no backend named, a host without bubblewrap refuses; every spelling of the opt-out runs.

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F 'test("tools", "an unset sandbox requirement still runs the subprocess fallback", () => {' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
test("tools", "an unset sandbox requirement still runs the subprocess fallback", () => {
  const r = withSandboxEnv({ backend: "subprocess" }, () =>
    runInSandbox({ runtime: "node", source: `console.log("ran")`, timeoutMs: 5000 }),
  );
  assert(r.ok, `fallback must still work when isolation is not required: ${r.error}`);
  assert(r.stdout.includes("ran"), r.stdout);
});
```

Replace with:

```ts
test("tools", "an unset or empty sandbox requirement refuses a backend that does not isolate, and nothing runs", () => {
  // The default used to be "run it anyway". Now unset, empty and blank all mean
  // required, and the refusal says how to opt out.
  const dir = mkdtempSync(join(tmpdir(), "chamber-sbx-default-"));
  const marker = join(dir, "escaped");
  try {
    for (const backend of ["subprocess", "docker"]) {
      for (const spelling of [undefined, "", "   "]) {
        const r = withSandboxEnv({ required: spelling, backend }, () =>
          runInSandbox({
            runtime: "node",
            source:
              `import { writeFileSync } from "node:fs";\n` +
              `writeFileSync(${JSON.stringify(marker)}, "x");\n` +
              `console.log("ran");`,
            timeoutMs: 5000,
          }),
        );
        const label = `${backend} with CHAMBER_SANDBOX_REQUIRED ${spelling === undefined ? "unset" : JSON.stringify(spelling)}`;
        assert(!r.ok, `${label}: must refuse`);
        assert(!existsSync(marker), `${label}: refused, but the source still ran`);
        assert(
          r.error?.endsWith("Set CHAMBER_SANDBOX_REQUIRED=0 to run tool code without isolation.") === true,
          `${label}: the refusal must end with the way out, got ${JSON.stringify(r.error)}`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tools", "with the requirement unset and no backend named, nothing runs unisolated", () => {
  const r = withSandboxEnv({}, () =>
    runInSandbox({ runtime: "node", source: `console.log("ran")`, timeoutMs: 8000 }),
  );
  const hasBwrap = spawnSync("which", ["bwrap"], { encoding: "utf8" }).status === 0;
  if (!hasBwrap) {
    // This host has nothing that isolates: the default must refuse, and the
    // source must not have produced output.
    assert(!r.ok && !r.stdout.includes("ran"), `a host without bwrap ran the source: ${JSON.stringify(r)}`);
    assert(r.backend === "none", `a refusal ran on no backend, got ${r.backend}`);
  } else {
    // Where bwrap exists the answer depends on whether it confines here. Either
    // outcome is acceptable except an unisolated run.
    assert(r.backend !== "subprocess", `ran as a plain subprocess: ${JSON.stringify(r)}`);
  }
});

test("tools", "an explicit opt-out, spelled 0 false no or off in any case, runs the subprocess backend", () => {
  for (const spelling of ["0", "false", "no", "off", "OFF", " Off ", "False"]) {
    const r = withSandboxEnv({ required: spelling, backend: "subprocess" }, () =>
      runInSandbox({ runtime: "node", source: `console.log("ran")`, timeoutMs: 5000 }),
    );
    assert(r.ok && r.stdout.includes("ran"), `${JSON.stringify(spelling)} must opt out: ${JSON.stringify(r)}`);
    assert(r.backend === "subprocess", `${JSON.stringify(spelling)}: backend ${r.backend}`);
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=tools`
Expected: `[FAIL]` for `an unset or empty sandbox requirement refuses a backend that does not isolate, and nothing runs` and `with the requirement unset and no backend named, nothing runs unisolated`; `── 11/13 passed · 2 failed ──`. (On a Linux host with bubblewrap the second one may pass; the first still fails.)

- [ ] **Step 3: Change the default**

<!-- apply: replace src/sandbox.ts -->
**Edit `src/sandbox.ts`.** Find this text, which appears exactly once (`grep -n -F ' *   3. fail-closed if CHAMBER_SANDBOX_REQUIRED=1 and no isolation' src/sandbox.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
 *   3. fail-closed if CHAMBER_SANDBOX_REQUIRED=1 and no isolation
```

Replace with:

```ts
 *   3. fail-closed unless CHAMBER_SANDBOX_REQUIRED is set to an explicit
 *      "off" (0, false, no, off) and no isolation is proven
```

<!-- apply: replace src/sandbox.ts -->
**Edit `src/sandbox.ts`.** Find this text, which appears exactly once (`grep -n -F '/**' src/sandbox.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
/**
 * Is isolation being demanded? Any value that is not an explicit "off" counts.
 *
 * Testing `=== "1"` made `CHAMBER_SANDBOX_REQUIRED=true` — and `yes`, and a
 * trailing newline from a shell heredoc — run unisolated while the operator who
 * set it believed the opposite. That is the worst direction for a typo to
 * resolve: the flag exists to be a promise, so an unrecognised spelling must
 * keep the promise, not silently drop it.
 */
function sandboxRequired(): boolean {
  const v = (process.env.CHAMBER_SANDBOX_REQUIRED ?? "").trim().toLowerCase();
  return !(v === "" || v === "0" || v === "false" || v === "no" || v === "off");
}
```

Replace with:

```ts
/**
 * Is isolation being demanded? Yes, unless the operator has said otherwise.
 *
 * Unset and empty mean required. So does every value that is not an explicit
 * "off" (`0`, `false`, `no`, `off`, any case, surrounding space ignored).
 *
 * Two earlier mistakes are why. Testing `=== "1"` made
 * `CHAMBER_SANDBOX_REQUIRED=true` — and `yes`, and a trailing newline from a
 * shell heredoc — run unisolated while the operator who set it believed the
 * opposite. Fixing that left the *unset* case open: the default was "run it
 * anyway", so every install that never heard of the variable executed
 * model-authored and vendor-supplied code with the user's full privileges. A
 * default is the setting most installs run with. Opting out has to be a
 * decision someone typed, not the absence of one.
 */
function sandboxRequired(): boolean {
  const v = (process.env.CHAMBER_SANDBOX_REQUIRED ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/** The way out, appended to every refusal that required isolation caused. */
const SANDBOX_OPT_OUT = "Set CHAMBER_SANDBOX_REQUIRED=0 to run tool code without isolation.";
```

<!-- apply: replace src/sandbox.ts -->
**Edit `src/sandbox.ts`.** Find this text, which appears exactly once (`grep -n -F '          ? `sandbox required but ${backend} does not isolate ` +' src/sandbox.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
          ? `sandbox required but ${backend} does not isolate ` +
            `(isolating backends: ${[...ISOLATING_BACKENDS].join(", ")})`
          : !isolationHolds(backend)
            ? `sandbox required and ${backend} was selected, but it did not ` +
              `confine a probe — treating the name as unproven`
            : null;
```

Replace with:

```ts
          ? `sandbox required but ${backend} does not isolate ` +
            `(isolating backends: ${[...ISOLATING_BACKENDS].join(", ")}). ` +
            SANDBOX_OPT_OUT
          : !isolationHolds(backend)
            ? `sandbox required and ${backend} was selected, but it did not ` +
              `confine a probe — treating the name as unproven. ` +
              SANDBOX_OPT_OUT
            : null;
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=tools`
Expected: `── 13/13 passed · 0 failed ──`.

- [ ] **Step 5: Documentation**

<!-- apply: replace README.md -->
**Edit `README.md`.** Find this text, which appears exactly once (`grep -n -F 'flattering. The sandbox does not isolate: a docker detection can relabel to a' README.md` finds its first line), and replace all of it with the new text.

Find:

```md
flattering. The sandbox does not isolate: a docker detection can relabel to a
subprocess, `CHAMBER_SANDBOX_REQUIRED=1` does not fail closed, and a probed run
read `$HOME` and resolved DNS (`docs/KNOWN_LIMITATIONS.md` §1). That path is off
`chamber_check`. Do not read "sandbox" as containment. Citation debt blocks a
```

Replace with:

```md
flattering. The sandbox is required by default, and the default refuses: tool
code (`tool-run`, `tool-synth`, `sandbox-test`, MCP tool verification) runs only
under bubblewrap, and only after a probe shows that bubblewrap confines. With no
such backend it refuses, and `CHAMBER_SANDBOX_REQUIRED=0` (or `false`, `no`,
`off`) is the explicit opt-out that runs a plain subprocess with a scrubbed
environment. That opt-out does not isolate: a probed run read `$HOME` and
resolved DNS (`docs/KNOWN_LIMITATIONS.md` §1). Isolation cannot be tested on
macOS, which has no bubblewrap. That path is off `chamber_check`. With the
opt-out, do not read "sandbox" as containment. Citation debt blocks a
```

<!-- apply: replace docs/KNOWN_LIMITATIONS.md -->
**Edit `docs/KNOWN_LIMITATIONS.md`.** Find this text, which appears exactly once (`grep -n -F '## 1. The sandbox does not isolate' docs/KNOWN_LIMITATIONS.md` finds its first line), and replace all of it with the new text.

Find:

```md
## 1. The sandbox does not isolate

`src/sandbox.ts` is named for containment it does not provide. Running
```

Replace with:

```md
## 1. The sandbox does not isolate

> **Default changed, 2026-10-21.** `CHAMBER_SANDBOX_REQUIRED` now means
> required when it is unset or empty. Without an isolating backend whose probe
> confines (today only bubblewrap), `runInSandbox` refuses, and so does every
> caller: `tool-run`, `tool-synth`, `sandbox-test` and `verifyMcpToolSource`.
> The refusal ends with the way out, `Set CHAMBER_SANDBOX_REQUIRED=0 to run
> tool code without isolation.` Only an explicit `0`, `false`, `no` or `off`
> (any case) selects the unisolated subprocess that the rest of this entry
> describes.

`src/sandbox.ts` is named for containment it does not provide. Running
```

<!-- apply: replace SECURITY.md -->
**Edit `SECURITY.md`.** Find this text, which appears exactly once (`grep -n -F '  reaching the network outside its confinement, or `CHAMBER_SANDBOX_REQUIRED`' SECURITY.md` finds its first line), and replace all of it with the new text.

Find:

```md
  reaching the network outside its confinement, or `CHAMBER_SANDBOX_REQUIRED`
  failing to refuse when nothing isolating is available.
```

Replace with:

```md
  reaching the network outside its confinement, or tool code running when
  nothing isolating is available. Isolation is required unless
  `CHAMBER_SANDBOX_REQUIRED` is set to `0`, `false`, `no` or `off`; an unset or
  empty value is "required", and a report that defeats that default is in scope.
```

<!-- apply: replace deploy/systemd/env.example -->
**Edit `deploy/systemd/env.example`.** Find this text, which appears exactly once (`grep -n -F 'CHAMBER_FACULTY_MODE=heuristic' deploy/systemd/env.example` finds its first line), and replace all of it with the new text.

Find:

```sh
CHAMBER_FACULTY_MODE=heuristic
```

Replace with:

```sh
# Tool code runs only under an isolating backend (bubblewrap). Without one it is
# refused. 0, false, no or off runs it with no isolation at all.
# CHAMBER_SANDBOX_REQUIRED=0
CHAMBER_FACULTY_MODE=heuristic
```

- [ ] **Step 6: Gates, probes included**

Run: `npm run typecheck`, `npm run lint`, `npm test`, `npm run probes`.
Expected: clean; `npm test` ends `── 564/564 passed · 0 failed ──`; `npm run probes` exits 0. (`probes/sandbox_escape.ts` already sets `CHAMBER_SANDBOX_REQUIRED=1` itself.) If a test other than the five above fails, it ran tool code under the old default: wrap that one call in `withSandboxEnv({ required: "0" }, ...)` and say so in the commit body.

- [ ] **Step 7: Commit**

```bash
git status --short
git add tests/harness.ts src/sandbox.ts README.md docs/KNOWN_LIMITATIONS.md SECURITY.md deploy/systemd/env.example
git commit -m "fix: require the sandbox unless the operator opts out

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Mutation proof (an empty value means "not required" again)**

Mutation, in `src/sandbox.ts`. Find:

```ts
  return !(v === "0" || v === "false" || v === "no" || v === "off");
```

and replace it with:

```ts
  return !(v === "" || v === "0" || v === "false" || v === "no" || v === "off");
```


Run: `node --experimental-strip-types tests/harness.ts --suite=tools`
Expected: `[FAIL]` for `an unset or empty sandbox requirement refuses a backend that does not isolate, and nothing runs` and `with the requirement unset and no backend named, nothing runs unisolated`.
Revert: `git checkout -- src/sandbox.ts && git diff --exit-code`.

**Verifying isolation itself.** Nothing here proves bubblewrap confines: that cannot be tested on macOS (`CLAUDE.md`). CI's `probes` job does it on Linux with bubblewrap installed (`npm run probes`, `npm run probes:isolation`). If Docker is available, the owner can also run the command in `CLAUDE.md` ("Isolation cannot be tested on macOS") against this branch.

---

### Task 7: The talk allowlists fail closed (D2)

**Files:**
- Modify: `src/discord_ops.ts`, `src/slack_ops.ts`, `src/slack_runner.ts`, `src/discord_runner.ts`
- Modify: `tests/harness.ts`
- Modify: `deploy/SLACK.md`, `deploy/DISCORD.md`, `deploy/PILOT.md`, `deploy/systemd/README.md`, `deploy/systemd/env.example`

**Interfaces:**
- Consumes: `CONFIG_ENV_KEYS`, `freshDb`, `openChamberDb`, `pathToFileURL` (Task 5 added the import) in the harness.
- Produces: `slackTalkAllowlist(): Set<string>`, `canSlackTalk(userId: string): boolean`, `SLACK_TALK_REFUSAL` (`"You are not on CHAMBER_SLACK_ALLOWED_USERS."`) in `src/slack_ops.ts`; `discordTalkAllowlist(): Set<string>` in `src/discord_ops.ts`; `canDiscordTalk` now returns false for an empty list.

- [ ] **Step 1: Write the failing tests**

The Discord predicate test changes meaning (empty now denies) and a Slack predicate test is added:

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '  openSlackDb,' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  openSlackDb,
  postPendingWriteToOps,
} from "../src/slack_ops.ts";
```

Replace with:

```ts
  openSlackDb,
  postPendingWriteToOps,
  canSlackTalk,
  SLACK_TALK_REFUSAL,
} from "../src/slack_ops.ts";
```

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F 'test("discord", "D6_talk_allowlist", () => {' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
test("discord", "D6_talk_allowlist", () => {
  delete process.env.CHAMBER_DISCORD_ALLOWED_USERS;
  assert(canDiscordTalk("anyone"));
  process.env.CHAMBER_DISCORD_ALLOWED_USERS = "u1";
  assert(canDiscordTalk("u1"));
  assert(!canDiscordTalk("u2"));
  delete process.env.CHAMBER_DISCORD_ALLOWED_USERS;
});
```

Replace with:

```ts
test("discord", "D6_talk_allowlist", () => {
  // Fail closed: an empty list used to mean "anyone may talk to the bot".
  const savedPrimary = process.env.CHAMBER_DISCORD_ALLOWED_USERS;
  const savedLegacy = process.env.DISCORD_ALLOWED_USERS;
  try {
    delete process.env.CHAMBER_DISCORD_ALLOWED_USERS;
    delete process.env.DISCORD_ALLOWED_USERS;
    assert(!canDiscordTalk("anyone"), "an unset list means nobody may talk");
    process.env.CHAMBER_DISCORD_ALLOWED_USERS = "";
    assert(!canDiscordTalk("anyone"), "an empty list means nobody may talk");
    process.env.CHAMBER_DISCORD_ALLOWED_USERS = " , ";
    assert(!canDiscordTalk("anyone"), "a list of blanks means nobody may talk");
    process.env.CHAMBER_DISCORD_ALLOWED_USERS = "u1, u3 ,";
    assert(canDiscordTalk("u1"), "a listed user may talk");
    assert(canDiscordTalk("u3"), "entries are trimmed");
    assert(!canDiscordTalk("u2"), "an unlisted user may not");
    delete process.env.CHAMBER_DISCORD_ALLOWED_USERS;
    process.env.DISCORD_ALLOWED_USERS = "legacy1";
    assert(canDiscordTalk("legacy1"), "the legacy variable still works when the new one is unset");
  } finally {
    if (savedPrimary === undefined) delete process.env.CHAMBER_DISCORD_ALLOWED_USERS;
    else process.env.CHAMBER_DISCORD_ALLOWED_USERS = savedPrimary;
    if (savedLegacy === undefined) delete process.env.DISCORD_ALLOWED_USERS;
    else process.env.DISCORD_ALLOWED_USERS = savedLegacy;
  }
});

test("slack", "S_talk_allowlist_fails_closed", () => {
  const saved = process.env.CHAMBER_SLACK_ALLOWED_USERS;
  try {
    delete process.env.CHAMBER_SLACK_ALLOWED_USERS;
    assert(!canSlackTalk("U1"), "an unset list means nobody may talk");
    process.env.CHAMBER_SLACK_ALLOWED_USERS = "";
    assert(!canSlackTalk("U1"), "an empty list means nobody may talk");
    process.env.CHAMBER_SLACK_ALLOWED_USERS = " , ";
    assert(!canSlackTalk("U1"), "a list of blanks means nobody may talk");
    process.env.CHAMBER_SLACK_ALLOWED_USERS = "U1, U3 ,";
    assert(canSlackTalk("U1"), "a listed user may talk");
    assert(canSlackTalk("U3"), "entries are trimmed");
    assert(!canSlackTalk("U2"), "an unlisted user may not");
  } finally {
    if (saved === undefined) delete process.env.CHAMBER_SLACK_ALLOWED_USERS;
    else process.env.CHAMBER_SLACK_ALLOWED_USERS = saved;
  }
});
```

Then the runner tests. They write four small files to a temp directory: a resolution hook that points `@slack/bolt` and `discord.js` at stubs, a file that registers it, and the two stubs (which only record the handlers the runner registers). A driver script imports the real runner, calls the recorded handlers with fake events as a given user, and prints what the bot said. The tests then check that an empty list and an unlisted user are refused at every point (Slack: mention, DM, `/chamber`; Discord: DM, mention, `/chamber`, with silence in a free-response channel the bot was not addressed in), that no session was started for them, that a listed user is answered, and that each runner prints its startup warning only when its list is empty.

<!-- apply: replace tests/harness.ts -->
**Edit `tests/harness.ts`.** Find this text, which appears exactly once (`grep -n -F '// ─── report ──────────────────────────────────────────────────────────────────' tests/harness.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
// ─── report ──────────────────────────────────────────────────────────────────
```

Replace with:

```ts
// ─── THE RUNNERS ENFORCE THE TALK ALLOWLIST (slack_runner.ts, discord_runner.ts)

/*
 * The predicates above can be right while a runner never calls them: that is
 * how a guard written down is never reached. These tests run the real runner
 * modules. Their two dependencies, @slack/bolt and discord.js, are replaced by
 * stubs through a module-resolution hook (`--import` of a file that calls
 * `module.register`), so no network and no token is involved: each stub only
 * records the handlers the runner registers, and a driver script then calls
 * those handlers with fake events and prints what the bot said.
 */

const RUNNER_HOOKS = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@slack/bolt") {
    return { url: new URL("./bolt_stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  if (specifier === "discord.js") {
    return { url: new URL("./discord_stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

const RUNNER_REGISTER = `
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
`;

const BOLT_STUB = `
globalThis.__stub = { handlers: {} };
export class App {
  constructor(options) { globalThis.__stub.options = options; }
  event(name, fn) { globalThis.__stub.handlers["event:" + name] = fn; }
  message(fn) { globalThis.__stub.handlers.message = fn; }
  command(name, fn) { globalThis.__stub.handlers["command:" + name] = fn; }
  action(name, fn) { globalThis.__stub.handlers["action:" + name] = fn; }
  async start() {}
}
`;

const DISCORD_STUB = `
globalThis.__stub = { handlers: {} };
export const GatewayIntentBits = { Guilds: 1, GuildMessages: 2, GuildMessageReactions: 4, MessageContent: 8, DirectMessages: 16 };
export const Partials = { Channel: "Channel", Message: "Message", Reaction: "Reaction" };
export const Events = {
  ClientReady: "ready", Error: "error", ShardReconnecting: "shardReconnecting", ShardResume: "shardResume",
  MessageCreate: "messageCreate", InteractionCreate: "interactionCreate", MessageReactionAdd: "messageReactionAdd",
};
export const MessageFlags = { Ephemeral: 64 };
export const ActivityType = { Watching: 3 };
export const Routes = { applicationGuildCommands: () => "g", applicationCommands: () => "c" };
export class REST { setToken() { return this; } async put() {} }
export class SlashCommandBuilder {
  setName() { return this; }
  setDescription() { return this; }
  addStringOption(build) {
    build({ setName() { return this; }, setDescription() { return this; }, setRequired() { return this; } });
    return this;
  }
  toJSON() { return {}; }
}
export class Client {
  constructor() { this.user = { id: "UBOT", tag: "bot#0001" }; }
  once() {}
  on(event, fn) { globalThis.__stub.handlers[event] = fn; }
  async login() {}
}
`;

const SLACK_DRIVER = `
await import(process.env.RUNNER);
const deadline = Date.now() + 15000;
while (!globalThis.__stub.handlers["command:/chamber"] && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 25));
}
const h = globalThis.__stub.handlers;
const user = process.env.TEST_USER;
const said = [];
const say = async (m) => { said.push(m.text); };
const responded = [];
await h["event:app_mention"]({ event: { user, text: "<@UBOT> hello there", channel: "C1", ts: "1.1" }, say });
await h.message({ message: { channel_type: "im", user, text: "hello there", channel: "D1" }, say });
await h["command:/chamber"]({
  command: { user_id: user, channel_id: "C1", text: "status" },
  ack: async () => {},
  respond: async (m) => { responded.push(m.text); },
  client: { chat: { postMessage: async () => ({}) } },
});
console.log("DRIVE " + JSON.stringify({ said, responded }));
process.exit(0);
`;

const DISCORD_DRIVER = `
await import(process.env.RUNNER);
const deadline = Date.now() + 15000;
while (!globalThis.__stub.handlers.interactionCreate && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 25));
}
const h = globalThis.__stub.handlers;
const user = process.env.TEST_USER;
const out = [];
const channel = (id) => ({ id, sendTyping: async () => {}, send: async (o) => { out.push(o.content); } });
const message = (guild, channelId, mentioned) => ({
  author: { bot: false, id: user }, webhookId: null, system: false, guild,
  channel: channel(channelId), mentions: { has: () => mentioned },
  content: "hello there", attachments: new Map(),
  reply: async (o) => { out.push(o.content); },
});
await h.messageCreate(message(null, "D1", false));
const dm = out.splice(0);
await h.messageCreate(message({ id: "G1" }, "C1", true));
const mention = out.splice(0);
await h.messageCreate(message({ id: "G1" }, "C9", false));
const free = out.splice(0);
await h.interactionCreate({
  isChatInputCommand: () => true, commandName: "chamber", user: { id: user },
  options: { getString: () => "status" }, channelId: "C1", guild: null, channel: null,
  isButton: () => false,
  reply: async (o) => { out.push(o.content); },
  deferReply: async () => {},
  editReply: async (o) => { out.push(typeof o === "string" ? o : o.content); },
});
const slash = out.splice(0);
console.log("DRIVE " + JSON.stringify({ dm, mention, free, slash }));
process.exit(0);
`;

/** Run a real runner against the stubs; returns what the driver printed, stderr and how many sessions the database holds. */
function driveRunner(
  kind: "slack" | "discord",
  env: Record<string, string>,
  user: string,
): { drive: Record<string, string[]>; stderr: string; sessions: number } {
  const dir = mkdtempSync(join(tmpdir(), "chamber-runner-"));
  try {
    writeFileSync(join(dir, "hooks.mjs"), RUNNER_HOOKS);
    writeFileSync(join(dir, "register.mjs"), RUNNER_REGISTER);
    writeFileSync(join(dir, "bolt_stub.mjs"), BOLT_STUB);
    writeFileSync(join(dir, "discord_stub.mjs"), DISCORD_STUB);
    const driver = join(dir, "driver.mjs");
    writeFileSync(driver, kind === "slack" ? SLACK_DRIVER : DISCORD_DRIVER);
    const dbPath = join(dir, "runner.sqlite");
    const runner = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), `../src/${kind}_runner.ts`),
    ).href;
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of CONFIG_ENV_KEYS) delete base[key];
    for (const key of [
      "CHAMBER_SLACK_ALLOWED_USERS",
      "CHAMBER_DISCORD_ALLOWED_USERS",
      "DISCORD_ALLOWED_USERS",
      "CHAMBER_DISCORD_FREE_CHANNELS",
      "CHAMBER_SLACK_OPS_CHANNEL",
      "CHAMBER_DISCORD_OPS_CHANNEL",
    ]) {
      delete base[key];
    }
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--import", pathToFileURL(join(dir, "register.mjs")).href, driver],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...base,
          CHAMBER_DB: dbPath,
          SLACK_BOT_TOKEN: "stub-bot",
          SLACK_APP_TOKEN: "stub-app",
          DISCORD_BOT_TOKEN: "stub-bot",
          RUNNER: runner,
          TEST_USER: user,
          ...env,
        },
      },
    );
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("DRIVE "));
    assert(line !== undefined, `the driver printed no result (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
    const db = openChamberDb(dbPath);
    try {
      const sessions = (db.prepare(`SELECT COUNT(*) AS c FROM session`).get() as { c: number }).c;
      return {
        drive: JSON.parse(line.slice("DRIVE ".length)) as Record<string, string[]>,
        stderr: r.stderr ?? "",
        sessions,
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("slack", "the Slack runner refuses a user who is not on CHAMBER_SLACK_ALLOWED_USERS at mentions, DMs and /chamber", () => {
  const empty = driveRunner("slack", {}, "U_ANYONE");
  assert(
    /chamber: CHAMBER_SLACK_ALLOWED_USERS is empty, so nobody can talk to this bot/.test(empty.stderr),
    `an empty list must be announced at startup:\n${empty.stderr}`,
  );
  const unlisted = driveRunner("slack", { CHAMBER_SLACK_ALLOWED_USERS: "U_OK" }, "U_BAD");
  assert(
    !/is empty, so nobody/.test(unlisted.stderr),
    `a configured list must not print the empty-list warning:\n${unlisted.stderr}`,
  );
  for (const [label, run] of [["empty list", empty], ["unlisted user", unlisted]] as const) {
    assert(
      JSON.stringify(run.drive.said) === JSON.stringify([SLACK_TALK_REFUSAL, SLACK_TALK_REFUSAL]),
      `${label}: mention and DM must each be refused, got ${JSON.stringify(run.drive.said)}`,
    );
    assert(
      JSON.stringify(run.drive.responded) === JSON.stringify([SLACK_TALK_REFUSAL]),
      `${label}: /chamber must be refused, got ${JSON.stringify(run.drive.responded)}`,
    );
    assert(run.sessions === 0, `${label}: a refused user must not start a turn, ${run.sessions} session(s) exist`);
  }
  const listed = driveRunner("slack", { CHAMBER_SLACK_ALLOWED_USERS: "U_OK" }, "U_OK");
  assert(
    listed.drive.said!.length === 2 && listed.drive.said!.every((t) => t !== SLACK_TALK_REFUSAL && t.length > 0),
    `a listed user must be answered: ${JSON.stringify(listed.drive.said)}`,
  );
  assert(
    listed.drive.responded!.length === 1 && listed.drive.responded![0] !== SLACK_TALK_REFUSAL,
    `a listed user's /chamber must be answered: ${JSON.stringify(listed.drive.responded)}`,
  );
  assert(listed.sessions >= 1, "a listed user's mention must have run a turn");
});

test("discord", "the Discord runner refuses a user who is not on CHAMBER_DISCORD_ALLOWED_USERS at messages, mentions and /chamber", () => {
  const refusal = "You are not on `CHAMBER_DISCORD_ALLOWED_USERS`.";
  const env = { CHAMBER_DISCORD_FREE_CHANNELS: "C9" };
  const empty = driveRunner("discord", env, "u_anyone");
  assert(
    /chamber: CHAMBER_DISCORD_ALLOWED_USERS is empty, so nobody can talk to this bot/.test(empty.stderr),
    `an empty list must be announced at startup:\n${empty.stderr}`,
  );
  const unlisted = driveRunner("discord", { ...env, CHAMBER_DISCORD_ALLOWED_USERS: "u_ok" }, "u_bad");
  assert(
    !/is empty, so nobody/.test(unlisted.stderr),
    `a configured list must not print the empty-list warning:\n${unlisted.stderr}`,
  );
  for (const [label, run] of [["empty list", empty], ["unlisted user", unlisted]] as const) {
    assert(JSON.stringify(run.drive.dm) === JSON.stringify([refusal]), `${label}: DM got ${JSON.stringify(run.drive.dm)}`);
    assert(JSON.stringify(run.drive.mention) === JSON.stringify([refusal]), `${label}: mention got ${JSON.stringify(run.drive.mention)}`);
    assert(
      run.drive.free!.length === 0,
      `${label}: a free-channel message that did not address the bot must get no reply at all, got ${JSON.stringify(run.drive.free)}`,
    );
    assert(JSON.stringify(run.drive.slash) === JSON.stringify([refusal]), `${label}: /chamber got ${JSON.stringify(run.drive.slash)}`);
    assert(run.sessions === 0, `${label}: a refused user must not start a turn, ${run.sessions} session(s) exist`);
  }
  const listed = driveRunner("discord", { ...env, CHAMBER_DISCORD_ALLOWED_USERS: "u_ok" }, "u_ok");
  for (const key of ["dm", "mention", "free", "slash"] as const) {
    const got = listed.drive[key]!;
    assert(got.length >= 1 && got.every((t) => t !== refusal), `a listed user must be answered at ${key}: ${JSON.stringify(got)}`);
  }
  assert(listed.sessions >= 1, "a listed user's message must have run a turn");
});

// ─── report ──────────────────────────────────────────────────────────────────
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types tests/harness.ts --suite=slack`
Expected: `SyntaxError: The requested module '../src/slack_ops.ts' does not provide an export named ...` (`canSlackTalk` or `SLACK_TALK_REFUSAL`).

- [ ] **Step 3: Implement the predicates**

<!-- apply: replace src/discord_ops.ts -->
**Edit `src/discord_ops.ts`.** Find this text, which appears exactly once (`grep -n -F '/** Who may talk to the bot. Empty = allow all (pilot default). Set to restrict. */' src/discord_ops.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
/** Who may talk to the bot. Empty = allow all (pilot default). Set to restrict. */
export function canDiscordTalk(userId: string): boolean {
  const raw = process.env.CHAMBER_DISCORD_ALLOWED_USERS ?? process.env.DISCORD_ALLOWED_USERS ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (set.size === 0) return true; // open talk; approve still fail-closed
  return set.has(userId);
}
```

Replace with:

```ts
/**
 * The ids in `CHAMBER_DISCORD_ALLOWED_USERS` (or the older
 * `DISCORD_ALLOWED_USERS`, read only when the first is unset): a comma list,
 * entries trimmed, blanks dropped.
 */
export function discordTalkAllowlist(): Set<string> {
  const raw = process.env.CHAMBER_DISCORD_ALLOWED_USERS ?? process.env.DISCORD_ALLOWED_USERS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Who may talk to the bot. Fail-closed, like the approver list: an empty
 * allowlist means nobody. An empty list used to mean everybody, so a bot
 * invited to a server answered every member and a user who ran it as the
 * docs said ("empty = open") gave strangers a way to spend the model budget and
 * write observations into the ledger.
 */
export function canDiscordTalk(userId: string): boolean {
  return discordTalkAllowlist().has(userId);
}
```

<!-- apply: replace src/slack_ops.ts -->
**Edit `src/slack_ops.ts`.** Find this text, which appears exactly once (`grep -n -F 'export function slackScopeId(channelId: string, userId?: string): string {' src/slack_ops.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
export function slackScopeId(channelId: string, userId?: string): string {
```

Replace with:

```ts
/** What a user who is not on `CHAMBER_SLACK_ALLOWED_USERS` is told. */
export const SLACK_TALK_REFUSAL = "You are not on CHAMBER_SLACK_ALLOWED_USERS.";

/** The ids in `CHAMBER_SLACK_ALLOWED_USERS`: a comma list, entries trimmed, blanks dropped. */
export function slackTalkAllowlist(): Set<string> {
  return new Set(
    (process.env.CHAMBER_SLACK_ALLOWED_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Who may talk to the bot. Fail-closed, like `canSlackApprove`: an empty
 * allowlist means nobody. The Slack runner had no talk gate at all, so anyone in
 * a channel the bot was in could drive a turn.
 */
export function canSlackTalk(userId: string): boolean {
  return slackTalkAllowlist().has(userId);
}

export function slackScopeId(channelId: string, userId?: string): string {
```

- [ ] **Step 4: Enforce it in the Slack runner**

Three points, matching the three where the Discord runner enforces its gate: mentions, DMs, and `/chamber`. The approve and reject buttons keep the approver gate.

<!-- apply: replace src/slack_runner.ts -->
**Edit `src/slack_runner.ts`.** Find this text, which appears exactly once (`grep -n -F '  slackReject,' src/slack_runner.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  slackReject,
  canSlackApprove,
  registerSlackPendingHook,
} from "./slack_ops.ts";
```

Replace with:

```ts
  slackReject,
  canSlackApprove,
  canSlackTalk,
  slackTalkAllowlist,
  SLACK_TALK_REFUSAL,
  registerSlackPendingHook,
} from "./slack_ops.ts";
```

<!-- apply: replace src/slack_runner.ts -->
**Edit `src/slack_runner.ts`.** Find this text, which appears exactly once (`grep -n -F ' *   CHAMBER_DB, CHAMBER_SLACK_APPROVERS, CHAMBER_SLACK_OPS_CHANNEL' src/slack_runner.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
 *   CHAMBER_DB, CHAMBER_SLACK_APPROVERS, CHAMBER_SLACK_OPS_CHANNEL
 *
```

Replace with:

```ts
 *   CHAMBER_DB, CHAMBER_SLACK_APPROVERS, CHAMBER_SLACK_OPS_CHANNEL
 *   CHAMBER_SLACK_ALLOWED_USERS  (who may talk to the bot; empty = nobody)
 *
```

<!-- apply: replace src/slack_runner.ts -->
**Edit `src/slack_runner.ts`.** Find this text, which appears exactly once (`grep -n -F '  const db = openSlackDb();' src/slack_runner.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  const db = openSlackDb();
  registerSlackPendingHook();

  // ── Mentions → gated turn ─────────────────────────────────────────
  app.event("app_mention", async ({ event, say }) => {
    if ((event as { bot_id?: string }).bot_id) return;
    const text = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
```

Replace with:

```ts
  const db = openSlackDb();
  registerSlackPendingHook();
  if (slackTalkAllowlist().size === 0) {
    console.warn("chamber: CHAMBER_SLACK_ALLOWED_USERS is empty, so nobody can talk to this bot");
  }

  // ── Mentions → gated turn ─────────────────────────────────────────
  app.event("app_mention", async ({ event, say }) => {
    if ((event as { bot_id?: string }).bot_id) return;
    // Before anything is parsed or written. A mention is addressing the bot
    // directly, so a refused user is told why.
    if (!canSlackTalk(event.user ?? "unknown")) {
      await say({ text: SLACK_TALK_REFUSAL, thread_ts: event.thread_ts ?? event.ts });
      return;
    }
    const text = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
```

<!-- apply: replace src/slack_runner.ts -->
**Edit `src/slack_runner.ts`.** Find this text, which appears exactly once (`grep -n -F '    if (m.channel_type !== "im") return;' src/slack_runner.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
    if (m.channel_type !== "im") return;
    if (m.bot_id || m.subtype) return;
    const text = (m.text ?? "").trim();
```

Replace with:

```ts
    if (m.channel_type !== "im") return;
    if (m.bot_id || m.subtype) return;
    if (!canSlackTalk(m.user ?? "unknown")) {
      await say({ text: SLACK_TALK_REFUSAL });
      return;
    }
    const text = (m.text ?? "").trim();
```

<!-- apply: replace src/slack_runner.ts -->
**Edit `src/slack_runner.ts`.** Find this text, which appears exactly once (`grep -n -F '  app.command("/chamber", async ({ command, ack, respond, client }) => {' src/slack_runner.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  app.command("/chamber", async ({ command, ack, respond, client }) => {
    await ack();
    try {
```

Replace with:

```ts
  app.command("/chamber", async ({ command, ack, respond, client }) => {
    await ack();
    if (!canSlackTalk(command.user_id)) {
      await respond({ response_type: "ephemeral", text: SLACK_TALK_REFUSAL });
      return;
    }
    try {
```

- [ ] **Step 5: The Discord runner: the warning, and the header comment**

The runner already calls `canDiscordTalk` for messages and for `/chamber` and sends the refusal only to a user who addressed the bot (mention or DM); only the predicate and the startup line change.

<!-- apply: replace src/discord_runner.ts -->
**Edit `src/discord_runner.ts`.** Find this text, which appears exactly once (`grep -n -F ' *   CHAMBER_DISCORD_ALLOWED_USERS | DISCORD_ALLOWED_USERS  (talk restrict; empty=open)' src/discord_runner.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
 *   CHAMBER_DISCORD_ALLOWED_USERS | DISCORD_ALLOWED_USERS  (talk restrict; empty=open)
```

Replace with:

```ts
 *   CHAMBER_DISCORD_ALLOWED_USERS | DISCORD_ALLOWED_USERS  (who may talk; empty = nobody)
```

<!-- apply: replace src/discord_runner.ts -->
**Edit `src/discord_runner.ts`.** Find this text, which appears exactly once (`grep -n -F '  canDiscordApprove,' src/discord_runner.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  canDiscordApprove,
  canDiscordTalk,
  isDiscordFreeResponseChannel,
```

Replace with:

```ts
  canDiscordApprove,
  canDiscordTalk,
  discordTalkAllowlist,
  isDiscordFreeResponseChannel,
```

<!-- apply: replace src/discord_runner.ts -->
**Edit `src/discord_runner.ts`.** Find this text, which appears exactly once (`grep -n -F '  const db = openDiscordDb();' src/discord_runner.ts` finds its first line), and replace all of it with the new text.

Find:

```ts
  const db = openDiscordDb();
  registerDiscordPendingHook();
```

Replace with:

```ts
  const db = openDiscordDb();
  registerDiscordPendingHook();
  if (discordTalkAllowlist().size === 0) {
    console.warn("chamber: CHAMBER_DISCORD_ALLOWED_USERS is empty, so nobody can talk to this bot");
  }
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `node --experimental-strip-types tests/harness.ts --suite=slack` then `node --experimental-strip-types tests/harness.ts --suite=discord`
Expected: `slack` ends `── 7/7 passed · 0 failed ──` (five existing tests plus two new); `discord` ends `── 13/13 passed · 0 failed ──`.

- [ ] **Step 7: Documentation**

<!-- apply: replace deploy/SLACK.md -->
**Edit `deploy/SLACK.md`.** Find this text, which appears exactly once (`grep -n -F 'export CHAMBER_SLACK_APPROVERS=U0123ABCD,U0456EFGH   # fail-closed if empty' deploy/SLACK.md` finds its first line), and replace all of it with the new text.

Find:

```md
export CHAMBER_SLACK_APPROVERS=U0123ABCD,U0456EFGH   # fail-closed if empty
```

Replace with:

```md
export CHAMBER_SLACK_APPROVERS=U0123ABCD,U0456EFGH   # fail-closed if empty
export CHAMBER_SLACK_ALLOWED_USERS=U0123ABCD,U0456EFGH  # who may talk to the bot; empty = nobody
```

<!-- apply: replace deploy/SLACK.md -->
**Edit `deploy/SLACK.md`.** Find this text, which appears exactly once (`grep -n -F 'All turns and approves go through Chamber gates. Empty `CHAMBER_SLACK_APPROVERS` → approve always denied.' deploy/SLACK.md` finds its first line), and replace all of it with the new text.

Find:

```md
All turns and approves go through Chamber gates. Empty `CHAMBER_SLACK_APPROVERS` → approve always denied.
```

Replace with:

```md
All turns and approves go through Chamber gates. Empty `CHAMBER_SLACK_APPROVERS` → approve always denied.

**Who may talk.** `CHAMBER_SLACK_ALLOWED_USERS` is a comma list of Slack user ids. It is
fail-closed like the approver list: **empty means nobody**, and the runner logs
`chamber: CHAMBER_SLACK_ALLOWED_USERS is empty, so nobody can talk to this bot` at
startup. A user who is not listed gets `You are not on CHAMBER_SLACK_ALLOWED_USERS.` when
they mention the bot, DM it or run `/chamber`, and no turn is started. Being allowed to
talk does not make anyone an approver. Before this variable existed the Slack runner let
any user in a channel with the bot drive a turn, so an existing deployment answers
nobody until it is set.
```

<!-- apply: replace deploy/DISCORD.md -->
**Edit `deploy/DISCORD.md`.** Find this text, which appears exactly once (`grep -n -F 'export CHAMBER_DISCORD_APPROVERS=123,456  # Discord user snowflakes; fail-closed if empty' deploy/DISCORD.md` finds its first line), and replace all of it with the new text.

Find:

```md
export CHAMBER_DISCORD_APPROVERS=123,456  # Discord user snowflakes; fail-closed if empty
```

Replace with:

```md
export CHAMBER_DISCORD_APPROVERS=123,456  # Discord user snowflakes; fail-closed if empty
export CHAMBER_DISCORD_ALLOWED_USERS=123,456  # who may talk to the bot; empty = nobody
```

<!-- apply: replace deploy/DISCORD.md -->
**Edit `deploy/DISCORD.md`.** Find this text, which appears exactly once (`grep -n -F '| `CHAMBER_DISCORD_ALLOWED_USERS` | Restrict who can talk (empty = open) |' deploy/DISCORD.md` finds its first line), and replace all of it with the new text.

Find:

```md
| `CHAMBER_DISCORD_ALLOWED_USERS` | Restrict who can talk (empty = open) |
```

Replace with:

```md
| `CHAMBER_DISCORD_ALLOWED_USERS` | Who may talk to the bot. **Empty = nobody** (fail-closed; it used to mean everybody). The runner logs `chamber: CHAMBER_DISCORD_ALLOWED_USERS is empty, so nobody can talk to this bot` at startup. A listed user who is refused at a mention, a DM or `/chamber` is told so; a message in a free-response channel that did not address the bot gets no reply. |
```

<!-- apply: replace deploy/PILOT.md -->
**Edit `deploy/PILOT.md`.** Find this text, which appears exactly once (`grep -n -F 'export CHAMBER_SLACK_APPROVERS=U0123,U0456' deploy/PILOT.md` finds its first line), and replace all of it with the new text.

Find:

```md
export CHAMBER_SLACK_APPROVERS=U0123,U0456
```

Replace with:

```md
export CHAMBER_SLACK_APPROVERS=U0123,U0456
export CHAMBER_SLACK_ALLOWED_USERS=U0123,U0456        # empty = nobody can talk to the bot
```

<!-- apply: replace deploy/systemd/README.md -->
**Edit `deploy/systemd/README.md`.** Find this text, which appears exactly once (`grep -n -F 'CHAMBER_SLACK_APPROVERS=U...' deploy/systemd/README.md` finds its first line), and replace all of it with the new text.

Find:

```md
CHAMBER_SLACK_APPROVERS=U...
```

Replace with:

```md
CHAMBER_SLACK_APPROVERS=U...
CHAMBER_SLACK_ALLOWED_USERS=U...
```

<!-- apply: replace deploy/systemd/env.example -->
**Edit `deploy/systemd/env.example`.** Find this text, which appears exactly once (`grep -n -F 'CHAMBER_SLACK_APPROVERS=' deploy/systemd/env.example` finds its first line), and replace all of it with the new text.

Find:

```sh
CHAMBER_SLACK_APPROVERS=
```

Replace with:

```sh
CHAMBER_SLACK_APPROVERS=
# Who may talk to the Slack bot. Empty means nobody.
CHAMBER_SLACK_ALLOWED_USERS=
```

<!-- apply: replace deploy/systemd/env.example -->
**Edit `deploy/systemd/env.example`.** Find this text, which appears exactly once (`grep -n -F 'CHAMBER_DISCORD_APPROVERS=' deploy/systemd/env.example` finds its first line), and replace all of it with the new text.

Find:

```sh
CHAMBER_DISCORD_APPROVERS=
```

Replace with:

```sh
CHAMBER_DISCORD_APPROVERS=
# Who may talk to the Discord bot. Empty means nobody.
CHAMBER_DISCORD_ALLOWED_USERS=
```

- [ ] **Step 8: Gates**

Run: `npm run typecheck`, `npm run lint`, `npm test`.
Expected: clean; `npm test` ends `── 567/567 passed · 0 failed ──`.

- [ ] **Step 9: Commit**

```bash
git status --short
git add tests/harness.ts src/discord_ops.ts src/slack_ops.ts src/slack_runner.ts src/discord_runner.ts deploy/SLACK.md deploy/DISCORD.md deploy/PILOT.md deploy/systemd/README.md deploy/systemd/env.example
git commit -m "fix: make the talk allowlists fail closed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Mutation proofs**

Apply, run the stated suite, check, revert with `git checkout -- <file> && git diff --exit-code`.

(a) An empty Slack list means everybody again (file `src/slack_ops.ts`, `--suite=slack`). Mutation, in `src/slack_ops.ts`. Find:

```ts
  return slackTalkAllowlist().has(userId);
```

and replace it with:

```ts
  return slackTalkAllowlist().size === 0 || slackTalkAllowlist().has(userId);
```

Expected: `[FAIL]` for `slack/S_talk_allowlist_fails_closed` and for the runner test.

(b) The mention handler stops checking (file `src/slack_runner.ts`, `--suite=slack`). Mutation, in `src/slack_runner.ts`. Find:

```ts
    if (!canSlackTalk(event.user ?? "unknown")) {
```

and replace it with:

```ts
    if (false as boolean) {
```

Expected: only `slack/the Slack runner refuses a user who is not on CHAMBER_SLACK_ALLOWED_USERS at mentions, DMs and /chamber` fails.

(c) The slash command stops checking (file `src/slack_runner.ts`, `--suite=slack`). Mutation, in `src/slack_runner.ts`. Find:

```ts
    if (!canSlackTalk(command.user_id)) {
```

and replace it with:

```ts
    if (false as boolean) {
```

Expected: the same single test fails.

(d) The startup warning is gone (file `src/slack_runner.ts`, `--suite=slack`). Mutation, in `src/slack_runner.ts`. Find:

```ts
  if (slackTalkAllowlist().size === 0) {
```

and replace it with:

```ts
  if (false as boolean) {
```

Expected: the same single test fails.

(e) An empty Discord list means everybody again (file `src/discord_ops.ts`, `--suite=discord`). Mutation, in `src/discord_ops.ts`. Find:

```ts
  return discordTalkAllowlist().has(userId);
```

and replace it with:

```ts
  return discordTalkAllowlist().size === 0 || discordTalkAllowlist().has(userId);
```

Expected: `[FAIL]` for `discord/D6_talk_allowlist` and for the Discord runner test.

(f) The Discord slash command stops checking (file `src/discord_runner.ts`, `--suite=discord`). Mutation, in `src/discord_runner.ts`. Find:

```ts
      if (!canDiscordTalk(interaction.user.id)) {
```

and replace it with:

```ts
      if (false as boolean) {
```

Expected: only `discord/the Discord runner refuses a user who is not on CHAMBER_DISCORD_ALLOWED_USERS at messages, mentions and /chamber` fails.

---

### Task 8: Changelog and final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Changelog**

Both breaking changes (the sandbox default and the talk allowlists) are called out as breaking, as the spec requires:

<!-- apply: replace CHANGELOG.md -->
**Edit `CHANGELOG.md`.** Find this text, which appears exactly once (`grep -n -F '## 0.1.9 — 2026-10-03' CHANGELOG.md` finds its first line), and replace all of it with the new text.

Find:

```md
## 0.1.9 — 2026-10-03
```

Replace with:

```md
### Changed (breaking)

- **Tool code is refused unless something isolates it.** `CHAMBER_SANDBOX_REQUIRED`
  unset or empty used to mean "run it in a plain subprocess". It now means
  required: `tool-run`, `tool-synth`, `sandbox-test` and MCP tool verification
  run only under bubblewrap, and only after a probe shows that it confines.
  Anywhere without bubblewrap (macOS, most CI runners) they refuse, and the
  refusal ends with `Set CHAMBER_SANDBOX_REQUIRED=0 to run tool code without
  isolation.` `0`, `false`, `no` and `off` are the explicit opt-out.
- **The talk allowlists fail closed.** An empty `CHAMBER_DISCORD_ALLOWED_USERS`
  used to let every user talk to the Discord bot, and the Slack runner had no
  talk gate at all. Both now answer nobody until their list is set, and
  `CHAMBER_SLACK_ALLOWED_USERS` is new. Existing bots stop answering until the
  variable is set. Each runner logs one line at startup when its list is empty.
  Approver lists are unchanged.
- `POST /approve` and `POST /reject` record `decided_by = 'http'`. The `actor`
  field in the body is ignored; it used to be written as given, so a caller
  could sign its approval as `human` or `slack:U123`.
- A request body over 1 MiB is a 413, and a body that is not a JSON object is a
  400 `invalid_json` (it was a 500 carrying the parser's message). The cap is
  the `client_max_body_size 1m` that `deploy/nginx-chamber.conf` already sets in
  front of the server.

### Fixed

- **A stalled model no longer hangs the process.** Every model request now has
  a timeout: 180 s by default, `CHAMBER_MODEL_TIMEOUT_MS` to change it. A value
  that is not a whole number of milliseconds from 1 to 2147483647 is refused by
  name, never replaced by the default. The MCP server's queue moves on.
- **The HTTP server refuses a foreign `Host` when no token is set**, closing DNS
  rebinding against a loopback server. With a token set nothing changes.
- **A server error no longer sends its text to the client.** The body is
  `{"error":"internal_error","id":"..."}`; the cause and stack are on stderr
  beside the same id.
- **OAuth endpoints are checked on the parsed URL.** `http://127.0.0.1.evil.example`
  and `http://127.0.0.1@evil.example` used to pass as loopback.
- **The database file is `0600`.** A new one is created that way, in
  directories made `0700`; an existing one owned by you with group or other
  bits set is tightened, once, with a line on stderr. `-wal` and `-shm` follow.
- **No token, secret or body on a curl command line.** The MCP client, the
  OAuth client, and the Slack, Discord and Telegram calls pass the URL, headers
  and body to curl on stdin (`src/http_sync.ts`). The two gateway-runner calls
  that had no timeout now have 30 s.
- **`POST /turn` no longer stops the server.** It runs on a worker thread with
  its own connection to the same database, so `/health` answers while a turn
  waits on the embedder. Routes that need the write lock the turn holds now fail
  fast with a 500 instead of freezing; see `docs/KNOWN_LIMITATIONS.md` entry 21.

## 0.1.9 — 2026-10-03
```

- [ ] **Step 2: Commit the changelog**

```bash
git status --short
git add CHANGELOG.md
git commit -m "docs: changelog for runtime hardening

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
`git status --short` must have listed exactly ` M CHANGELOG.md`.

- [ ] **Step 3: Run every gate**

```bash
npm run typecheck
npm run lint
npm test
npm run probes
npm run demos
```
Expected: `typecheck` and `lint` print nothing past their command line; `npm test` ends `── 567/567 passed · 0 failed ──`; `npm run probes` and `npm run demos` exit 0. (`demos` is not in the four-gate list; it is run because demo 04 exercises the sandbox. On a machine without bubblewrap it shows the refusal branch.) If any is not green, quote the failing output and stop.

- [ ] **Step 4: Check the tree**

Run: `git status --short` (prints nothing), `ls dist 2>/dev/null` (prints nothing), `git log --oneline -9`.
Expected: eight new commits on top of `docs: record the runtime hardening design`, in task order.

- [ ] **Step 5: Report to the owner**

Report: the four gate results before Task 1 and after Task 8, the eight commit hashes, and the contention finding (only `/health` is guaranteed during a turn; `docs/KNOWN_LIMITATIONS.md` entry 21). Do not push: the push gate (review, audit, two secret scanners in both modes, owner approval) is the owner's.
