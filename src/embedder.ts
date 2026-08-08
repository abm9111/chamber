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

/**
 * The interpreter that runs `scripts/embed_minilm.py`.
 *
 * Overridable because "python3" resolves differently depending on who is
 * asking, and the difference is not cosmetic. On this machine an interactive
 * shell finds an interpreter with numpy and onnxruntime installed, while a
 * *login* shell — which is what `launchd` and `systemd` units run — finds
 * `/usr/bin/python3`, which has neither. The scheduled ingest therefore
 * embedded the whole corpus with hash vectors every morning and exited 0.
 *
 * Naming the interpreter is the only reliable fix: PATH is the thing that
 * differs, so a setting that depends on PATH cannot resolve it.
 */
function pythonBin(): string {
  const raw = process.env.CHAMBER_PYTHON;
  return raw && raw.trim() !== "" ? raw.trim() : "python3";
}

/** Embed one string with MiniLM (subprocess). */
export function embedMinilm(text: string): Float32Array {
  const r = spawnSync(pythonBin(), [SCRIPT, text], {
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
    // Not the literal "python3": the whole point of pythonBin is that PATH
    // resolves differently for a login shell, and this batch path is the one
    // the scheduled ingest actually takes.
    pythonBin(),
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
/**
 * Announce a silent downgrade once per process.
 *
 * Once, because embedding runs per passage: a per-call warning on a 28,508
 * passage ingest is 28,508 lines, which is its own way of saying nothing.
 */
let minilmFallbackWarned = false;
function warnMinilmFallback(err: unknown): void {
  if (minilmFallbackWarned) return;
  minilmFallbackWarned = true;
  const why = err instanceof Error ? err.message : String(err);
  console.warn(
    `chamber: WARNING — the MiniLM model files are present but the embedder ` +
      `could not run, so this run is writing non-semantic hash vectors ` +
      `(${HASH_MODEL}, ${HASH_DIMS}d) instead of ${MINILM_MODEL}. Retrieval ` +
      `will not find things by meaning. Cause: ${why}. ` +
      `embedMinilm shells out to python3 — check that the python3 on PATH has ` +
      `its dependencies, which a scheduled job often does not. ` +
      `Re-ingest once fixed; existing rows keep the vectors they were written with.`,
  );
}

/** True when a silent MiniLM downgrade happened in this process. */
export function minilmFallbackOccurred(): boolean {
  return minilmFallbackWarned;
}

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
    } catch (err) {
      if (prefer === "minilm") {
        throw new Error(
          `minilm embed failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      // A silent fall-through here destroyed a 28,508-passage corpus.
      //
      // `minilmAvailable()` tests that two *files* exist; it does not test that
      // the embedder runs. embedMinilm shells out to python3, so an
      // interpreter without onnxruntime on PATH — which is exactly what a
      // launchd or systemd job gets — makes availability report true and
      // execution throw. This catch then wrote a 256-dim hash vector in place
      // of a 384-dim semantic one and said nothing.
      //
      // Measured on this machine: the scheduled 08:30 ingest re-embedded every
      // passage with local-hash-v1 and exited 0, and `chamber ask` answered
      // "nothing in the corpus matches this question" for material that was
      // sitting in the index. A hash vector is a valid vector, so nothing
      // downstream could tell.
      //
      // The fallback is kept — a machine with no python is entitled to a
      // degraded index — but it is now audible exactly once per process, on
      // stderr, naming the cause. Callers that must not degrade pass
      // `prefer: "minilm"` and get the throw above.
      warnMinilmFallback(err);
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

  // Ollama has no batch endpoint here, so it embeds per text — but it must be
  // *attempted*. Without this branch an ollama-configured install fell straight
  // through to hash vectors, and every caller that treats `kind: "hash"` as
  // "semantic comparison is impossible" was permanently degraded: the paraphrase
  // debt gate never ran a single time on those machines, and each commit wrote a
  // degradation record nobody had a reason to investigate, because nothing was
  // broken — the branch simply did not exist.
  if (kind === "ollama") {
    try {
      return texts.map((t) => {
        const vector = embedOllama(t);
        return {
          vector,
          model: process.env.CHAMBER_OLLAMA_EMBED_MODEL ?? OLLAMA_MODEL_DEFAULT,
          dims: vector.length,
          kind: "ollama" as const,
        };
      });
    } catch (err) {
      if (prefer === "ollama")
        throw new Error("ollama batch embed failed", { cause: err });
      warnMinilmFallback(err);
    }
  }

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
