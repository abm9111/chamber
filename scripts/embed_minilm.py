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

# all-MiniLM-L6-v2's trained sequence length. Inputs longer than this lose
# their tail; see report_truncation below, which makes that loss visible
# instead of leaving it to be discovered by a query that finds nothing.
MAX_TOKENS = 256

_session: ort.InferenceSession | None = None
_tokenizer: Tokenizer | None = None
_measurer: Tokenizer | None = None


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
        # 256 is all-MiniLM-L6-v2's own trained max_seq_length, not a number
        # picked here -- so this is the model's limit, not a cap worth raising.
        # It is set explicitly because tokenizer.json ships truncation at 128:
        # without these two lines every passage would silently lose everything
        # past 128 tokens, which is half of what the model can actually read.
        _tokenizer.enable_truncation(max_length=MAX_TOKENS)
        _tokenizer.enable_padding(length=MAX_TOKENS)
    return _session, _tokenizer


def _measuring_tokenizer() -> Tokenizer:
    """A second tokenizer with no truncation, used only to measure overflow.

    The embedding tokenizer cannot answer "how long was this really": it has
    already truncated, so every oversized input reports exactly MAX_TOKENS and
    a passage losing 4 tokens is indistinguishable from one losing 370.
    """
    global _measurer
    if _measurer is None:
        _measurer = Tokenizer.from_file(str(TOK_PATH))
        _measurer.no_truncation()
        _measurer.no_padding()
    return _measurer


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


def report_truncation(texts: list[str], enc: list) -> None:
    """Announce, on stderr, any input whose tail was dropped.

    Truncation at MAX_TOKENS is correct -- it is what the model was trained
    for -- but doing it silently is not. A passage that loses its second half
    still embeds to a perfectly valid vector, still verifies (pins hash the
    stored body, not the vector), and still counts toward the passage total.
    The only symptom is a query that cannot find something the corpus
    visibly contains, which reads as the retrieval being bad rather than as
    the text never having been indexed.

    Measured over one real 43,541-passage corpus on 2026-09-13: 541 passages
    (1.24%) exceeded the limit and 80,989 tokens were dropped in total, the
    worst single passage losing 370 of its 626. Narrow, but not nothing, and
    invisible until counted.

    Stderr because stdout is the vector protocol. One summary line per
    process, not one per passage: an ingest of 43k passages must not emit
    43k lines, and the count is what an operator acts on.
    """
    filled = [i for i, e in enumerate(enc) if sum(e.attention_mask) >= MAX_TOKENS]
    if not filled:
        return
    measurer = _measuring_tokenizer()
    over = []
    for i in filled:
        true_len = len(measurer.encode(texts[i]).ids)
        if true_len > MAX_TOKENS:
            over.append(true_len)
    if not over:
        return
    print(
        json.dumps(
            {
                "chamber_truncation": {
                    "limit": MAX_TOKENS,
                    "passages": len(over),
                    "of": len(texts),
                    "tokens_dropped": sum(n - MAX_TOKENS for n in over),
                    "longest": max(over),
                }
            }
        ),
        file=sys.stderr,
    )


def embed_texts(texts: list[str]) -> list[list[float]]:
    session, tokenizer = _load()
    enc = tokenizer.encode_batch(texts)
    report_truncation(texts, enc)
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
