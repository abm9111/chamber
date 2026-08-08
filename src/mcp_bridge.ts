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
/**
 * A vendor string rendered on one line, unable to open a fence or break out of
 * it. Newlines collapse so it cannot introduce a structural line of its own.
 */
/**
 * The fields that become structure are validated, not escaped.
 *
 * Sanitising them one at a time has now failed twice — first the description,
 * then the name, while `risk`, `runtime` and `endpoint` stayed raw and could
 * each still supply the first fence that tools.ts executes. Escaping is a
 * blocklist worn as a whitelist: it protects the characters someone thought of.
 * These fields have small closed ranges, so anything outside them is refused and
 * the tool does not register at all.
 */
const KNOWN_RUNTIMES = new Set(["node", "python", "bash"]);
const KNOWN_RISKS = new Set([
  "compute",
  "read",
  "network",
  "shell",
  "write_fs",
]);

function structuralFieldsValid(t: {
  runtime?: string;
  endpoint?: string;
  risk?: string[];
}): boolean {
  if (t.runtime !== undefined && !KNOWN_RUNTIMES.has(t.runtime)) return false;
  if (t.risk?.some((r) => !KNOWN_RISKS.has(r))) return false;
  // An endpoint is a URL or the literal "local"; anything with whitespace or a
  // backtick is not one, and is the shape an injection takes.
  if (
    t.endpoint !== undefined &&
    t.endpoint !== "local" &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s`]+$/.test(t.endpoint)
  ) {
    return false;
  }
  return true;
}

function inlineSafe(text: string): string {
  return text.replace(/`/g, "\\`").replace(/[\r\n]+/g, " ").trim();
}

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
    // No vendor string in generated code. The name used to be interpolated
    // here, so a manifest that simply omitted `source` got the vendor's own
    // statements into the JavaScript tools.ts executes — sanitising the name
    // where it is *rendered* did nothing for the copy that became code.
    const toolSource = t.source ?? "console.log(JSON.stringify({ ok: true }))";
    if (!structuralFieldsValid(t)) {
      blocked++;
      appendAudit(db, {
        category: "security",
        action: "mcp_tool_blocked",
        actor: "system",
        detail: {
          server: manifest.name,
          tool: t.name,
          reason: "runtime, risk or endpoint outside its permitted set",
        },
      });
      continue;
    }
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
    // Every vendor-controlled field, not just the description. The name sits
    // above both the description and the source fence, so a name carrying a
    // fence supplies the first one — which is the code `tools.ts` executes.
    // Fixing one field and leaving its neighbour is not fixing the class.
    const body = `# MCP tool: ${inlineSafe(t.name)}

${quarantineUntrusted(t.description)}

CHAMBER_TOOL:1
mcp_server: ${inlineSafe(manifest.name)}
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
