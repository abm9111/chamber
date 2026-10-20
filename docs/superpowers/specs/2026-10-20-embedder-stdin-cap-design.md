# Embedder stdin cap

**Date:** 2026-10-20
**Status:** approved
**Scope:** one implementation plan. A MiniLM batch is sent on stdin in groups that fit a fixed byte cap, in input order, or the call throws before any partial result is returned.

## Goal

The morning ingest puts every passage of a file on one Python command line. An argument past the operating system's limit fails with `E2BIG`. Sending that same payload through `spawnSync`'s stdin in one write fails with `ENOBUFS` or the timeout, and the batch throws. Ingest then embeds those passages one at a time, and the singular path stores `local-hash-v1` when MiniLM cannot run. The next morning's skip leaves those hash vectors in place until the text changes.

A file that needs MiniLM vectors gets them. The text travels on stdin. No single spawn writes more than 12,288 UTF-8 bytes. The vectors come back in the same order as the texts.

## Why this shape

`embedMinilmBatch` in `src/embedder.ts` is the function ingest calls for a file's passages. Ingest already requires one vector per text it sent, and it treats a short array as a throw. The split belongs in `embedMinilmBatch`, so a later caller cannot send one huge payload. Ingest does not slice the file.

`embedMinilm` and `embedMinilmBatch` both send a JSON array on stdin as `--json -`. `scripts/embed_minilm.py` refuses any argument longer than 2048 characters. The probe string stays on argv. It is short.

The hash embedder and Ollama are unchanged. Ollama is already one call per text.

## Success criteria

Each one is a runnable check. None of them need onnxruntime.

1. Short strings that fit in 12,288 bytes stay in one group. A tighter cap splits them into prefixes, and the original order is unchanged.
2. One string whose JSON exceeds the cap throws. The same throw happens when that string is the last item of an otherwise legal list. The error names 12288. Nothing is spawned.
3. A string that is short in JavaScript length and longer than the cap in UTF-8 bytes is over the cap.
4. `embedMinilm` and `embedMinilmBatch` throw that same error for an oversized text, before spawn.
5. `scripts/embed_minilm.py` exits 2 when an argument is longer than 2048 characters, and stderr is `refusing an argument longer than 2048 characters; pass the JSON array on stdin: --json -`. The model is not imported.
6. `embedMinilmBatch` spawns once per group from `chunkJsonStdin`. Two groups produce two spawns. Each payload is at most 12,288 UTF-8 bytes, and reading the groups in order yields the input texts. A spawn that returns fewer vectors than its group throws, and a failure of the second spawn does not return the first spawn's vectors.

## The cap

`STDIN_CAP_BYTES` is 12,288. The size of a group is `Buffer.byteLength(JSON.stringify(group), "utf8")`. A group is legal when that length is less than or equal to the cap.

`chunkJsonStdin(texts, capBytes)` returns the groups. It walks the texts once. The current group gains the next text while the whole group's JSON stays within the cap. Measuring the whole group matters: brackets and commas are part of the payload, so the sum of the individual strings is not the size. Groups are prefixes of the input. Their concatenation is the input.

A text that does not fit in an empty group throws before a group is emitted. Every text is measured before any Python process starts. An oversized text at the end of a legal list throws before the first spawn.

An empty list produces no groups and no spawn.

## The spawn

`embedMinilmBatch` asks the exported `chunkJsonStdin` for the groups at `STDIN_CAP_BYTES`, then spawns once per group. The spawn is the real `spawnSync` unless a test passes its own. A test spawn records the stdin payloads and returns one vector per text in the group. Each production spawn is `--json -` with that group's JSON on stdin. The vectors from the groups are concatenated in order.

Each spawn must return one vector per text in its group. Fewer vectors is a throw. A spawn that fails after an earlier group succeeded is a throw, and the vectors from the earlier group are discarded. The caller receives one failure for the whole list, or one vector per input text. It never receives a short array.

`embedMinilm` calls `chunkJsonStdin` with a one-element list and the same cap. One text over the cap throws before spawn. The error from both entry points is `stdin cap exceeded (N > 12288 bytes)`, where `N` is the UTF-8 byte length of that text's one-element JSON array.

The 2048-character check in `scripts/embed_minilm.py` runs before NumPy, onnxruntime, or the tokenizer are imported. A machine with no model still refuses a long argument.

## Ingest

Ingest is unchanged. A throw from `embedMinilmBatch` is still a batch failure. Ingest embeds the passages that needed vectors one at a time. The singular path still stores `local-hash-v1` when MiniLM cannot run, and it still reports that once for the process.

## Tests

The harness holds a fixture an editor will not open. Add these tests without printing that file.

- `chunkJsonStdin` keeps a list of short strings in one group when they fit, and splits them into order-preserving prefixes when the cap is tighter than the whole list.
- One oversized string throws, including when it is last. The error names 12288.
- A string whose JavaScript length is under the cap and whose UTF-8 JSON is over the cap throws.
- `embedMinilm` and `embedMinilmBatch` throw that error for an oversized text. The error is the cap error, not a spawn failure.
- Spawning `scripts/embed_minilm.py` with an argument longer than 2048 characters exits 2, and stderr is the sentence in success criterion 5.
- `embedMinilmBatch`, given a test spawn and a list that `chunkJsonStdin` splits in two, calls the spawn twice. Each payload is at most 12,288 UTF-8 bytes. The payloads in order contain the input texts. The second spawn throwing means the function throws, and the first spawn's vectors are not returned. A spawn that returns one vector for two texts throws.

## Out of scope

- Keeping one Python process alive across files.
- Pointing the 08:30 job at a release instead of the checkout.
- Changing the ingest skip, the passage cap, or what `snapshot_hash` covers.
- Changing the hash embedder or Ollama.
- Raising `spawnSync`'s `maxBuffer` or timeout.
