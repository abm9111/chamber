/**
 * Minimal MCP client — protocol 2026-07-28 (stateless modern).
 *
 * Supports:
 *   - server/discover (or legacy initialize fallback probe)
 *   - tools/list
 *   - tools/call (only after Chamber allowlist + optional sandbox policy)
 *
 * Transport: Streamable HTTP JSON-RPC POST (single endpoint).
 * Not a full SDK; enough for gated interop.
 */

import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "./audit.ts";
import { newId } from "./hash.ts";
import {
  ensureAccessTokenDetailed,
  refreshAccessTokenWithRetry,
  formatRefreshError,
  normalizeResourceUrl,
} from "./mcp_oauth.ts";
import {
  pinToolsList,
  verifyToolsAgainstPin,
  quarantineToolDescription,
} from "./mcp_trust.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpDiscoverResult {
  protocolVersions: string[];
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  raw: unknown;
}

function httpPost(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): { status: number; body: string } {
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

function rpc(
  endpoint: string,
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
  db?: DatabaseSync,
): unknown {
  const id = Date.now();
  const payload = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": {
          name: "chamber",
          version: "0.1.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {
          tools: {},
        },
      },
    },
  };
  const headers: Record<string, string> = {
    "Mcp-Method": method,
    ...extraHeaders,
  };
  // Attach resource-bound bearer when available (refresh if expiring)
  let lastRefreshErr: string | undefined;
  if (db) {
    const ensured = ensureAccessTokenDetailed(db, endpoint);
    if (ensured.token) headers.Authorization = `Bearer ${ensured.token}`;
    else if (ensured.refreshError) {
      lastRefreshErr = formatRefreshError(ensured.refreshError);
    }
  } else if (process.env.CHAMBER_MCP_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.CHAMBER_MCP_ACCESS_TOKEN}`;
  }

  let res = httpPost(endpoint, payload, headers);
  // One refresh cycle on 401 (with transient retries inside; no outer storm)
  if (res.status === 401 && db) {
    const refreshed = refreshAccessTokenWithRetry(db, endpoint, {
      maxAttempts: 3,
      baseDelayMs: Number(process.env.CHAMBER_OAUTH_RETRY_DELAY_MS ?? 100),
    });
    if (refreshed.ok) {
      headers.Authorization = `Bearer ${refreshed.token.accessToken}`;
      res = httpPost(endpoint, payload, headers);
    } else {
      lastRefreshErr = formatRefreshError(refreshed);
    }
  }
  if (res.status === 401) {
    throw new Error(
      lastRefreshErr ??
        `MCP HTTP 401 auth_required for ${normalizeResourceUrl(endpoint)} — run: chamber mcp-auth login <url>`,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`MCP HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }
  const parsed = JSON.parse(res.body || "{}") as {
    result?: unknown;
    error?: { message?: string; code?: number };
  };
  if (parsed.error) {
    throw new Error(
      `MCP error ${parsed.error.code}: ${parsed.error.message ?? "unknown"}`,
    );
  }
  return parsed.result;
}

/** Discover server versions/capabilities (2026-07-28). */
export function mcpDiscover(
  endpoint: string,
  db?: DatabaseSync,
): McpDiscoverResult {
  try {
    const result = rpc(endpoint, "server/discover", {}, {}, db) as Record<
      string,
      unknown
    >;
    const versions = (result.protocolVersions as string[]) ??
      (result.supported as string[]) ?? [MCP_PROTOCOL_VERSION];
    return {
      protocolVersions: versions,
      serverInfo: result.serverInfo as McpDiscoverResult["serverInfo"],
      capabilities: result.capabilities as Record<string, unknown>,
      raw: result,
    };
  } catch (e) {
    // Legacy probe: initialize (2025-11-25 and earlier)
    try {
      const result = rpc(endpoint, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "chamber", version: "0.1.0" },
      }) as Record<string, unknown>;
      return {
        protocolVersions: [
          String(result.protocolVersion ?? "2025-11-25"),
        ],
        serverInfo: result.serverInfo as McpDiscoverResult["serverInfo"],
        capabilities: result.capabilities as Record<string, unknown>,
        raw: result,
      };
    } catch {
      throw e;
    }
  }
}

export function mcpToolsList(endpoint: string, db?: DatabaseSync): McpTool[] {
  const result = rpc(endpoint, "tools/list", {}, {}, db) as {
    tools?: McpTool[];
  };
  return result.tools ?? [];
}

export function mcpToolsCall(
  endpoint: string,
  name: string,
  args: Record<string, unknown> = {},
  db?: DatabaseSync,
): unknown {
  if (db) {
    const live = mcpToolsList(endpoint, db);
    const pin = verifyToolsAgainstPin(db, endpoint, live);
    if (!pin.ok) throw new Error(`MCP pin check failed: ${pin.message}`);
  }
  return rpc(
    endpoint,
    "tools/call",
    {
      name,
      arguments: args,
    },
    {},
    db,
  );
}

/**
 * Import remote tools/list into Chamber skill_registry as pending.
 * Does not call tools. High-risk names can be filtered by caller.
 */
export function mcpImportRemoteTools(
  db: DatabaseSync,
  endpoint: string,
): { server: string; registered: number; tools: string[]; listHash: string } {
  const disc = mcpDiscover(endpoint, db);
  const tools = mcpToolsList(endpoint, db);
  const server =
    disc.serverInfo?.name ?? new URL(endpoint).host ?? "mcp-remote";
  const pin = pinToolsList(db, endpoint, tools);
  let registered = 0;
  const names: string[] = [];

  for (const t of tools) {
    const quarantined = quarantineToolDescription(t.name, t.description);
    const body = `# MCP remote tool: ${t.name}

${quarantined}

CHAMBER_TOOL:1
mcp_server: ${server}
mcp_endpoint: ${endpoint}
mcp_protocol: ${MCP_PROTOCOL_VERSION}
mcp_list_hash: ${pin.listHash}
risk: compute
runtime: node

\`\`\`js
// Remote tool — execution via chamber mcp-call after human approve
console.log(JSON.stringify({ remote: true, tool: ${JSON.stringify(t.name)} }))
\`\`\`
`;
    db.prepare(
      `INSERT INTO skill_registry (
         id, name, description, body, content_hash, status, source
       ) VALUES (?, ?, ?, ?, ?, 'pending', 'imported')`,
    ).run(
      newId("mcp"),
      `mcp_${server}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 80),
      t.description ?? t.name,
      body,
      String(body.length),
    );
    registered++;
    names.push(t.name);
  }

  appendAudit(db, {
    category: "security",
    action: "mcp_remote_import",
    actor: "system",
    detail: {
      endpoint,
      server,
      registered,
      listHash: pin.listHash.slice(0, 16),
      protocol: disc.protocolVersions,
    },
  });

  return { server, registered, tools: names, listHash: pin.listHash };
}

/**
 * Gated remote call: only if skill is active OR CHAMBER_MCP_ALLOW_CALL=1 for testing.
 */
export function mcpGatedCall(
  db: DatabaseSync,
  endpoint: string,
  toolName: string,
  args: Record<string, unknown> = {},
): { ok: boolean; result?: unknown; reason?: string } {
  if (process.env.CHAMBER_MCP_ALLOW_CALL !== "1") {
    const active = db
      .prepare(
        `SELECT id FROM skill_registry
         WHERE status = 'active' AND name LIKE ? LIMIT 1`,
      )
      .get(`%${toolName}%`) as { id: string } | undefined;
    if (!active) {
      return {
        ok: false,
        reason:
          "tool not active in registry — approve skill first or set CHAMBER_MCP_ALLOW_CALL=1",
      };
    }
  }
  // Anti rug-pull: re-list and compare to pin (skip if CHAMBER_MCP_SKIP_PIN=1)
  if (process.env.CHAMBER_MCP_SKIP_PIN !== "1") {
    try {
      const live = mcpToolsList(endpoint, db);
      const check = verifyToolsAgainstPin(db, endpoint, live);
      if (!check.ok) {
        return { ok: false, reason: check.message };
      }
    } catch (e) {
      return {
        ok: false,
        reason: `pin verify failed: ${String(e).slice(0, 160)}`,
      };
    }
  }
  try {
    const result = mcpToolsCall(endpoint, toolName, args, db);
    appendAudit(db, {
      category: "skill",
      action: "mcp_tools_call",
      actor: "system",
      detail: { endpoint, toolName, ok: true },
    });
    return { ok: true, result };
  } catch (e) {
    appendAudit(db, {
      category: "security",
      action: "mcp_tools_call_fail",
      actor: "system",
      detail: { endpoint, toolName, error: String(e).slice(0, 200) },
    });
    return { ok: false, reason: String(e) };
  }
}
