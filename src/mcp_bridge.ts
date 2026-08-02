/**
 * MCP tool bridge — allowlist manifests only; execution still goes through sandbox.
 * Chamber does not trust remote MCP servers blindly.
 */

import { readFileSync, existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { newId, sha256 } from "./hash.ts";
import { appendAudit } from "./audit.ts";
import { runInSandbox } from "./sandbox.ts";

export interface McpToolManifest {
  name: string;
  description?: string;
  runtime?: "node" | "python" | "bash";
  /** Inline source for local verification; remote URLs are recorded but not auto-run */
  source?: string;
  risk?: string[];
  endpoint?: string;
}

export interface McpServerManifest {
  name: string;
  tools: McpToolManifest[];
}

export function loadMcpManifest(path: string): McpServerManifest {
  const raw = JSON.parse(readFileSync(path, "utf8")) as McpServerManifest;
  if (!raw.name || !Array.isArray(raw.tools)) {
    throw new Error("invalid MCP manifest");
  }
  return raw;
}

export function registerMcpManifest(
  db: DatabaseSync,
  manifest: McpServerManifest,
): { registered: number; blocked: number } {
  let registered = 0;
  let blocked = 0;
  for (const t of manifest.tools) {
    const risk = t.risk ?? ["compute"];
    if (
      risk.includes("network") ||
      risk.includes("shell") ||
      risk.includes("write_fs")
    ) {
      if (process.env.CHAMBER_ALLOW_HIGH_RISK_TOOLS !== "1") {
        blocked++;
        appendAudit(db, {
          category: "security",
          action: "mcp_tool_blocked",
          actor: "system",
          detail: { server: manifest.name, tool: t.name, risk },
        });
        continue;
      }
    }
    // Store as pending skill-tool body for human approval path
    const body = `# MCP tool: ${t.name}

${t.description ?? ""}

CHAMBER_TOOL:1
mcp_server: ${manifest.name}
risk: ${risk.join(",")}
runtime: ${t.runtime ?? "node"}
endpoint: ${t.endpoint ?? "local"}

\`\`\`js
${t.source ?? 'console.log(JSON.stringify({ ok: true, tool: "' + t.name + '" }))'}
\`\`\`
`;
    db.prepare(
      `INSERT INTO skill_registry (
         id, name, description, body, content_hash, status, source
       ) VALUES (?, ?, ?, ?, ?, 'pending', 'imported')`,
    ).run(
      newId("mcp"),
      `mcp_${manifest.name}_${t.name}`,
      t.description ?? `MCP ${manifest.name}/${t.name}`,
      body,
      sha256(body),
    );
    registered++;
  }
  return { registered, blocked };
}

export function verifyMcpToolSource(source: string, runtime: "node" | "python" | "bash" = "node") {
  return runInSandbox({ runtime, source, timeoutMs: 5000 });
}

export function loadAndRegisterMcpFile(db: DatabaseSync, path: string) {
  if (!existsSync(path)) throw new Error(`manifest not found: ${path}`);
  const m = loadMcpManifest(path);
  return { server: m.name, ...registerMcpManifest(db, m) };
}
