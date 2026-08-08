/**
 * MCP OAuth 2.1 client (Phases 1–2) — Chamber as public client + PKCE.
 *
 * - Protected Resource Metadata (RFC 9728)
 * - Authorization Server Metadata (RFC 8414)
 * - Authorization code + PKCE S256
 * - resource parameter (RFC 8707)
 * - iss validation when present (RFC 9207)
 *
 * Tokens stored in mcp_oauth_token. Never write secrets to audit detail.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "./audit.ts";
import { canSealSecrets, sealSecret, openSecret } from "./secret_box.ts";

const META_TTL_MS = 60 * 60 * 1000;

/** Sequenced mocks: CHAMBER_OAUTH_REFRESH_MOCK_SEQUENCE=network,network,ok */
let _mockSeq: string[] | null = null;

function nextRefreshMock(): string | undefined {
  if (process.env.CHAMBER_OAUTH_REFRESH_MOCK_SEQUENCE) {
    if (!_mockSeq) {
      _mockSeq = process.env.CHAMBER_OAUTH_REFRESH_MOCK_SEQUENCE.split(",").map(
        (s) => s.trim(),
      );
    }
    if (_mockSeq.length > 0) return _mockSeq.shift();
  }
  return process.env.CHAMBER_OAUTH_REFRESH_MOCK;
}

/** Reset mock sequence (tests). */
export function resetRefreshMockSequence(): void {
  _mockSeq = null;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  raw: Record<string, unknown>;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  raw: Record<string, unknown>;
}

export interface StoredToken {
  resourceUrl: string;
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  scopes: string | null;
  tokenType: string;
  expiresAt: string | null;
}

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

function httpPostForm(
  url: string,
  fields: Record<string, string>,
): { status: number; body: string } {
  const data = Object.entries(fields)
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join("&");
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

/** Normalize resource URL for token key (strip trailing slash except root). */
export function normalizeResourceUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "") || "";
  return `${u.origin}${path}`;
}

function requireHttps(url: string, label: string): void {
  if (process.env.CHAMBER_OAUTH_ALLOW_HTTP === "1") return;
  if (!url.startsWith("https://") && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
    throw new Error(`${label} must be HTTPS (or set CHAMBER_OAUTH_ALLOW_HTTP=1 for lab)`);
  }
}

function cacheGet(db: DatabaseSync, key: string): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT body_json, expires_at FROM mcp_oauth_meta_cache WHERE key = ?`,
    )
    .get(key) as { body_json: string; expires_at: string | null } | undefined;
  if (!row) return null;
  if (row.expires_at && row.expires_at < new Date().toISOString()) return null;
  try {
    return JSON.parse(row.body_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function cacheSet(db: DatabaseSync, key: string, body: unknown): void {
  const expires = new Date(Date.now() + META_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO mcp_oauth_meta_cache (key, body_json, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET body_json = excluded.body_json, expires_at = excluded.expires_at,
       fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(key, JSON.stringify(body), expires);
}

function wellKnownPrmUrl(resourceUrl: string): string {
  const u = new URL(resourceUrl);
  // RFC 9728: insert /.well-known/oauth-protected-resource before path or at root
  const path = u.pathname.replace(/\/+$/, "");
  if (!path || path === "") {
    return `${u.origin}/.well-known/oauth-protected-resource`;
  }
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

export function fetchProtectedResourceMetadata(
  db: DatabaseSync,
  resourceUrl: string,
): ProtectedResourceMetadata {
  requireHttps(resourceUrl, "resource");
  const key = `prm:${normalizeResourceUrl(resourceUrl)}`;
  const cached = cacheGet(db, key);
  const raw = cached ?? (() => {
    const urls = [
      wellKnownPrmUrl(resourceUrl),
      `${new URL(resourceUrl).origin}/.well-known/oauth-protected-resource`,
    ];
    let lastErr = "PRM fetch failed";
    for (const url of urls) {
      const res = httpGet(url);
      if (res.status >= 200 && res.status < 300) {
        const j = JSON.parse(res.body) as Record<string, unknown>;
        cacheSet(db, key, j);
        return j;
      }
      lastErr = `PRM HTTP ${res.status} at ${url}`;
    }
    throw new Error(lastErr);
  })();

  const servers = (raw.authorization_servers as string[]) ?? [];
  if (!servers.length) {
    throw new Error("PRM missing authorization_servers");
  }
  return {
    resource: String(raw.resource ?? normalizeResourceUrl(resourceUrl)),
    authorization_servers: servers,
    scopes_supported: raw.scopes_supported as string[] | undefined,
    bearer_methods_supported: raw.bearer_methods_supported as string[] | undefined,
    raw,
  };
}

export function fetchAuthorizationServerMetadata(
  db: DatabaseSync,
  issuer: string,
): AuthorizationServerMetadata {
  requireHttps(issuer, "authorization server");
  const key = `as:${issuer.replace(/\/+$/, "")}`;
  const cached = cacheGet(db, key);
  const raw = cached ?? (() => {
    const base = issuer.replace(/\/+$/, "");
    const urls = [
      `${base}/.well-known/oauth-authorization-server`,
      `${base}/.well-known/openid-configuration`,
    ];
    let lastErr = "AS metadata fetch failed";
    for (const url of urls) {
      const res = httpGet(url);
      if (res.status >= 200 && res.status < 300) {
        const j = JSON.parse(res.body) as Record<string, unknown>;
        cacheSet(db, key, j);
        return j;
      }
      lastErr = `AS HTTP ${res.status} at ${url}`;
    }
    throw new Error(lastErr);
  })();

  const authorization_endpoint = String(raw.authorization_endpoint ?? "");
  const token_endpoint = String(raw.token_endpoint ?? "");
  if (!authorization_endpoint || !token_endpoint) {
    throw new Error("AS metadata missing authorization_endpoint or token_endpoint");
  }
  return {
    issuer: String(raw.issuer ?? issuer),
    authorization_endpoint,
    token_endpoint,
    registration_endpoint: raw.registration_endpoint
      ? String(raw.registration_endpoint)
      : undefined,
    code_challenge_methods_supported:
      raw.code_challenge_methods_supported as string[] | undefined,
    raw,
  };
}

export function discoverMcpOAuth(
  db: DatabaseSync,
  resourceUrl: string,
): {
  prm: ProtectedResourceMetadata;
  as: AuthorizationServerMetadata;
} {
  const prm = fetchProtectedResourceMetadata(db, resourceUrl);
  const as = fetchAuthorizationServerMetadata(db, prm.authorization_servers[0]!);
  appendAudit(db, {
    category: "security",
    action: "mcp_oauth_discover",
    actor: "system",
    detail: {
      resource: normalizeResourceUrl(resourceUrl),
      issuer: as.issuer,
      scopes: prm.scopes_supported ?? null,
    },
  });
  return { prm, as };
}

// ─── PKCE ────────────────────────────────────────────────────────────────────

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope?: string;
  state: string;
  codeChallenge: string;
}): string {
  const u = new URL(opts.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("resource", opts.resource);
  if (opts.scope) u.searchParams.set("scope", opts.scope);
  return u.toString();
}

export function exchangeAuthorizationCode(
  db: DatabaseSync,
  opts: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
    issuer: string;
    expectedIss?: string;
    issFromCallback?: string;
  },
): StoredToken {
  if (opts.issFromCallback && opts.expectedIss) {
    if (opts.issFromCallback !== opts.expectedIss) {
      throw new Error(
        `iss mismatch: got ${opts.issFromCallback} expected ${opts.expectedIss}`,
      );
    }
  }

  const fields: Record<string, string> = {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
    resource: opts.resource,
  };
  if (opts.clientSecret) fields.client_secret = opts.clientSecret;

  const res = httpPostForm(opts.tokenEndpoint, fields);
  if (res.status < 200 || res.status >= 300) {
    appendAudit(db, {
      category: "security",
      action: "mcp_oauth_login_fail",
      actor: "system",
      detail: { status: res.status, resource: opts.resource },
    });
    throw new Error(`token endpoint HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const tok = JSON.parse(res.body) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  if (!tok.access_token) throw new Error("token response missing access_token");

  const expiresAt =
    tok.expires_in != null
      ? new Date(Date.now() + tok.expires_in * 1000).toISOString()
      : null;

  const resourceUrl = normalizeResourceUrl(opts.resource);
  const stored = persistToken(db, {
    resourceUrl,
    issuer: opts.issuer,
    clientId: opts.clientId,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? null,
    scopes: tok.scope ?? null,
    tokenType: tok.token_type ?? "Bearer",
    expiresAt,
  });

  appendAudit(db, {
    category: "security",
    action: "mcp_oauth_login_ok",
    actor: "human",
    detail: {
      resource: resourceUrl,
      issuer: opts.issuer,
      expires_at: expiresAt,
      has_refresh: !!tok.refresh_token,
    },
  });

  return stored;
}

export function getStoredToken(
  db: DatabaseSync,
  resourceUrl: string,
): StoredToken | null {
  const row = db
    .prepare(
      `SELECT resource_url AS resourceUrl, issuer, client_id AS clientId,
              access_token AS accessToken, refresh_token AS refreshToken,
              scopes, token_type AS tokenType, expires_at AS expiresAt
       FROM mcp_oauth_token WHERE resource_url = ?`,
    )
    .get(normalizeResourceUrl(resourceUrl)) as StoredToken | undefined;
  if (!row) return null;
  try {
    return {
      ...row,
      accessToken: openSecret(row.accessToken),
      refreshToken: row.refreshToken ? openSecret(row.refreshToken) : null,
    };
  } catch (e) {
    appendAudit(db, {
      category: "security",
      action: "mcp_oauth_decrypt_fail",
      actor: "system",
      detail: {
        resource: normalizeResourceUrl(resourceUrl),
        error: String(e).slice(0, 120),
      },
    });
    return null;
  }
}

export function deleteStoredToken(db: DatabaseSync, resourceUrl: string): boolean {
  const r = db
    .prepare(`DELETE FROM mcp_oauth_token WHERE resource_url = ?`)
    .run(normalizeResourceUrl(resourceUrl));
  appendAudit(db, {
    category: "security",
    action: "mcp_oauth_logout",
    actor: "human",
    detail: { resource: normalizeResourceUrl(resourceUrl) },
  });
  return Number(r.changes ?? 0) > 0;
}

function persistToken(
  db: DatabaseSync,
  opts: {
    resourceUrl: string;
    issuer: string;
    clientId: string;
    accessToken: string;
    refreshToken: string | null;
    scopes: string | null;
    tokenType: string;
    expiresAt: string | null;
  },
): StoredToken {
  const resourceUrl = normalizeResourceUrl(opts.resourceUrl);
  db.prepare(
    `INSERT INTO mcp_oauth_token (
       resource_url, issuer, client_id, access_token, refresh_token,
       scopes, token_type, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(resource_url) DO UPDATE SET
       issuer = excluded.issuer,
       client_id = excluded.client_id,
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, mcp_oauth_token.refresh_token),
       scopes = excluded.scopes,
       token_type = excluded.token_type,
       expires_at = excluded.expires_at,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(
    resourceUrl,
    opts.issuer,
    opts.clientId,
    sealSecret(opts.accessToken),
    opts.refreshToken != null ? sealSecret(opts.refreshToken) : null,
    opts.scopes,
    opts.tokenType,
    opts.expiresAt,
  );
  return {
    resourceUrl,
    issuer: opts.issuer,
    clientId: opts.clientId,
    accessToken: opts.accessToken,
    refreshToken: opts.refreshToken,
    scopes: opts.scopes,
    tokenType: opts.tokenType,
    expiresAt: opts.expiresAt,
  };
}

function isExpiringSoon(expiresAt: string | null, skewMs = 60_000): boolean {
  if (!expiresAt) return false; // no expiry claimed — treat as valid until 401
  return expiresAt < new Date(Date.now() + skewMs).toISOString();
}

/** Classified refresh outcomes — permanent failures clear tokens; transient keep them. */
export type RefreshErrorCode =
  | "no_token"
  | "no_refresh_token"
  | "as_metadata"
  | "network"
  | "http_error"
  | "invalid_grant"
  | "invalid_client"
  | "invalid_scope"
  | "unauthorized_client"
  | "server_error"
  | "invalid_response"
  | "missing_access_token"
  /**
   * The refresh was refused *before* contacting the token endpoint, because
   * the result could not have been stored. Distinct from every other code
   * here: nothing was spent, and the existing refresh token is still valid.
   */
  | "no_token_key";

export interface RefreshResultOk {
  ok: true;
  token: StoredToken;
}

export interface RefreshResultErr {
  ok: false;
  code: RefreshErrorCode;
  /** Permanent → tokens cleared, must re-login. Transient → retry later. */
  permanent: boolean;
  httpStatus?: number;
  oauthError?: string;
  message: string;
}

export type RefreshResult = RefreshResultOk | RefreshResultErr;

const PERMANENT_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
]);

export function formatRefreshError(err: RefreshResultErr): string {
  const base = `[${err.code}] ${err.message}`;
  if (err.permanent) {
    return `${base} — run: chamber mcp-auth login <resource-url>`;
  }
  return `${base} — transient; tokens kept, retry later`;
}

function classifyHttpRefreshFailure(
  status: number,
  body: string,
): Pick<RefreshResultErr, "code" | "permanent" | "oauthError" | "message"> {
  let oauthError: string | undefined;
  let oauthDesc: string | undefined;
  try {
    const j = JSON.parse(body) as {
      error?: string;
      error_description?: string;
    };
    oauthError = j.error;
    oauthDesc = j.error_description;
  } catch {
    /* non-JSON body */
  }

  if (oauthError && PERMANENT_OAUTH_ERRORS.has(oauthError)) {
    return {
      code: oauthError as RefreshErrorCode,
      permanent: true,
      oauthError,
      message: oauthDesc || `AS rejected refresh (${oauthError})`,
    };
  }
  if (status === 0) {
    return {
      code: "network",
      permanent: false,
      message: "token endpoint unreachable",
    };
  }
  if (status >= 500 || status === 429) {
    return {
      code: "server_error",
      permanent: false,
      oauthError,
      message: oauthDesc || `token endpoint HTTP ${status}`,
    };
  }
  if (status === 400 || status === 401) {
    // Ambiguous without oauth error — treat as permanent to avoid infinite 401 loops
    return {
      code: oauthError === "invalid_grant" ? "invalid_grant" : "http_error",
      permanent: true,
      oauthError,
      message: oauthDesc || `token endpoint HTTP ${status}`,
    };
  }
  return {
    code: "http_error",
    permanent: status >= 400 && status < 500,
    oauthError,
    message: oauthDesc || `token endpoint HTTP ${status}`,
  };
}

function auditRefreshFail(
  db: DatabaseSync,
  resource: string,
  err: Omit<RefreshResultErr, "ok">,
): void {
  appendAudit(db, {
    category: "security",
    action: "mcp_oauth_refresh_fail",
    actor: "system",
    detail: {
      resource,
      code: err.code,
      permanent: err.permanent,
      httpStatus: err.httpStatus ?? null,
      oauthError: err.oauthError ?? null,
      // message only — never tokens
      message: err.message.slice(0, 200),
    },
  });
}

/**
 * Refresh access token using stored refresh_token + resource indicator.
 *
 * Permanent failures (invalid_grant, invalid_client, …): clear tokens.
 * Transient failures (network, 5xx, 429): keep tokens for retry.
 *
 * Lab: CHAMBER_OAUTH_REFRESH_MOCK=ok|fail|network|invalid_grant
 */
export function refreshAccessTokenDetailed(
  db: DatabaseSync,
  resourceUrl: string,
  opts: {
    clientSecret?: string;
    tokenEndpoint?: string;
  } = {},
): RefreshResult {
  const normalized = normalizeResourceUrl(resourceUrl);
  const existing = getStoredToken(db, normalized);

  if (!existing) {
    const err: RefreshResultErr = {
      ok: false,
      code: "no_token",
      permanent: true,
      message: "no stored OAuth token for resource",
    };
    auditRefreshFail(db, normalized, err);
    return err;
  }
  // Checked before the network call, because the token endpoint rotates and
  // invalidates the old refresh token the moment it answers. `sealSecret`
  // throws when no CHAMBER_TOKEN_KEY is configured, and `persistToken` — its
  // only caller — has no catch, so a failure at *write* time meant the grant
  // had already been spent: the provider had issued new tokens, the old
  // refresh token was dead, nothing was stored, and no retry could ever
  // succeed. The connection was unrecoverable, with no RefreshResultErr and no
  // audit row to say why.
  //
  // Refusing here costs one expired access token and leaves the stored refresh
  // token intact, so the operator can set the key and try again.
  if (!canSealSecrets()) {
    const err: RefreshResultErr = {
      ok: false,
      code: "no_token_key",
      permanent: true,
      message:
        "refusing to refresh: the new tokens could not be stored. Set " +
        "CHAMBER_TOKEN_KEY to encrypt them at rest, or " +
        "CHAMBER_ALLOW_PLAINTEXT_SECRETS=1 to accept plaintext storage. " +
        "The existing refresh token has been left untouched.",
    };
    auditRefreshFail(db, normalized, err);
    return err;
  }
  if (!existing.refreshToken) {
    const err: RefreshResultErr = {
      ok: false,
      code: "no_refresh_token",
      permanent: true,
      message: "access token expired and no refresh_token stored",
    };
    auditRefreshFail(db, normalized, err);
    deleteStoredToken(db, normalized);
    return err;
  }

  // Offline mocks for harness (single or sequenced via CHAMBER_OAUTH_REFRESH_MOCK_SEQUENCE)
  const mock = nextRefreshMock();
  if (mock === "ok") {
    const next = persistToken(db, {
      resourceUrl: normalized,
      issuer: existing.issuer,
      clientId: existing.clientId,
      accessToken: `refreshed_${Date.now()}`,
      refreshToken: existing.refreshToken,
      scopes: existing.scopes,
      tokenType: existing.tokenType,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    appendAudit(db, {
      category: "security",
      action: "mcp_oauth_refresh",
      actor: "system",
      detail: { resource: normalized, mock: true },
    });
    return { ok: true, token: next };
  }
  if (mock === "fail" || mock === "invalid_grant") {
    const err: RefreshResultErr = {
      ok: false,
      code: "invalid_grant",
      permanent: true,
      oauthError: "invalid_grant",
      message: "mock: refresh token rejected",
    };
    auditRefreshFail(db, normalized, err);
    deleteStoredToken(db, normalized);
    return err;
  }
  if (mock === "network") {
    const err: RefreshResultErr = {
      ok: false,
      code: "network",
      permanent: false,
      message: "mock: token endpoint unreachable",
    };
    auditRefreshFail(db, normalized, err);
    return err;
  }

  let tokenEndpoint = opts.tokenEndpoint;
  if (!tokenEndpoint) {
    try {
      const as = fetchAuthorizationServerMetadata(db, existing.issuer);
      tokenEndpoint = as.token_endpoint;
    } catch (e) {
      const err: RefreshResultErr = {
        ok: false,
        code: "as_metadata",
        permanent: false, // AS discovery flake — keep tokens
        message: `AS metadata failed: ${String(e).slice(0, 120)}`,
      };
      auditRefreshFail(db, normalized, err);
      return err;
    }
  }

  const fields: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: existing.refreshToken,
    client_id: existing.clientId,
    resource: normalized,
  };
  const secret = opts.clientSecret ?? process.env.CHAMBER_MCP_CLIENT_SECRET;
  if (secret) fields.client_secret = secret;

  let res: { status: number; body: string };
  try {
    res = httpPostForm(tokenEndpoint, fields);
  } catch (e) {
    const err: RefreshResultErr = {
      ok: false,
      code: "network",
      permanent: false,
      message: `token request failed: ${String(e).slice(0, 120)}`,
    };
    auditRefreshFail(db, normalized, err);
    return err;
  }

  // curl-style: status 0 → network
  if (!res.status) {
    const err: RefreshResultErr = {
      ok: false,
      code: "network",
      permanent: false,
      httpStatus: 0,
      message: "token endpoint unreachable or empty response",
    };
    auditRefreshFail(db, normalized, err);
    return err;
  }

  if (res.status < 200 || res.status >= 300) {
    const classified = classifyHttpRefreshFailure(res.status, res.body);
    const err: RefreshResultErr = {
      ok: false,
      ...classified,
      httpStatus: res.status,
    };
    auditRefreshFail(db, normalized, err);
    if (err.permanent) deleteStoredToken(db, normalized);
    return err;
  }

  let tok: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  try {
    tok = JSON.parse(res.body) as typeof tok;
  } catch {
    const err: RefreshResultErr = {
      ok: false,
      code: "invalid_response",
      permanent: false,
      httpStatus: res.status,
      message: "token response is not valid JSON",
    };
    auditRefreshFail(db, normalized, err);
    return err;
  }
  if (!tok.access_token) {
    const err: RefreshResultErr = {
      ok: false,
      code: "missing_access_token",
      permanent: true,
      httpStatus: res.status,
      message: "token response missing access_token",
    };
    auditRefreshFail(db, normalized, err);
    deleteStoredToken(db, normalized);
    return err;
  }

  const expiresAt =
    tok.expires_in != null
      ? new Date(Date.now() + tok.expires_in * 1000).toISOString()
      : null;

  const next = persistToken(db, {
    resourceUrl: normalized,
    issuer: existing.issuer,
    clientId: existing.clientId,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? existing.refreshToken,
    scopes: tok.scope ?? existing.scopes,
    tokenType: tok.token_type ?? existing.tokenType,
    expiresAt,
  });

  appendAudit(db, {
    category: "security",
    action: "mcp_oauth_refresh",
    actor: "system",
    detail: {
      resource: normalized,
      expires_at: expiresAt,
      rotated_refresh: !!tok.refresh_token,
    },
  });
  return { ok: true, token: next };
}

/** Convenience: token or null (legacy callers). Prefer refreshAccessTokenDetailed. */
export function refreshAccessToken(
  db: DatabaseSync,
  resourceUrl: string,
  opts: {
    clientSecret?: string;
    tokenEndpoint?: string;
  } = {},
): StoredToken | null {
  const r = refreshAccessTokenWithRetry(db, resourceUrl, opts);
  return r.ok ? r.token : null;
}

export interface RefreshRetryOptions {
  /** Total attempts including the first (default 3) */
  maxAttempts?: number;
  /** Initial backoff ms (default 100; tests can set 0) */
  baseDelayMs?: number;
  /** Cap backoff ms (default 2000) */
  maxDelayMs?: number;
}

export type RefreshResultWithAttempts = RefreshResult & { attempts: number };

function sleepMs(ms: number): void {
  if (ms <= 0) return;
  spawnSync("sleep", [String(ms / 1000)], { stdio: "ignore" });
}

/**
 * Retry refresh only on transient errors (permanent=false).
 * Permanent failures return immediately with no further attempts.
 */
export function refreshAccessTokenWithRetry(
  db: DatabaseSync,
  resourceUrl: string,
  opts: {
    clientSecret?: string;
    tokenEndpoint?: string;
  } & RefreshRetryOptions = {},
): RefreshResultWithAttempts {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs =
    opts.baseDelayMs ??
    (process.env.CHAMBER_OAUTH_RETRY_DELAY_MS
      ? Number(process.env.CHAMBER_OAUTH_RETRY_DELAY_MS)
      : 100);
  const maxDelayMs = opts.maxDelayMs ?? 2000;

  let last: RefreshResult = {
    ok: false,
    code: "network",
    permanent: false,
    message: "no attempt",
  };
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts++;
    last = refreshAccessTokenDetailed(db, resourceUrl, opts);
    if (last.ok) {
      if (attempts > 1) {
        appendAudit(db, {
          category: "security",
          action: "mcp_oauth_refresh_retry_ok",
          actor: "system",
          detail: {
            resource: normalizeResourceUrl(resourceUrl),
            attempts,
          },
        });
      }
      return { ...last, attempts };
    }
    // Permanent → stop immediately
    if (last.permanent) {
      return { ...last, attempts };
    }
    // Transient → backoff then retry
    if (i < maxAttempts - 1) {
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** i);
      appendAudit(db, {
        category: "security",
        action: "mcp_oauth_refresh_retry",
        actor: "system",
        detail: {
          resource: normalizeResourceUrl(resourceUrl),
          attempt: attempts,
          nextDelayMs: delay,
          code: last.code,
        },
      });
      sleepMs(delay);
    }
  }

  appendAudit(db, {
    category: "security",
    action: "mcp_oauth_refresh_retry_exhausted",
    actor: "system",
    detail: {
      resource: normalizeResourceUrl(resourceUrl),
      attempts,
      code: !last.ok ? last.code : null,
    },
  });
  return { ...last, attempts };
}

export interface EnsureTokenResult {
  token: string | null;
  /** Set when a refresh was attempted and failed */
  refreshError?: RefreshResultErr;
  attempts?: number;
}

/**
 * Return a usable access token: valid as-is, or refreshed (with transient retries).
 */
export function ensureAccessTokenDetailed(
  db: DatabaseSync,
  resourceUrl: string,
  retryOpts?: RefreshRetryOptions,
): EnsureTokenResult {
  const normalized = normalizeResourceUrl(resourceUrl);
  const existing = getStoredToken(db, normalized);
  if (!existing) {
    return {
      token: null,
      refreshError: {
        ok: false,
        code: "no_token",
        permanent: true,
        message: "no stored OAuth token for resource",
      },
      attempts: 0,
    };
  }

  if (!isExpiringSoon(existing.expiresAt)) {
    return { token: existing.accessToken, attempts: 0 };
  }

  if (existing.refreshToken) {
    const refreshed = refreshAccessTokenWithRetry(db, normalized, retryOpts);
    if (refreshed.ok) {
      return { token: refreshed.token.accessToken, attempts: refreshed.attempts };
    }
    return {
      token: null,
      refreshError: refreshed,
      attempts: refreshed.attempts,
    };
  }

  if (isExpiringSoon(existing.expiresAt, 0)) {
    return {
      token: null,
      refreshError: {
        ok: false,
        code: "no_refresh_token",
        permanent: true,
        message: "access token expired and no refresh_token stored",
      },
      attempts: 0,
    };
  }
  return { token: existing.accessToken, attempts: 0 };
}

/** Return a usable access token: valid as-is, or refreshed. */
export function ensureAccessToken(
  db: DatabaseSync,
  resourceUrl: string,
): string | null {
  return ensureAccessTokenDetailed(db, resourceUrl).token;
}

/** @deprecated prefer ensureAccessToken — kept for callers that only want non-expired without refresh */
export function getAccessTokenIfValid(
  db: DatabaseSync,
  resourceUrl: string,
): string | null {
  const t = getStoredToken(db, resourceUrl);
  if (!t) return null;
  if (isExpiringSoon(t.expiresAt)) return null;
  return t.accessToken;
}

/**
 * Interactive login: open authorize URL, wait for loopback callback, exchange code.
 * Lab mode: CHAMBER_OAUTH_CODE + CHAMBER_OAUTH_STATE skip browser (for tests).
 */
export async function loginInteractive(
  db: DatabaseSync,
  resourceUrl: string,
  opts: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    scope?: string;
    openBrowser?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<StoredToken> {
  const clientId =
    opts.clientId ?? process.env.CHAMBER_MCP_CLIENT_ID ?? "chamber-cli";
  const redirectUri =
    opts.redirectUri ??
    process.env.CHAMBER_MCP_REDIRECT_URI ??
    "http://127.0.0.1:8765/callback";
  const { prm, as } = discoverMcpOAuth(db, resourceUrl);
  const resource = prm.resource || normalizeResourceUrl(resourceUrl);
  const scope =
    opts.scope ??
    process.env.CHAMBER_MCP_SCOPE ??
    (prm.scopes_supported?.includes("mcp:tools")
      ? "mcp:tools"
      : prm.scopes_supported?.[0]);

  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: as.authorization_endpoint,
    clientId,
    redirectUri,
    resource,
    scope,
    state,
    codeChallenge: challenge,
  });

  appendAudit(db, {
    category: "security",
    action: "mcp_oauth_login_start",
    actor: "human",
    detail: { resource, issuer: as.issuer },
  });

  // Test / non-interactive path
  if (process.env.CHAMBER_OAUTH_CODE) {
    return exchangeAuthorizationCode(db, {
      tokenEndpoint: as.token_endpoint,
      clientId,
      clientSecret: opts.clientSecret ?? process.env.CHAMBER_MCP_CLIENT_SECRET,
      code: process.env.CHAMBER_OAUTH_CODE,
      redirectUri,
      codeVerifier: process.env.CHAMBER_OAUTH_VERIFIER ?? verifier,
      resource,
      issuer: as.issuer,
      expectedIss: as.issuer,
      issFromCallback: process.env.CHAMBER_OAUTH_ISS,
    });
  }

  console.log("Open this URL to authorize:\n");
  console.log(authorizeUrl);
  console.log("");

  if (opts.openBrowser !== false && process.env.CHAMBER_OAUTH_NO_BROWSER !== "1") {
    spawnSync(
      process.platform === "darwin" ? "open" : "xdg-open",
      [authorizeUrl],
      { stdio: "ignore" },
    );
  }

  const redir = new URL(redirectUri);
  if (redir.hostname !== "127.0.0.1" && redir.hostname !== "localhost") {
    throw new Error("redirect_uri host must be 127.0.0.1 or localhost for CLI");
  }

  const timeoutMs = opts.timeoutMs ?? 180_000;
  const { code, iss } = await waitForCallback(
    Number(redir.port || 8765),
    redir.pathname || "/callback",
    state,
    timeoutMs,
  );

  return exchangeAuthorizationCode(db, {
    tokenEndpoint: as.token_endpoint,
    clientId,
    clientSecret: opts.clientSecret ?? process.env.CHAMBER_MCP_CLIENT_SECRET,
    code,
    redirectUri,
    codeVerifier: verifier,
    resource,
    issuer: as.issuer,
    expectedIss: as.issuer,
    issFromCallback: iss,
  });
}

function waitForCallback(
  port: number,
  path: string,
  expectedState: string,
  timeoutMs: number,
): Promise<{ code: string; iss?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timeout"));
    }, timeoutMs);

    const server = createServer((req, res) => {
      try {
        const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (u.pathname !== path) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const err = u.searchParams.get("error");
        if (err) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`OAuth error: ${err}`);
          clearTimeout(timer);
          server.close();
          reject(new Error(`OAuth error: ${err}`));
          return;
        }
        const st = u.searchParams.get("state");
        if (st !== expectedState) {
          res.writeHead(400);
          res.end("state mismatch");
          clearTimeout(timer);
          server.close();
          reject(new Error("OAuth state mismatch"));
          return;
        }
        const code = u.searchParams.get("code");
        if (!code) {
          res.writeHead(400);
          res.end("missing code");
          clearTimeout(timer);
          server.close();
          reject(new Error("OAuth missing code"));
          return;
        }
        const iss = u.searchParams.get("iss") ?? undefined;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h3>Chamber authorized</h3><p>You can close this window.</p></body></html>",
        );
        clearTimeout(timer);
        server.close();
        resolve({ code, iss });
      } catch (e) {
        clearTimeout(timer);
        server.close();
        reject(e);
      }
    });

    server.listen(port, "127.0.0.1");
  });
}
