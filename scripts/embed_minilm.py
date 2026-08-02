#!/usr/bin/env python3
"""Local MiniLM embeddings via ONNX Runtime (all-MiniLM-L6-v2 quantized).

Usage:
  python3 embed_minilm.py "single text"
  python3 embed_minilm.py --json '["a","b"]'     # JSON array of strings → JSON array of vectors

Stdout: JSON float arrays. Stderr: logs.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models" / "minilm"
ONNX_PATH = MODEL_DIR / "model_quantized.onnx"
TOK_PATH = MODEL_DIR / "tokenizer.json"

_session: ort.InferenceSession | None = None
_tokenizer: Tokenizer | None = None


def _load() -> tuple[ort.InferenceSession, Tokenizer]:
    global _session, _tokenizer
    if _session is None:
        if not ONNX_PATH.is_file():
            raise SystemExit(f"missing model: {ONNX_PATH}")
        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 2
        _session = ort.InferenceSession(
            str(ONNX_PATH), sess_options=so, providers=["CPUExecutionProvider"]
        )
    if _tokenizer is None:
        if not TOK_PATH.is_file():
            raise SystemExit(f"missing tokenizer: {TOK_PATH}")
        _tokenizer = Tokenizer.from_file(str(TOK_PATH))
        # sentence-transformers style: pad/truncate to 128 or 256
        _tokenizer.enable_truncation(max_length=256)
        _tokenizer.enable_padding(length=256)
    return _session, _tokenizer


def mean_pool(last_hidden: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    """Mean pool over tokens with attention mask, then L2-normalize."""
    # last_hidden: (batch, seq, hidden)
    mask = attention_mask.astype(np.float32)[:, :, None]  # (b, s, 1)
    summed = (last_hidden * mask).sum(axis=1)
    counts = np.clip(mask.sum(axis=1), a_min=1e-9, a_max=None)
    emb = summed / counts
    norms = np.linalg.norm(emb, axis=1, keepdims=True)
    norms = np.clip(norms, a_min=1e-9, a_max=None)
    return emb / norms


def embed_texts(texts: list[str]) -> list[list[float]]:
    session, tokenizer = _load()
    enc = tokenizer.encode_batch(texts)
    input_ids = np.array([e.ids for e in enc], dtype=np.int64)
    attention_mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
    token_type_ids = np.zeros_like(input_ids, dtype=np.int64)

    inputs = {}
    for inp in session.get_inputs():
        name = inp.name
        if "input_ids" in name:
            inputs[name] = input_ids
        elif "attention_mask" in name:
            inputs[name] = attention_mask
        elif "token_type" in name:
            inputs[name] = token_type_ids

    outs = session.run(None, inputs)
    # first output is last_hidden_state
    last_hidden = outs[0]
    pooled = mean_pool(last_hidden, attention_mask)
    return pooled.astype(np.float32).tolist()


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: embed_minilm.py <text> | --json '[\"a\",\"b\"]'", file=sys.stderr)
        sys.exit(2)
    if sys.argv[1] == "--json":
        texts = json.loads(sys.argv[2])
        if not isinstance(texts, list):
            raise SystemExit("expected JSON array")
        vecs = embed_texts([str(t) for t in texts])
        json.dump(vecs, sys.stdout)
        sys.stdout.write("\n")
        return
    text = " ".join(sys.argv[1:])
    vecs = embed_texts([text])
    json.dump(vecs[0], sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
