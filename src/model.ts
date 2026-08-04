/**
 * Model adapter — every completion must go through recordSpend.
 *
 * Modes:
 *   CHAMBER_MODEL=stub     (default) deterministic local stub
 *   CHAMBER_MODEL=openai   OpenAI-compatible Chat Completions
 *     CHAMBER_API_KEY, CHAMBER_API_BASE (default https://api.openai.com/v1)
 *     CHAMBER_API_MODEL (default gpt-4o-mini)
 *
 * All three, and the mode itself, may also come from `model.mode`/`base`/`name`
 * in the config file; src/cli.ts seeds them into the environment only where
 * unset, so env still outranks config. CHAMBER_API_KEY is the exception and is
 * read from the environment alone — see src/config.ts.
 *
 * The default is `stub`, and that default is load-bearing in the wrong
 * direction: it answers every question with a fixed string. Anything that
 * reports Chamber's configuration must say which mode is live, or a base and
 * model name will be read as evidence they are being used.
 */

import type { DatabaseSync } from "node:sqlite";
import { isLoopbackBase } from "./config.ts";
import { recordSpend, type SpendChannel } from "./spend.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteInput {
  messages: ChatMessage[];
  channel?: SpendChannel;
  turnId?: string;
  sessionId?: string;
  /** Hint for stub behavior */
  userText?: string;
}

export interface CompleteResult {
  text: string;
  model: string;
  modelFamily: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  spendId: string;
  mode: "stub" | "openai";
}

function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

function stubComplete(input: CompleteInput): Omit<CompleteResult, "spendId"> {
  const user =
    input.userText ??
    [...input.messages].reverse().find((m) => m.role === "user")?.content ??
    "";
  const lower = user.toLowerCase();
  let text: string;
  if (/\b(remember|prefer)\b/.test(lower)) {
    text =
      "Noted. Preference recorded under approval workflow (routine memory path).";
  } else if (/\b(skill|procedure|workflow)\b/.test(lower)) {
    text =
      "Skill draft queued for human approval — Chamber does not auto-apply skill writes.";
  } else if (/\b(fact|believe|commit)\s*:/.test(lower) || /\bfact:/.test(lower)) {
    text =
      "Claim received on deep path. Unsourced assertions mint citation debt before they are load-bearing.";
  } else if (/\b(what|who|how|why)\b/.test(lower)) {
    text =
      "I can answer from committed observations and retrieved corpus pins only. Ask me to search or state a fact: claim.";
  } else {
    text =
      "Acknowledged. Gates ran; see spend footer and pending queue for side effects.";
  }
  const inputTokens = estimateTokens(
    input.messages.map((m) => m.content).join("\n"),
  );
  const outputTokens = estimateTokens(text);
  return {
    text,
    model: "stub-local",
    modelFamily: "stub",
    inputTokens,
    outputTokens,
    costUsd: (inputTokens * 0.0000001 + outputTokens * 0.0000002) || 0.0001,
    mode: "stub",
  };
}

async function openaiComplete(
  input: CompleteInput,
): Promise<Omit<CompleteResult, "spendId">> {
  const base = (process.env.CHAMBER_API_BASE ?? "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  // A key is required for anything off this machine, and optional for a
  // loopback server — llama.cpp, LM Studio and Ollama accept any bearer or
  // none, so demanding one made the documented "works with no CHAMBER_*
  // variables set" impossible and taught operators to export a dummy value.
  // A habit of exporting a fake CHAMBER_API_KEY is worth removing: the same
  // export is live when the base is later pointed at a remote host.
  //
  // The waiver keys off the base actually being used, not off config, so an
  // env-supplied remote base still demands a key even when the file's base was
  // loopback. `isLoopbackBase` is the same predicate that restricts a
  // file-sourced base, so the two cannot drift apart.
  const local = isLoopbackBase(base);
  const key = process.env.CHAMBER_API_KEY;
  if (!key && !local) {
    throw new Error(
      `CHAMBER_MODEL=openai requires CHAMBER_API_KEY for a non-loopback base (${base})`,
    );
  }
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
  // Reasoning models (local and hosted) route their answer to reasoning_content
  // and leave content empty; treat a wholly empty reply as an error, not as "".
  const message = data.choices?.[0]?.message;
  const text = message?.content?.trim()
    ? message.content
    : (message?.reasoning_content ?? "");
  if (!text) {
    throw new Error(
      "openai complete returned no content (checked content and reasoning_content)",
    );
  }
  const inputTokens = data.usage?.prompt_tokens ?? estimateTokens(
    input.messages.map((m) => m.content).join("\n"),
  );
  const outputTokens =
    data.usage?.completion_tokens ?? estimateTokens(text);
  // rough default pricing if API omits; override via env micros later
  const costUsd = inputTokens * 0.00000015 + outputTokens * 0.0000006;
  return {
    text,
    model: data.model ?? model,
    modelFamily: "openai-compatible",
    inputTokens,
    outputTokens,
    costUsd,
    mode: "openai",
  };
}

/**
 * Complete + always recordSpend in the same call path.
 */
export async function complete(
  db: DatabaseSync,
  input: CompleteInput,
): Promise<CompleteResult> {
  const mode = (process.env.CHAMBER_MODEL ?? "stub").toLowerCase();
  const raw =
    mode === "openai" ? await openaiComplete(input) : stubComplete(input);

  const spendId = recordSpend(db, {
    channel: input.channel ?? "chat",
    model: raw.model,
    modelFamily: raw.modelFamily,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    costUsd: raw.costUsd,
    turnId: input.turnId,
    sessionId: input.sessionId,
    detail: { mode: raw.mode },
  });

  return { ...raw, spendId };
}

/** Sync wrapper for CLI paths that are not async-first. */
export function completeSync(
  db: DatabaseSync,
  input: CompleteInput,
): CompleteResult {
  const mode = (process.env.CHAMBER_MODEL ?? "stub").toLowerCase();
  if (mode === "openai") {
    throw new Error("completeSync does not support openai; use await complete()");
  }
  const raw = stubComplete(input);
  const spendId = recordSpend(db, {
    channel: input.channel ?? "chat",
    model: raw.model,
    modelFamily: raw.modelFamily,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    costUsd: raw.costUsd,
    turnId: input.turnId,
    sessionId: input.sessionId,
    detail: { mode: "stub" },
  });
  return { ...raw, spendId };
}
