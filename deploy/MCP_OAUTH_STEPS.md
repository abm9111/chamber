# Chamber OAuth implementation steps (MCP 2026-07-28)

Goal: Chamber as an **OAuth 2.1 client** talking to protected MCP servers as **resource servers**, without weakening gates (import → pending → approve → call).

Spec anchors: OAuth 2.1, RFC 9728 (Protected Resource Metadata), RFC 8707 (resource indicators), RFC 9207 (`iss` validation), PKCE S256. DCR deprecated → prefer **CIMD** or pre-registered clients.

---

## Principles (non-negotiable)

1. Tokens are **per MCP server** (audience-bound). Never reuse one bearer across endpoints.
2. **No token passthrough** into tool arguments or model context.
3. OAuth success ≠ permission to call tools. Chamber still requires **active skill** (or explicit escape hatch).
4. Secrets live in env / OS keychain / `CHAMBER_DB`-adjacent sealed store — never in skill bodies or audit detail plaintext.
5. All auth events append to the **audit chain** (no token values logged).

---

## Phase 0 — Prerequisites (½ day)

| Step | Action | Done when |
|------|--------|-----------|
| 0.1 | Pick one protected MCP server with PRM at `{resource}/.well-known/oauth-protected-resource` | URL returns JSON |
| 0.2 | Register Chamber as OAuth client (manual or CIMD). Prefer **public client + PKCE** for CLI | `client_id` issued |
| 0.3 | Note scopes (e.g. `mcp:tools`) and resource identifier (server URL, trailing-slash normalized) | Written in env example |
| 0.4 | Confirm AS supports authorization code + PKCE S256 | Docs / discovery |

Env sketch:

```bash
CHAMBER_MCP_RESOURCE=https://mcp.example.com/mcp
CHAMBER_MCP_CLIENT_ID=chamber-cli
# optional confidential client only on server-side installs:
# CHAMBER_MCP_CLIENT_SECRET=...
CHAMBER_MCP_REDIRECT_URI=http://127.0.0.1:8765/callback
```

---

## Phase 1 — Discovery (1 day)

**Module:** `src/mcp_oauth.ts` (new)

| Step | Implement | Notes |
|------|-----------|-------|
| 1.1 | `fetchProtectedResourceMetadata(resourceUrl)` | GET `/.well-known/oauth-protected-resource` on resource |
| 1.2 | Read `authorization_servers[]`, `scopes_supported`, `resource` | Fail closed if missing AS |
| 1.3 | `fetchAuthorizationServerMetadata(issuer)` | RFC 8414 / OIDC discovery |
| 1.4 | Cache metadata in memory with TTL (e.g. 1h); never cache tokens there | |
| 1.5 | CLI: `chamber mcp-auth discover <resource-url>` | Prints AS, scopes, no secrets |

**Tests:** fixture JSON for PRM + AS metadata; reject HTTP (non-TLS) AS in production mode.

---

## Phase 2 — PKCE + authorization code (1–2 days)

| Step | Implement | Notes |
|------|-----------|-------|
| 2.1 | Generate `code_verifier` (43–128 chars), `code_challenge = BASE64URL(SHA256(verifier))` | S256 only |
| 2.2 | Build authorize URL: `client_id`, `redirect_uri`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`, **`resource`**, `scope`, `state` | Resource param mandatory |
| 2.3 | Local loopback listener on `CHAMBER_MCP_REDIRECT_URI` (8765) | One-shot; bind 127.0.0.1 only |
| 2.4 | Validate `state` on callback | CSRF |
| 2.5 | If AS returns `iss`, **MUST** validate equals expected issuer (RFC 9207) | Mix-up defense |
| 2.6 | Token request: `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, `resource`, client auth as registered | |
| 2.7 | Validate token response: store `access_token`, `refresh_token`, `expires_at`, **audience/resource** | Reject if resource mismatch when known |
| 2.8 | CLI: `chamber mcp-auth login <resource-url>` | Opens browser or prints URL |

**Storage:** table `mcp_oauth_token` (see Phase 5 schema). Encrypt at rest if possible (`CHAMBER_TOKEN_KEY`).

---

## Phase 3 — Refresh + logout (½–1 day)

| Step | Implement | Notes |
|------|-----------|-------|
| 3.1 | Before MCP HTTP call, if `expires_at < now+60s`, refresh | `grant_type=refresh_token` + `resource` |
| 3.2 | On refresh fail → mark token revoked, force re-login | Fail closed |
| 3.3 | `chamber mcp-auth logout <resource-url>` | Delete local tokens only (optional AS revoke if endpoint exists) |
| 3.4 | Never log refresh/access token material | Audit: `mcp_oauth_refresh`, `mcp_oauth_logout` |

---

## Phase 4 — Wire into MCP client (1 day)

**File:** `src/mcp_client.ts`

| Step | Change |
|------|--------|
| 4.1 | `httpPost` accepts optional `Authorization: Bearer` |
| 4.2 | `rpc(endpoint, …)` loads token for that resource; if 401 → try refresh once → retry → else throw `auth_required` |
| 4.3 | `mcpDiscover` / `mcpToolsList` / `mcpToolsCall` use resource-bound token only |
| 4.4 | `mcpImportRemoteTools` still writes **pending** skills; store `endpoint` + `resource` in body metadata |
| 4.5 | `mcpGatedCall` order: **(1)** skill active **(2)** valid token for resource **(3)** call |
| 4.6 | On schema pin (optional P1): hash `tools/list` at approve time; refuse call if list hash changed |

CLI:

```bash
chamber mcp-auth login https://mcp.example.com/mcp
chamber mcp-discover https://mcp.example.com/mcp
chamber mcp-import-remote https://mcp.example.com/mcp
chamber approve <writeId>
chamber mcp-call https://mcp.example.com/mcp tool_name '{"q":"…"}'
```

---

## Phase 5 — Schema + audit (½ day)

```sql
-- sql/schema_mcp_oauth.sql
CREATE TABLE IF NOT EXISTS mcp_oauth_token (
  resource_url      TEXT PRIMARY KEY,       -- normalized MCP resource
  issuer            TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  access_token_enc  TEXT NOT NULL,          -- encrypted or OS-backed ref
  refresh_token_enc TEXT,
  scopes            TEXT,
  expires_at        TEXT,
  token_type        TEXT DEFAULT 'Bearer',
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

Audit actions (no secret payloads):

- `mcp_oauth_login_start` / `mcp_oauth_login_ok` / `mcp_oauth_login_fail`
- `mcp_oauth_refresh` / `mcp_oauth_refresh_fail`
- `mcp_oauth_logout`
- existing `mcp_remote_import` / `mcp_tools_call`

Register schema in `src/db.ts` `SCHEMA_FILES`.

---

## Phase 6 — Hardening (1 day)

| Step | Control |
|------|---------|
| 6.1 | Production: refuse AS or resource over cleartext HTTP |
| 6.2 | Redirect URI allowlist: only `127.0.0.1` / `localhost` for CLI |
| 6.3 | Confidential client secret only via env on server installs — not in browser flows |
| 6.4 | Scope least privilege: request `mcp:tools` (or server-documented minimum) only |
| 6.5 | Rate-limit login attempts / lock resource after N refresh failures |
| 6.6 | Document: tool **descriptions are untrusted**; never inject raw list into system prompt without quarantine wrapper |
| 6.7 | Optional: CIMD document hosted at `https://chamber.example/.well-known/oauth-client` for AS that require it |

---

## Phase 7 — Tests (1 day)

| Test | Expect |
|------|--------|
| PRM parse fixture | AS list non-empty |
| PKCE challenge length/format | S256 |
| State mismatch | login aborted |
| Missing `resource` in authorize URL | builder fails |
| 401 then successful refresh | single retry |
| Call without active skill | refused (gate) |
| Call without token | `auth_required` |
| Token for resource A used on B | refused |
| Audit chain | login/call events present; no bearer in detail |

Harness suite name: `oauth` (soft-skip if no network).

---

## Out of scope (later)

| Item | Why later |
|------|-----------|
| Full EMA / ID-JAG enterprise path | Needs IdP partnership |
| Acting as MCP **server** with OAuth RS | Different product |
| DCR automatic registration | Deprecated; CIMD/pre-reg preferred |
| Putting refresh tokens in Telegram | Never |

---

## Suggested calendar

| Day | Deliverable |
|-----|-------------|
| 1 | Phase 0–1 discovery CLI |
| 2–3 | Phase 2 login + token store |
| 4 | Phase 3–4 wire client + gated call |
| 5 | Phase 5–7 schema, hardening, tests |

**MVP exit criteria:**  
`login → discover → import-remote (pending) → approve → mcp-call` works against one real protected server; logout clears tokens; audit has no secrets.

---

## Mapping to Chamber law

```text
OAuth proves: client may reach this MCP resource
Chamber proves: this tool may run in this session

Both required. Either alone is insufficient.
```
