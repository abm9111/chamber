# Runtime hardening (audit groups A and D)

**Date:** 2026-10-21
**Status:** approved by the owner in chat, 2026-10-21
**Source:** the whole-repo VIGIL audit of `main` at ccdf148, run on 2026-10-21. Findings HIGH-3, M1, M2, M3, M4, M5 and M7 are fixed here, along with the Lows about `/approve`, the 500 body and the Discord allowlist, and the NEEDS_REVIEW event-loop block.
**Next step:** an implementation plan, then code. The choices below are closed.

One PR: `feat/runtime-hardening`.

## A1. Model calls time out

`src/model.ts` is the only `fetch` in `src/`. It gets an `AbortSignal.timeout(ms)`.

- `ms` comes from `CHAMBER_MODEL_TIMEOUT_MS`. The default is `180000`.
- A value that is not a string of digits, or that is `0`, is refused. The call throws an error that names the variable. The value is never silently replaced by the default.
- The same signal bounds reading the response body.
- On timeout the error message is `model endpoint <base> did not answer within <N> s (CHAMBER_MODEL_TIMEOUT_MS)`. Here `<N>` is `ms/1000`, rounded to at most one decimal place.
- Any other network error keeps its current message.
- `docs/KNOWN_LIMITATIONS.md` entry 4 is rewritten to say that the timeout exists, its default, and its variable.
- Test: a local server that accepts the request and never answers, with `CHAMBER_MODEL_TIMEOUT_MS=200`. `complete()` rejects within 2 s with the message above.
- Test: a second MCP request, queued behind the one that timed out, completes. The MCP server's serial queue must not stay wedged.

## A2. Host check when no token is set

`src/server.ts`. When `CHAMBER_API_TOKEN` is unset, every request must carry a `Host` header whose hostname is one of `127.0.0.1`, `localhost` or `[::1]`. Any port is allowed.

- The hostname is read by parsing `http://<Host>` with `URL`. If the parse fails, or the header is missing, the request is refused.
- A refused request gets 403 with body `{"error":"host_not_allowed"}`.
- The check runs first in the handler, before the OPTIONS branch, the Origin check and auth. It applies to every path, `/health` included.
- When `CHAMBER_API_TOKEN` is set, nothing changes. Proxies that pass `Host $host` keep working, and every proxy deployment in `deploy/` sets a token.
- Tests against the real server process:
  - With no token, `Host: attacker.example` on `GET /status` gives 403.
  - With no token, `Host: 127.0.0.1:<port>` and `Host: localhost:<port>` give 200.
  - With a token, `Host: chamber.example.com` plus a valid token gives 200.

## A3. Request bodies

`readBody` in `src/server.ts` caps the raw body at 1 MiB (1048576 bytes). The cap matches `client_max_body_size 1m` in `deploy/nginx-chamber.conf`.

- A `Content-Length` over the cap is refused before anything is read.
- A chunked body is refused as soon as the running total passes the cap. Chamber stops buffering at that point.
- A refused body gets 413 with `{"error":"payload_too_large","limit":1048576}` and `Connection: close`.
- A body that is not valid JSON gets 400 `{"error":"invalid_json"}`. So does valid JSON that is not an object: an array, a string, a number or null. An empty body is still `{}`.
- Tests against the real server: a 2 MiB `POST /turn` gives 413, and the server still answers the next request. `POST /approve` with `{` gives 400 `invalid_json`. With `[]` it also gives 400.

## A4. The 500 response

The handler's top-level `catch` writes one stderr line: `chamber server error <id>: <formatErrorChain(err)>`, followed by the stack.

- `<id>` is 8 hex characters from `crypto.randomUUID()`.
- The client gets 500 with `{"error":"internal_error","id":"<id>"}`. No error text goes into the response.
- Test: force a handler error and assert that the body is exactly that shape and that stderr contains the same id.

## A5. `/approve` and `/reject` take no actor from the caller

`decided_by` is the literal string `"http"` for both routes, and `body.actor` is ignored.

- The schema comment on `pending_write.decided_by` in `sql/schema_spend_approvals.sql` lists every value that is written: `human`, `auto_policy`, `http`, `slack:<id>`, `discord:<id>`. Changing only the comment needs no table rebuild.
- Test: `POST /approve` with `{"writeId":…, "actor":"admin"}` stores `decided_by = 'http'`.

## A6. OAuth endpoints use URL parsing

`requireHttps` in `src/mcp_oauth.ts` parses its argument with `URL`.

- `https:` passes.
- `http:` passes only when `isLoopbackBase(url)` from `src/config.ts` is true.
- Anything else, including a URL that does not parse, throws the existing message.
- `CHAMBER_OAUTH_ALLOW_HTTP=1` keeps its current meaning.
- Test:
  - `http://127.0.0.1.attacker.invalid/x` and `http://localhost.attacker.invalid/x` throw.
  - `http://127.0.0.1:9/x`, `http://localhost/x`, `http://[::1]/x` and `https://example.com/x` pass.

## A7. Database file permissions

`openChamberDb` in `src/db.ts`, for a file path. This excludes `":memory:"`, the existing blank-path guard, and `process.platform === "win32"`.

- **A database file that does not exist yet** is created with mode `0600` before SQLite opens it, using `openSync(path, "wx", 0o600)` and then close. SQLite then opens an existing file. SQLite creates `-wal` and `-shm` with the database file's mode.
- **A database file that exists** and is owned by `process.getuid()`, with any bit of `0o077` set, is chmod-ed to `0600`. Chamber prints one stderr line: `chamber: tightened <path> from <old octal> to 0600 (it holds note text and tokens)`.
  - Its existing `-wal` and `-shm` files get the same treatment, without extra lines.
  - A file owned by someone else is left alone with one stderr line saying so.
- **Directories Chamber creates** for the database are created with mode `0700`. Existing directories are not changed.
- Test: create a `0644` database, open it, and assert:
  - its mode is `0600`
  - exactly one notice line was printed
  - a second open prints nothing
  - a freshly created database is `0600` from the start

## A8. No secret on a command line

New module `src/http_sync.ts`. Every synchronous curl call that carries a secret goes through it. Its argv is a fixed set of flags, and everything that varies goes into a curl config read from stdin with `-K -`: the URL, the headers and the body.

- Config values are double-quoted. `\` becomes `\\`, `"` becomes `\"`, LF becomes `\n`, CR becomes `\r`, and TAB becomes `\t`.
- A NUL anywhere is refused.
- A CR or LF in a header name, a header value or the URL is refused before spawning. That would be header injection, so it is refused rather than escaped.
- Every call has a `-m` timeout.
- These sites move to it:
  - `src/mcp_client.ts` `httpPost` (Bearer token)
  - `src/mcp_oauth.ts` `httpGet` and `httpPostForm` (refresh token, client secret, auth code, code verifier)
  - `src/slack_ops.ts` (bot token)
  - `src/discord_ops.ts` (bot token)
  - `src/gateway.ts` (the Telegram token, which is in the URL)
  - `src/gateway_runner.ts`, both calls. Today neither has a `-m`; they get `-m 30`.
- `src/embedder.ts`'s Ollama calls carry no secret and stay as they are.
- Tests:
  - Unit: for each site's request shape, the argv contains no header value, body or URL. Every argv element is one of the helper's fixed flags.
  - Unit: a header value containing `\r\n` is refused before spawning.
  - Real path: a local HTTP server receives the `Authorization` header and a body containing `"`, `\`, a newline and a non-ASCII character, byte for byte.

## A9. `POST /turn` runs off the event loop

A single persistent worker thread, `src/turn_worker.ts`, runs `/turn` requests one at a time. It opens its own database connection to the same path. It applies config and the model environment the way the server does, registers the same pending-write hooks, and then runs the existing turn function. The main thread posts the request and awaits the reply. Every other route keeps answering while a turn runs.

- **FM-6 is unchanged.** The paraphrase check and the write stay in one `BEGIN IMMEDIATE` transaction inside the worker. `src/commit_belief.ts` is not modified.
- **Worker exit.** If the worker exits or throws outside a turn, the in-flight request gets the A4 500 shape. The worker is restarted for the next request.
- **Shared state.** Spend accounting and the approval queue live in the database, so the two connections share them. Any module-level in-memory state that `/turn` depends on must be found and handled in the plan, not assumed away.
- **Test, real server process:**
  - Set up an open blocking citation debt and a `CHAMBER_PYTHON` that sleeps 3 s before answering.
  - While a `POST /turn` that reaches the paraphrase check is running, `GET /health` answers within 500 ms.
  - The turn then completes with the normal shape.

## D1. The sandbox fails closed by default

`sandboxRequired()` in `src/sandbox.ts`:

- unset or empty: **required** (new default)
- `0`, `false`, `no`, `off` (case-insensitive, trimmed): not required, an explicit opt-out
- anything else: required

When required, tool code runs only under an isolating backend whose isolation probe holds. With bwrap present, the probe now runs every time it is required, which now includes the default.

When not required, behaviour is today's: a subprocess with a scrubbed environment.

The refusal message ends with `Set CHAMBER_SANDBOX_REQUIRED=0 to run tool code without isolation.`

Callers: `tool-run`, `tool-synth`, `sandbox-test`, and `verifyMcpToolSource`.

Tests:
- The harness tests that pin the old default are rewritten to the new one. These are around `T1_sandbox_self_test` and "an unset sandbox requirement still runs the subprocess fallback".
- A new test: with the variable unset on a host without bwrap, `runInSandbox` refuses and nothing runs.
- A new test: with `0`, the code runs.

Docs: README's sandbox section, `docs/KNOWN_LIMITATIONS.md` entry 1's paragraph on the default (the full rewrite of entry 1 is in the other PR), `SECURITY.md`, and CHANGELOG under Unreleased as a breaking change.

## D2. Talk allowlists fail closed

- **Discord.** `canDiscordTalk` in `src/discord_ops.ts`: an empty `CHAMBER_DISCORD_ALLOWED_USERS` (and empty `DISCORD_ALLOWED_USERS`) now means nobody may talk.
- **Slack.** New `canSlackTalk(userId)` in `src/slack_ops.ts`, reading `CHAMBER_SLACK_ALLOWED_USERS` (comma list, trimmed). Empty means nobody.
  - `src/slack_runner.ts` enforces it at every point where `src/discord_runner.ts` enforces the Discord gate: messages, mentions and slash commands.
  - A refused user gets `You are not on CHAMBER_SLACK_ALLOWED_USERS.`, and only when they addressed the bot directly. This mirrors Discord.
- **Startup warning.** Each runner logs one line when its list is empty: `chamber: <VAR> is empty, so nobody can talk to this bot`.
- **Approvals.** Approver lists are unchanged; they already fail closed.
- **Tests:**
  - The Discord `D6_talk_allowlist` test changes to: empty means deny, a listed user is allowed.
  - A Slack equivalent is added.
- **Docs:** `deploy/DISCORD.md`, `deploy/SLACK.md`, and CHANGELOG under Unreleased as a breaking change ("existing bots stop answering until the variable is set").

## Out of scope

The other PR (`feat/supply-chain-docs`) carries:
- dependency, Docker and CI changes
- bwrap namespace flags
- MiniLM hash check, version sites, systemd hardening
- pin follow-ups, daily snapshot, backup doc, and `KNOWN_LIMITATIONS` entries 1 and 3

## Verification

- Every fix comes with a test that fails when the fix is removed. Each one is proved once by removing the fix.
- Run the full gate: `npm run typecheck`, `npm run lint`, `npm test`, `npm run probes`.
- The server changes (A2, A3, A4, A9) are tested against the real server process, not by calling the handler.
