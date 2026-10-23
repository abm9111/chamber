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

Exit status 3: the model files were not loaded because they are not the ones the
package's own models/minilm/VERSION records -- the SHA-256 of
model_quantized.onnx or of tokenizer.json differs, VERSION is missing or is not
UTF-8, it lacks exactly one line for either hash, or tokenizer.json cannot be
read while the weights file exists (a missing weights file is exit 1: there is
no embedder). The check runs in every mode, before the first reply and before
numpy or onnxruntime is imported.

The files are read once. The bytes that were hashed are the bytes the session
and the tokenizers are built from, so a file replaced on disk after the check is
not what loads.
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
# What the files must be comes from the installed package, always: VERSION is
# read from ROOT/models/minilm and from nowhere else. CHAMBER_MINILM_DIR moves
# only the weights and the tokenizer, so a directory it names is held to the
# package's hashes and cannot vouch for itself with a VERSION of its own. It
# exists so a test can point this script at doctored files; it is not a
# configuration surface.
PACKAGE_MODEL_DIR = ROOT / "models" / "minilm"
VERSION_PATH = PACKAGE_MODEL_DIR / "VERSION"
MODEL_DIR = Path(os.environ.get("CHAMBER_MINILM_DIR") or PACKAGE_MODEL_DIR)
ONNX_PATH = MODEL_DIR / "model_quantized.onnx"
TOK_PATH = MODEL_DIR / "tokenizer.json"

# all-MiniLM-L6-v2's trained sequence length. Inputs longer than this lose
# their tail; see report_truncation below, which makes that loss visible
# instead of leaving it to be discovered by a query that finds nothing.
MAX_TOKENS = 256

_session: ort.InferenceSession | None = None
_tokenizer: Tokenizer | None = None
_measurer: Tokenizer | None = None
# What verify_weights hashed, kept so that these bytes, and not whatever is at
# the paths a moment later, are what the session and the tokenizers are built
# from. The weights are dropped once the session holds its own copy.
_onnx_bytes: bytes | None = None
_tokenizer_json: str | None = None


EXIT_WEIGHTS_REFUSED = 3
# Model files are read whole to be hashed; past this a file is refused, not held (the shipped ones are 23 MB and 0.7 MB).
MAX_MODEL_FILE_BYTES = 256 * 1024 * 1024
# models/minilm/VERSION records each hash on a line of its own, 64 hex digits:
# `SHA-256:` for model_quantized.onnx (the original line, and still the weights)
# and `Vocab-SHA-256:` for tokenizer.json. The patterns are anchored, so the
# second does not match the first: a reader that only knows `SHA-256:` still
# reads this file.
_SHA256_LINE = re.compile(r"^SHA-256:\s*([0-9a-fA-F]{64})\s*$", re.MULTILINE)
_VOCAB_SHA256_LINE = re.compile(r"^Vocab-SHA-256:\s*([0-9a-fA-F]{64})\s*$", re.MULTILINE)
_weights_verified = False


def _refuse_weights(reason: str) -> NoReturn:
    print(f"embed_minilm: {reason}; not loading the model", file=sys.stderr)
    sys.exit(EXIT_WEIGHTS_REFUSED)


def _recorded_hash(text: str, pattern: re.Pattern[str], name: str) -> str:
    """The one hash `pattern` finds in VERSION, or a refusal: none and several both refuse."""
    found = pattern.findall(text)
    if len(found) == 0:
        _refuse_weights(f"{VERSION_PATH} has no {name} line with 64 hex digits")
    if len(found) > 1:
        _refuse_weights(f"{VERSION_PATH} has more than one {name} line")
    return found[0].lower()


def _read_hashed(path: Path, expected: str) -> bytes:
    """The bytes of `path`, read once, if they hash to `expected`; a refusal if not.

    At most MAX_MODEL_FILE_BYTES + 1 bytes are read, from one open, so a file of
    any size costs a bounded read and one over the cap is refused, not held.
    """
    try:
        with path.open("rb") as f:
            data = f.read(MAX_MODEL_FILE_BYTES + 1)
    except OSError as e:
        _refuse_weights(f"cannot read {path} ({e.strerror or e})")
    if len(data) > MAX_MODEL_FILE_BYTES:
        _refuse_weights(f"{path} is larger than {MAX_MODEL_FILE_BYTES} bytes")
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        _refuse_weights(f"{path} has SHA-256 {actual}, but {VERSION_PATH} records {expected}")
    return data


def verify_weights() -> None:
    """Refuse to load the model files unless they match the package's VERSION.

    model_quantized.onnx is a 23 MB binary that onnxruntime parses and
    tokenizer.json is parsed by the same process; both feed retrieval, which
    feeds the citation-pin path. VERSION is the package's own, never the one in
    a CHAMBER_MINILM_DIR directory, and records one SHA-256 for each. Each file
    is read once into memory, hashed there, and kept: the session and the
    tokenizers are built from these bytes and not from the paths, so a file
    replaced after the check is not what loads. Done once per process.

    Exit 3, one stderr line, and no model loaded when either hash differs,
    VERSION is missing or is not UTF-8, or it has not exactly one line for
    either hash. This runs before numpy and onnxruntime are imported, so it
    needs neither.
    """
    global _weights_verified, _onnx_bytes, _tokenizer_json
    if _weights_verified:
        return
    # No weights file is no embedder: exit 1, as it always was, and callers
    # fall back with a warning. Once the weights exist every other failure is a
    # refusal: they are hashed first, and tokenizer.json is read through the
    # same hashed reader below, so a tokenizer that is missing or unreadable
    # next to weights that exist is exit 3. As an ordinary failure it let a
    # tampered model file with no tokenizer fall through to hash vectors.
    if not ONNX_PATH.is_file():
        raise SystemExit(f"missing model: {ONNX_PATH}")
    try:
        version_text = VERSION_PATH.read_text(encoding="utf-8")
    except OSError as e:
        _refuse_weights(f"cannot read {VERSION_PATH} ({e.strerror or e})")
    except UnicodeDecodeError:
        _refuse_weights(f"{VERSION_PATH} is not UTF-8")
    # Both lines are read before anything is hashed, so a bad VERSION is
    # reported as itself and not as a mismatch.
    recorded = (
        (ONNX_PATH, _recorded_hash(version_text, _SHA256_LINE, "SHA-256")),
        (TOK_PATH, _recorded_hash(version_text, _VOCAB_SHA256_LINE, "Vocab-SHA-256")),
    )
    # In `recorded` order: the weights are hashed before tokenizer.json is
    # touched, so tampered weights are reported as themselves even when the
    # tokenizer is also gone.
    held = {path: _read_hashed(path, expected) for path, expected in recorded}
    try:
        tokenizer_text = held[TOK_PATH].decode("utf-8")
    except UnicodeDecodeError:
        # The hash matched, so VERSION records a tokenizer that is not UTF-8.
        _refuse_weights(f"{TOK_PATH} is not UTF-8")
    _onnx_bytes = held[ONNX_PATH]
    _tokenizer_json = tokenizer_text
    _weights_verified = True


def _load() -> tuple[ort.InferenceSession, Tokenizer]:
    global _session, _tokenizer, _onnx_bytes
    verify_weights()
    if _session is None:
        if _onnx_bytes is None:
            raise RuntimeError("verify_weights() kept no weights to load")
        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 2
        # From the bytes that were hashed, not from ONNX_PATH: a path would be
        # opened again, and a file replaced since the hash would load unhashed.
        _session = ort.InferenceSession(
            _onnx_bytes, sess_options=so, providers=["CPUExecutionProvider"]
        )
        _onnx_bytes = None
    if _tokenizer is None:
        if _tokenizer_json is None:
            raise RuntimeError("verify_weights() kept no tokenizer to load")
        _tokenizer = Tokenizer.from_str(_tokenizer_json)
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
        if _tokenizer_json is None:
            raise RuntimeError("verify_weights() kept no tokenizer to measure with")
        _measurer = Tokenizer.from_str(_tokenizer_json)
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
