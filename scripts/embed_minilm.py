#!/usr/bin/env python3
"""Local MiniLM embeddings via ONNX Runtime (all-MiniLM-L6-v2 quantized).

Usage:
  python3 embed_minilm.py "single text"
  python3 embed_minilm.py --json '["a","b"]'     # JSON array of strings → JSON array of vectors
  python3 embed_minilm.py --json -                # same, JSON array on stdin
  python3 embed_minilm.py --serve                 # one JSON array per stdin line

Arguments longer than 2048 characters are refused before the model is imported.
Page text must not sit on the process command line, where `pgrep -f` copies it
into a model transcript.

Stdout: JSON float arrays. Stderr: logs.

Exit status 3: the model weights were not loaded because they are not the ones
models/minilm/VERSION records -- the SHA-256 differs, VERSION is missing, or it
has no SHA-256 line. The check runs in every mode, before the first reply and
before numpy or onnxruntime is imported.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import NoReturn

# Imported in _import_stack(), after the argv length check, so a long argument
# is refused on a machine with no model installed.
np = None
ort = None
Tokenizer = None

ROOT = Path(__file__).resolve().parents[1]
# CHAMBER_MINILM_DIR exists so a test can point this script at a copy of the
# model directory with a doctored VERSION. It is not a configuration surface:
# whatever directory it names is held to the same rule, that the weights must
# match the SHA-256 in that directory's own VERSION file.
MODEL_DIR = Path(os.environ.get("CHAMBER_MINILM_DIR") or ROOT / "models" / "minilm")
ONNX_PATH = MODEL_DIR / "model_quantized.onnx"
TOK_PATH = MODEL_DIR / "tokenizer.json"

# all-MiniLM-L6-v2's trained sequence length. Inputs longer than this lose
# their tail; see report_truncation below, which makes that loss visible
# instead of leaving it to be discovered by a query that finds nothing.
MAX_TOKENS = 256

_session: ort.InferenceSession | None = None
_tokenizer: Tokenizer | None = None
_measurer: Tokenizer | None = None


EXIT_WEIGHTS_REFUSED = 3
VERSION_PATH = MODEL_DIR / "VERSION"
# models/minilm/VERSION records the hash as `SHA-256:  <64 hex digits>`.
_SHA256_LINE = re.compile(r"^SHA-256:\s*([0-9a-fA-F]{64})\s*$", re.MULTILINE)
_weights_verified = False


def _refuse_weights(reason: str) -> NoReturn:
    print(f"embed_minilm: {reason}; not loading {ONNX_PATH.name}", file=sys.stderr)
    sys.exit(EXIT_WEIGHTS_REFUSED)


def verify_weights() -> None:
    """Refuse to load model_quantized.onnx unless it matches VERSION's SHA-256.

    These weights feed retrieval, which feeds the citation-pin path, and they
    are a 23 MB binary that onnxruntime parses. VERSION has always recorded the
    hash; nothing ever compared it. Streamed, so the file is not held in memory,
    and done once per process.

    Exit 3, one stderr line, and no model loaded when the hash differs, VERSION
    is missing, or VERSION has no SHA-256 line. This runs before numpy and
    onnxruntime are imported, so it needs neither.
    """
    global _weights_verified
    if _weights_verified:
        return
    if not ONNX_PATH.is_file():
        raise SystemExit(f"missing model: {ONNX_PATH}")
    try:
        version_text = VERSION_PATH.read_text(encoding="utf-8")
    except OSError as e:
        _refuse_weights(f"cannot read {VERSION_PATH} ({e.strerror or e})")
    match = _SHA256_LINE.search(version_text)
    if match is None:
        _refuse_weights(f"{VERSION_PATH} has no SHA-256 line with 64 hex digits")
    expected = match.group(1).lower()
    digest = hashlib.sha256()
    with ONNX_PATH.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    actual = digest.hexdigest()
    if actual != expected:
        _refuse_weights(
            f"{ONNX_PATH} has SHA-256 {actual}, but {VERSION_PATH} records {expected}"
        )
    _weights_verified = True


def _load() -> tuple[ort.InferenceSession, Tokenizer]:
    global _session, _tokenizer
    verify_weights()
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
    embed_texts call, not one per passage: an ingest of 43k passages must not emit
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
    sys.stderr.flush()


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


ARGV_LIMIT = 2048
ARGV_REFUSAL = (
    "refusing an argument longer than "
    f"{ARGV_LIMIT} characters; pass the JSON array on stdin: --json -"
)


def _import_stack() -> None:
    global np, ort, Tokenizer
    import numpy as np  # noqa: PLC0415
    import onnxruntime as ort  # noqa: PLC0415
    from tokenizers import Tokenizer as _Tokenizer  # noqa: PLC0415

    Tokenizer = _Tokenizer


def serve() -> None:
    """One model load, then one JSON reply per stdin line."""
    verify_weights()
    _import_stack()
    while True:
        raw = sys.stdin.buffer.readline()
        if raw == b"":
            return
        if raw.endswith(b"\n"):
            raw = raw[:-1]
        try:
            texts = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise SystemExit("expected JSON array")
        if not isinstance(texts, list):
            raise SystemExit("expected JSON array")
        vecs = embed_texts([str(t) for t in texts])
        sys.stderr.flush()
        json.dump(vecs, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()


def main() -> None:
    if len(sys.argv) < 2:
        print(
            "usage: embed_minilm.py <text> | --json '[\"a\",\"b\"]' | --json - | --serve",
            file=sys.stderr,
        )
        sys.exit(2)
    if any(len(a) > ARGV_LIMIT for a in sys.argv[1:]):
        print(ARGV_REFUSAL, file=sys.stderr)
        sys.exit(2)
    if sys.argv[1] == "--serve":
        serve()
        return
    verify_weights()
    _import_stack()
    if sys.argv[1] == "--json":
        if len(sys.argv) < 3:
            raise SystemExit("usage: --json '<array>' | --json -")
        raw = sys.stdin.read() if sys.argv[2] == "-" else sys.argv[2]
        texts = json.loads(raw)
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
