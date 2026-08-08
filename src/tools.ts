/**
 * Tool allowlist + synthesis under Chamber gates.
 *
 * Law:
 * - Only allowlisted tools may execute
 * - Synthesized tools start quarantined
 * - Activation requires proposeWrite → approve (skills path)
 * - Runtime verification = sandbox result attached as evidence
 */

import type { DatabaseSync } from "node:sqlite";
import { runInSandbox, type SandboxResult } from "./sandbox.ts";
import { proposeWrite } from "./approvals.ts";
import { appendAudit } from "./audit.ts";
import { recordSpend } from "./spend.ts";

export type ToolRisk = "read" | "compute" | "write_fs" | "network" | "shell";

export interface ToolSpec {
  id: string;
  name: string;
  description: string;
  risk: ToolRisk[];
  runtime: "node" | "python" | "bash";
  /** Source body for sandboxed tools */
  source: string;
  allowlisted: boolean;
  quarantined: boolean;
}

/** Built-in allowlist — closed by default. */
const BUILTINS: ToolSpec[] = [
  {
    id: "tool_echo",
    name: "echo",
    description: "Echo JSON args (read-only smoke tool)",
    risk: ["read"],
    runtime: "node",
    source: `const a = process.argv.slice(2).join(" ");
console.log(JSON.stringify({ echo: a || "ok" }));`,
    allowlisted: true,
    quarantined: false,
  },
  {
    id: "tool_hash",
    name: "sha256",
    description: "SHA-256 of stdin or argv",
    risk: ["compute"],
    runtime: "node",
    source: `import { createHash } from "node:crypto";
const input = process.argv[2] ?? "";
console.log(createHash("sha256").update(input).digest("hex"));`,
    allowlisted: true,
    quarantined: false,
  },
  {
    id: "tool_json_parse",
    name: "json_parse",
    description: "Parse JSON string and print keys",
    risk: ["compute"],
    runtime: "node",
    source: `const s = process.argv[2] ?? "{}";
try {
  const o = JSON.parse(s);
  console.log(JSON.stringify({ keys: Object.keys(o), type: typeof o }));
} catch (e) {
  console.error(String(e));
  process.exit(1);
}`,
    allowlisted: true,
    quarantined: false,
  },
];

/**
 * The built-in tools, and deliberately nothing else.
 *
 * This used to append "skill-tools" read from a `skill` table, recovering their
 * executable source by first-fence match over a markdown body. Two facts about
 * that, both measured rather than argued:
 *
 * 1. **No schema in this repo creates a `skill` table.** The query threw
 *    `no such table: skill` on every call, into a catch commented "schema may
 *    lack rows" that swallowed it. The feature had never run. Several rounds of
 *    review reasoned carefully about hardening a branch that could not execute.
 * 2. **Recovering code by parsing a document is the wrong shape.** Any vendor
 *    string rendered above the fence — description, name, runtime, endpoint,
 *    risk — becomes a candidate first fence, which is why sanitising them one at
 *    a time kept leaving a hole. The defect was the format, not the fields.
 *
 * So the path is gone rather than repaired: leaving a silently-dead execution
 * branch invites someone to "fix" it by creating the table, which would enable
 * vendor-supplied code execution in one commit that looks like plumbing.
 *
 * Re-enabling this is a deliberate design task, not a restoration. Store the
 * source in its own column, never inside prose; require an explicit approval
 * status; and keep `runTool`'s sandbox as the second line rather than the first.
 * `tests/harness.ts` asserts an approved MCP tool does not become executable —
 * that test is the thing to delete first, with a reason.
 */
export function listTools(_db?: DatabaseSync): ToolSpec[] {
  return [...BUILTINS];
}

/**
 * Whether anything a producer creates can actually be executed.
 *
 * `listTools` returns only the builtins, so a skill row — however synthesised,
 * approved and activated — can never be resolved by `getTool` or run by
 * `runTool`. The producers were left reporting success, which meant an operator
 * could follow `tool-synth` through sandbox verification and human approval to
 * completion and receive a tool that silently does not exist. Deleting a
 * consumer obliges its producers to say so.
 */
export function toolExecutionStatus(): { enabled: boolean; reason: string } {
  return {
    enabled: false,
    reason:
      "skill-tool execution is disabled: source used to be recovered by " +
      "first-fence match over a markdown body, which let any vendor field " +
      "choose the code that ran. Re-enabling needs a dedicated source column " +
      "and an explicit approval status — see the note on listTools.",
  };
}

export function getTool(idOrName: string, db?: DatabaseSync): ToolSpec | null {
  const all = listTools(db);
  return (
    all.find((t) => t.id === idOrName || t.name === idOrName) ?? null
  );
}

export interface ToolRunResult {
  tool: ToolSpec;
  allowed: boolean;
  sandbox?: SandboxResult;
  reason?: string;
}

/** Execute only allowlisted, non-quarantined tools. */
export function runTool(
  db: DatabaseSync,
  idOrName: string,
  args: string[] = [],
  opts: { turnId?: string; sessionId?: string } = {},
): ToolRunResult {
  const tool = getTool(idOrName, db);
  if (!tool) {
    return {
      tool: {
        id: idOrName,
        name: idOrName,
        description: "",
        risk: ["shell"],
        runtime: "node",
        source: "",
        allowlisted: false,
        quarantined: true,
      },
      allowed: false,
      reason: "tool not found",
    };
  }
  if (!tool.allowlisted || tool.quarantined) {
    appendAudit(db, {
      category: "security",
      action: "tool_blocked",
      actor: "system",
      turnId: opts.turnId,
      sessionId: opts.sessionId,
      detail: { tool: tool.id, reason: "not allowlisted or quarantined" },
    });
    return {
      tool,
      allowed: false,
      reason: tool.quarantined ? "quarantined" : "not allowlisted",
    };
  }
  // High-risk categories require explicit env opt-in
  if (
    tool.risk.includes("network") ||
    tool.risk.includes("shell") ||
    tool.risk.includes("write_fs")
  ) {
    if (process.env.CHAMBER_ALLOW_HIGH_RISK_TOOLS !== "1") {
      return {
        tool,
        allowed: false,
        reason: "high-risk tool blocked (set CHAMBER_ALLOW_HIGH_RISK_TOOLS=1)",
      };
    }
  }

  const sandbox = runInSandbox({
    runtime: tool.runtime,
    source: tool.source,
    args,
    timeoutMs: 5_000,
  });

  recordSpend(db, {
    channel: "other",
    model: "sandbox",
    modelFamily: "local",
    inputTokens: Math.ceil(tool.source.length / 4),
    outputTokens: Math.ceil((sandbox.stdout.length + sandbox.stderr.length) / 4),
    costUsd: 0,
    turnId: opts.turnId,
    sessionId: opts.sessionId,
    detail: { tool: tool.id, ok: sandbox.ok, backend: sandbox.backend },
  });

  appendAudit(db, {
    category: "skill",
    action: sandbox.ok ? "tool_ok" : "tool_fail",
    actor: "system",
    turnId: opts.turnId,
    sessionId: opts.sessionId,
    detail: {
      tool: tool.id,
      exitCode: sandbox.exitCode,
      backend: sandbox.backend,
      sourceHash: sandbox.sourceHash,
    },
  });

  return { tool, allowed: true, sandbox };
}

export interface SynthRequest {
  name: string;
  description: string;
  source: string;
  runtime?: "node" | "python" | "bash";
  risk?: ToolRisk[];
}

export interface SynthResult {
  status: "quarantined" | "rejected" | "queued";
  writeId?: string;
  sandbox: SandboxResult;
  reason: string;
  skillBody: string;
}

/**
 * Synthesize a tool: sandbox verify → proposeWrite(skill create) quarantined.
 * Never activates without human approve.
 */
export function synthesizeTool(
  db: DatabaseSync,
  req: SynthRequest,
): SynthResult {
  const runtime = req.runtime ?? "node";
  const sandbox = runInSandbox({
    runtime,
    source: req.source,
    timeoutMs: 5_000,
  });

  const skillBody = `# Tool: ${req.name}

${req.description}

CHAMBER_TOOL:1
risk: ${(req.risk ?? ["compute"]).join(",")}
runtime: ${runtime}
source_hash: ${sandbox.sourceHash}
sandbox_ok: ${sandbox.ok}
sandbox_backend: ${sandbox.backend}

\`\`\`js
${req.source}
\`\`\`

## Verification
exit=${sandbox.exitCode} timedOut=${sandbox.timedOut}
stdout:
\`\`\`
${sandbox.stdout.slice(0, 2000)}
\`\`\`
stderr:
\`\`\`
${sandbox.stderr.slice(0, 1000)}
\`\`\`
`;

  if (!sandbox.ok) {
    appendAudit(db, {
      category: "skill",
      action: "synth_rejected",
      actor: "system",
      detail: {
        name: req.name,
        reason: "sandbox failed",
        stderr: sandbox.stderr.slice(0, 300),
      },
    });
    return {
      status: "rejected",
      sandbox,
      reason: `sandbox failed: ${sandbox.stderr.slice(0, 200) || sandbox.error || "non-zero exit"}`,
      skillBody,
    };
  }

  const q = proposeWrite(db, {
    target: "skill",
    action: "create",
    subject: `tool_${req.name}`,
    payload: {
      body: skillBody,
      stakes: "routine",
      name: req.name,
      quarantined: true,
    },
    origin: "foreground",
    authorFamily: "synth",
    reason: "tool synthesis after sandbox pass — awaits human approve",
  });

  appendAudit(db, {
    category: "skill",
    action: "synth_queued",
    actor: "system",
    detail: {
      name: req.name,
      writeId: "writeId" in q ? q.writeId : null,
      sourceHash: sandbox.sourceHash,
    },
  });

  if (q.status === "queued") {
    return {
      status: "queued",
      writeId: q.writeId,
      sandbox,
      reason:
        "sandbox passed; skill create queued for human approval — but note: " +
        toolExecutionStatus().reason,
      skillBody,
    };
  }

  return {
    status: "quarantined",
    writeId: "writeId" in q ? q.writeId : undefined,
    sandbox,
    reason: `proposeWrite status=${q.status}`,
    skillBody,
  };
}
