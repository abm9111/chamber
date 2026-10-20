# Skip unchanged MiniLM passages on ingest

**Date:** 2026-10-20
**Status:** approved
**Scope:** one implementation plan. Re-ingesting a note does not call the embedder or rewrite a row whose text is unchanged and whose vector is already MiniLM.

## Goal

The 08:30 job re-embeds every passage it reads. On this machine that is 790,291 passages, and the run takes hours. A passage whose text has not changed and whose vector is already `minilm-l6-v2-q` is left as it is: no Python call, no row update, no full-text delete and insert.

A passage whose text changed, whose vector is missing, or whose model is anything else — including `local-hash-v1` — is embedded and written as today. Sunday's run wrote hash vectors for part of a vault. The next morning's full rewrite is what replaced them. A skip that kept any vector would have left those rows in place.

## Why this shape

`ingestDirectory` already loads every indexed passage once, writes the file it just split, then deletes passages that file no longer contains. The skip is a decision in that loop. The content pin is `vaultPageHash` in `src/pins.ts`: `sha256` of the JSON array `[title, body, sourceRef]`, with `null` and `""` kept distinct. `upsertDocument` in `src/vector.ts` computes the same bytes inline and says the two must stay identical. The skip calls the one exported function. A second formula re-embeds the corpus, or skips a passage whose text changed.

The model name is the column `vector_embedding.model`. The MiniLM value is `minilm-l6-v2-q` (`MINILM_MODEL` in `src/embedder.ts`). The hash-vector value is `local-hash-v1`.

## Success criteria

Each one is a runnable check.

1. Re-ingest a three-passage file with no edit. The batch embedder is not called. The three document ids are unchanged. Each row's `updated_at` is still the past value the test planted.
2. Change the middle passage. The embedder receives that one body and no other. That passage keeps its id and its hash changes. The other two ids are untouched and keep the planted `updated_at`.
3. A row with the same text stored as `local-hash-v1` is sent to the embedder. After the write its model is `minilm-l6-v2-q`.
4. A file that shrinks from three passages to one keeps the first id and deletes the other two.
5. The batch for a two-passage change returns one vector, with `CHAMBER_EMBEDDER=hash`. The run reports the failure. Neither changed passage receives the short vector; both are `local-hash-v1`. The unchanged passage is still `minilm-l6-v2-q`.
6. The same relative path under a second root is not skipped against the first root's row.

## The decision

The load that builds `existingByPath` also reads `snapshot_hash` and `vector_embedding.model`. It does not read `vector_blob`. A document with no embedding row has a null model.

For each passage of the file just split, compute `vaultPageHash` from the title `passageTitle` would store, the body, and the ref `passageSourceRef` would store. Find the owned row for this root and this ref, the same ownership the shrink sweep already uses.

Keep the row, and do not call `upsertDocument`, when all of these hold:

- an owned row exists for that ref
- its `snapshot_hash` equals the hash just computed
- its model is exactly `minilm-l6-v2-q`
- the `section` in its metadata equals the section about to be written

`section` is not part of `snapshot_hash`. Sibling expansion groups the pieces of a split section by that stored number (`src/siblings.ts`). A skip that ignored it would leave the old number in place, and a split section would be grouped with the wrong pieces. The comparison is one equality. It does not call the embedder.

Anything else is embedded and written: a different hash, a different section, a missing vector, a missing hash, or any other model string. There is no prefix match.

The kept id is added to `writtenIds` and is not appended to `documentIds`. The shrink sweep deletes every owned passage of this file whose id is not in `writtenIds`. A skip that is not recorded there deletes the passage it meant to keep.

A heading change changes the title, which changes the hash, so that passage is rewritten. A passage that moves to a new `#pN` is a new ref, so it is written. The old ref is absent from this pass and the shrink sweep removes it. A legacy row whose ref is the bare path, with no `#pN`, does not match `path#p0`. It is adopted and rewritten as it is today.

A row is eligible only when it belongs to this ingest root. The same relative path under another root is a different passage.

## The batch

The embedder receives only the passages that are not kept, in that list's order. Vector `i` in the result belongs to the `i`-th passage of that list, not to `passages[i]` of the file. Zipping the short result onto the file's passage index would attach a new vector to a passage that was kept. A file whose every passage is kept makes no embedder call.

The batch result must contain one vector per passage in that list. A short result is discarded and treated as a throw: the per-passage fallback embeds that list, and the short array is not zipped onto it. A short array does not shift the passages that were kept. On throw, the same fallback runs for that list only. Kept passages are not re-embedded because one new passage failed.

A fallback stores `local-hash-v1` when MiniLM cannot run. That row is not treated as done. The next run embeds it again because the model is not `minilm-l6-v2-q`. The existing comment that a fallback is whole-file, so one file cannot hold two embedding spaces, is updated: the file may hold MiniLM for the passages that were kept and a hash vector for the passages the fallback just wrote, until the next run replaces the hash vectors.

`embedFallback` is still one message for the run, the first failure's.

## The log

`IngestReport` gains `unchanged: number`, the count of passages kept without a write. `passages` stays the count of rows written this call. It is no longer a description of the corpus size. The comment on the field says so.

`ingested` still counts the file. A file whose every passage was kept was read and confirmed.

When `unchanged` is 0, the CLI line stays exactly:

```text
ingested N file(s) as M passage(s) from <path>
```

When `unchanged` is greater than 0:

```text
ingested N file(s): wrote M passage(s), kept K unchanged from <path>
```

`try_demo` prints from the report. It uses the same split, so a second ingest does not claim it wrote a passage it kept.

`scripts/backtest_drift.ts` logs `report.passages` on the re-ingest as the size of the corpus. After this change that number is only what was written. The corpus size there is `countDocuments`, or `passages + unchanged`. `scripts/eval_retrieval.ts` ingests once, so its use of `passages` is unchanged.

## Tests

The harness passes `embedBatch` and records the bodies it was given. No onnxruntime.

- Three passages, second ingest, no edit: `embedBatch` is not called. Ids are unchanged. Before the second ingest the test sets each row's `updated_at` to a fixed past value, and that value is still there afterwards. A clock read is not the proof: a rewrite in the same fraction of a second looks like a skip. `unchanged` is 3 and `passages` is 0.
- Middle body edited: `embedBatch` is called once with that body alone. That id is stable, its `snapshot_hash` changes. The other two rows keep the past `updated_at` the test planted.
- Same text, model `local-hash-v1`: `embedBatch` is called. The stored model becomes `minilm-l6-v2-q`. The test supplies the model through `embedBatch`'s return value.
- Three passages to one: the first id remains, the other two are gone.
- Two passages need vectors, `embedBatch` returns one vector. The test sets `CHAMBER_EMBEDDER=hash` for the fallback, so the singular path does not spawn Python. The run sets `embedFallback`. Neither of those passages receives the short vector; both are stored as `local-hash-v1`. The kept passage is still `minilm-l6-v2-q`, and its planted `updated_at` does not move.
- Two roots, one relative path: ingesting the second root calls the embedder for its passage. It does not reuse the first root's id.
- Same text, same model, stored section different from the section about to be written: the embedder is called and the stored section becomes the new one.

`vaultPageHash` is exported. One test asserts `upsertDocument` stores the hash `vaultPageHash` returns for the same title, body, and ref, including a null title and an empty-string title as different hashes.

## Out of scope

- Skipping a file because its modification time is unchanged.
- A skip list stored outside the index.
- Capping the batch size, or keeping one Python process alive across files.
- Pointing the 08:30 job at a release instead of the working tree.
- Changing what `snapshot_hash` covers.
