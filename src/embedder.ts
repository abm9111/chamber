/**
 * Real local embeddings for Chamber.
 *
 * Primary: MiniLM-L6-v2 quantized ONNX via Python onnxruntime
 *   scripts/embed_minilm.py + models/minilm/
 * Fallback: localHashEmbed (vector.ts) when model/python unavailable.
 *
 * Model id: minilm-l6-v2-q  (384-d)
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/embed_minilm.py");
const MODEL = join(ROOT, "models/minilm/model_quantized.onnx");

export const MINILM_MODEL = "minilm-l6-v2-q";
export const MINILM_DIMS = 384;
export const HASH_MODEL = "local-hash-v1";
export const HASH_DIMS = 256;
export const OLLAMA_MODEL_DEFAULT = "nomic-embed-text";

/** Fallback hash embedder (no Python). Kept here to avoid cycle with vector.ts */
function hashEmbed(text: string, dims = HASH_DIMS): Float32Array {
  const v = new Float32Array(dims);
  const norm = text.toLowerCase().normalize("NFKC");
  const padded = `  ${norm}  `;
  for (let n = 3; n <= 5; n++) {
    for (let i = 0; i + n <= padded.length; i++) {
      const gram = padded.slice(i, i + n);
      const h = createHash("sha256").update(gram).digest();
      const idx = h.readUInt32BE(0) % dims;
      v[idx]! += h[4]! & 1 ? 1 : -1;
    }
  }
  for (const tok of norm.split(/\W+/).filter(Boolean)) {
    const h = createHash("sha256").update(`T:${tok}`).digest();
    v[h.readUInt32BE(0) % dims]! += 2;
  }
  let nrm = 0;
  for (let i = 0; i < dims; i++) nrm += v[i]! * v[i]!;
  nrm = Math.sqrt(nrm) || 1;
  for (let i = 0; i < dims; i++) v[i]! /= nrm;
  return v;
}

export type EmbedderKind = "minilm" | "hash" | "ollama";

let resolvedKind: EmbedderKind | null = null;

export function minilmAvailable(): boolean {
  return existsSync(SCRIPT) && existsSync(MODEL);
}

export function ollamaAvailable(): boolean {
  if (process.env.CHAMBER_EMBEDDER === "hash") return false;
  if (process.env.CHAMBER_EMBEDDER === "ollama") return true;
  try {
    const r = spawnSync(
      "curl",
      ["-s", "-m", "1", "http://127.0.0.1:11434/api/tags"],
      { encoding: "utf-8" },
    );
    return r.status === 0 && (r.stdout || "").includes("models");
  } catch {
    return false;
  }
}

export function defaultEmbedderKind(): EmbedderKind {
  if (resolvedKind) return resolvedKind;
  if (process.env.CHAMBER_EMBEDDER === "ollama") {
    resolvedKind = "ollama";
  } else if (process.env.CHAMBER_EMBEDDER === "hash") {
    resolvedKind = "hash";
  } else if (process.env.CHAMBER_EMBEDDER === "minilm") {
    resolvedKind = minilmAvailable() ? "minilm" : "hash";
  } else if (minilmAvailable()) {
    resolvedKind = "minilm";
  } else if (ollamaAvailable()) {
    resolvedKind = "ollama";
  } else {
    resolvedKind = "hash";
  }
  return resolvedKind;
}

/** Local Ollama embeddings — zero cloud exfil when Ollama is local-only. */
export function embedOllama(
  text: string,
  model = process.env.CHAMBER_OLLAMA_EMBED_MODEL ?? OLLAMA_MODEL_DEFAULT,
): Float32Array {
  const base = (
    process.env.CHAMBER_OLLAMA_URL ?? "http://127.0.0.1:11434"
  ).replace(/\/$/, "");
  const r = spawnSync(
    "curl",
    [
      "-s",
      "-m",
      "30",
      "-X",
      "POST",
      `${base}/api/embeddings`,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ model, prompt: text }),
    ],
    { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    throw new Error(`ollama embed failed: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
  }
  const data = JSON.parse(r.stdout || "{}") as { embedding?: number[] };
  if (!data.embedding?.length) {
    throw new Error("ollama embed: empty embedding");
  }
  return Float32Array.from(data.embedding);
}

function parseVector(jsonText: string): Float32Array {
  const arr = JSON.parse(jsonText) as number[];
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("embedder: empty vector");
  }
  return Float32Array.from(arr);
}

/** Embed one string with MiniLM (subprocess). */
export function embedMinilm(text: string): Float32Array {
  const r = spawnSync("python3", [SCRIPT, text], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `embed_minilm failed (${r.status}): ${(r.stderr || "").slice(0, 400)}`,
    );
  }
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  if (!line) throw new Error("embed_minilm: no stdout");
  return parseVector(line);
}

/** Batch embed (one process). */
export function embedMinilmBatch(texts: string[]): Float32Array[] {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [embedMinilm(texts[0]!)];
  const r = spawnSync(
    "python3",
    [SCRIPT, "--json", JSON.stringify(texts)],
    {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
    },
  );
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `embed_minilm batch failed (${r.status}): ${(r.stderr || "").slice(0, 400)}`,
    );
  }
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  if (!line) throw new Error("embed_minilm batch: no stdout");
  const arr = JSON.parse(line) as number[][];
  return arr.map((v) => Float32Array.from(v));
}

export interface EmbedResult {
  vector: Float32Array;
  model: string;
  dims: number;
  kind: EmbedderKind;
}

/**
 * Embed text with the best available local model.
 * Prefer MiniLM; fall back to hash embedder.
 */
export function embedLocal(
  text: string,
  prefer: EmbedderKind | "auto" = "auto",
): EmbedResult {
  const kind =
    prefer === "auto"
      ? defaultEmbedderKind()
      : prefer === "minilm" && !minilmAvailable()
        ? "hash"
        : prefer;

  if (kind === "ollama") {
    try {
      const vector = embedOllama(text);
      return {
        vector,
        model: process.env.CHAMBER_OLLAMA_EMBED_MODEL ?? OLLAMA_MODEL_DEFAULT,
        dims: vector.length,
        kind: "ollama",
      };
    } catch {
      if (prefer === "ollama") throw new Error("ollama embed failed");
    }
  }
  if (kind === "minilm") {
    try {
      const vector = embedMinilm(text);
      return {
        vector,
        model: MINILM_MODEL,
        dims: vector.length,
        kind: "minilm",
      };
    } catch {
      if (prefer === "minilm") throw new Error("minilm embed failed");
    }
  }
  const vector = hashEmbed(text);
  return {
    vector,
    model: HASH_MODEL,
    dims: HASH_DIMS,
    kind: "hash",
  };
}

export function embedLocalBatch(
  texts: string[],
  prefer: EmbedderKind | "auto" = "auto",
): EmbedResult[] {
  const kind =
    prefer === "auto"
      ? defaultEmbedderKind()
      : prefer === "minilm" && !minilmAvailable()
        ? "hash"
        : prefer;

  if (kind === "minilm") {
    const vecs = embedMinilmBatch(texts);
    return vecs.map((vector) => ({
      vector,
      model: MINILM_MODEL,
      dims: vector.length,
      kind: "minilm" as const,
    }));
  }
  return texts.map((t) => {
    const vector = hashEmbed(t);
    return {
      vector,
      model: HASH_MODEL,
      dims: HASH_DIMS,
      kind: "hash" as const,
    };
  });
}
