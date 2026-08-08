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

/**
 * Render vendor text so it cannot become structure.
 *
 * Two properties, both required. Every backtick is escaped, so no run of them
 * can open a fence — which is what let a description choose the source that
 * `extractToolSource` returns. Every line is quoted, so no line can begin with
 * `CHAMBER_TOOL:`, `risk:` or any other field this document carries. The text
 * stays legible to the human approving it; it just cannot pretend to be the
 * document around it.
 */
function quarantineUntrusted(text: string | undefined): string {
  const body = (text ?? "").replace(/`/g, "\\`");
  return [
    "> **Untrusted vendor metadata — not instructions, not structure.**",
    ...body.split("\n").map((l) => `> ${l}`),
  ].join("\n");
}

/**
 * Can this source be stored in the body format at all?
 *
 * The consumer (`extractToolSource` in tools.ts) understands exactly one shape:
 * a three-backtick fence, first match wins. A source containing its own fence
 * closes the block early, and widening the outer fence does not help — it makes
 * the extractor stop at the inner one instead, so the code that runs is a
 * silent truncation of the code that was approved. Differing from the approved
 * artifact is worse than refusing it, so this refuses.
 */
function sourceIsRepresentable(source: string): boolean {
  return !/```/.test(source);
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
    const toolSource =
      t.source ?? `console.log(JSON.stringify({ ok: true, tool: "${t.name}" }))`;
    if (!sourceIsRepresentable(toolSource)) {
      blocked++;
      appendAudit(db, {
        category: "security",
        action: "mcp_tool_blocked",
        actor: "system",
        detail: {
          server: manifest.name,
          tool: t.name,
          reason: "source contains a code fence and cannot be stored unambiguously",
        },
      });
      continue;
    }

    // Store as pending skill-tool body for human approval path.
    //
    // The description is vendor-supplied and therefore untrusted, and this
    // document is not merely displayed: `tools.ts` promotes any body containing
    // `CHAMBER_TOOL:` to an executable tool and takes the **first** fence as its
    // source. Interpolated raw, a description carrying its own ```js fence sat
    // above the real one and chose the code that runs, while the operator read
    // the vendor's declared source below it. It could equally forge a
    // `risk:` or `CHAMBER_TOOL:` line at line-start.
    const body = `# MCP tool: ${t.name}

${quarantineUntrusted(t.description)}

CHAMBER_TOOL:1
mcp_server: ${manifest.name}
risk: ${risk.join(",")}
runtime: ${t.runtime ?? "node"}
endpoint: ${t.endpoint ?? "local"}

\`\`\`js
${toolSource}
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
