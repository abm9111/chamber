# Working on Chamber

Chamber's claim is that its gates are real. Everything below was learned by a gate
turning out not to be — usually while a green test suite said otherwise.

## The gates that matter are the probes, not the tests

`npm test` passed at 312, 315, 319, 324, 329, 340 and 350 tests while, in the same
tree, the sandbox denied all execution on Linux, the debt gate parked every commit,
an audit row could never be written, and a vendor tool description chose the code
that ran. The unit suite uses stubs and encodes intent; it cannot fail for the
reasons that matter.

```
npm run probes     # the gate. exits non-zero if any escape reproduces.
npm test           # necessary, never sufficient
npm run typecheck
npm run lint
```

CI gates on all four. A probe that cannot fail is not a gate — if you add one,
make sure it can go red, and prove it once by breaking the thing it watches.

## Verification rules that have each been paid for

**Ask what state exists at the moment a guard fires.** This one question found
defects in the sandbox, the debt gate, the checkpoint, the anchor log and the turn
path. `chamber turn` committed an observation and *then* discovered it could not
reach a model. `exportCheckpoint` wrote the receipt and *then* let the anchor
append refuse. A precondition checked after the write is not a precondition.

**Isolation cannot be tested on macOS.** There is no `bwrap` here, so
`CHAMBER_SANDBOX_REQUIRED=1` refuses for the right reason and for every wrong
reason identically. A test asserting "it refuses" passes either way. Verify on
Linux:

```
docker run --rm --privileged -e CHAMBER_SANDBOX_REQUIRED=1 -v "$PWD:/app:ro" node:24-slim \
  bash -c 'apt-get update -qq && apt-get install -y -qq bubblewrap && cd /app && node --experimental-strip-types -e "…"'
```

Plant a secret in `$HOME` and assert the payload cannot read it. `--privileged` is
needed for bwrap's namespaces. Note that bwrap applies mount ops **left to right**:
a `--tmpfs` over a parent placed after a `--bind` beneath it silently hides the
bind.

**A probe only proves the dimensions it tests.** The isolation probe checked write
and network but not *read*, so a sandbox that mounted the entire host read-only
certified itself as confining. The needle must be present and readable
unconfined, and outside the allowlist confined — `/etc/passwd` qualifies;
`homedir()` does not (bwrap creates it), and `/etc/shadow` does not (EACCES either
way).

**Validate against closed sets; do not escape strings.** Sanitising vendor fields
one at a time failed twice — the description, then the name — while `risk`,
`runtime` and `endpoint` stayed raw and could each still supply the first fence
that gets executed. Escaping is a blocklist worn as a whitelist.

## Traps in this codebase

- **`gate_event.action` is CHECK-constrained** to a closed vocabulary
  (`sql/schema.sql`). A new verb is rejected at insert, which throws inside
  `commitBelief`'s transaction and parks the commit. SQLite cannot ALTER a CHECK
  without a table rebuild. For anything outside that vocabulary use `appendAudit`
  directly — `audit_event.action` is free text and is the hash-chained log anyway.
  Do not reach for `'absent'` as a catch-all; `src/contract.ts` notes no surface
  reads it.
- **Singular and batch embedder paths diverge.** `embedLocal` degrades to hash
  vectors on failure; `embedLocalBatch`/`embedMinilmBatch` **throw**. Check both
  when touching either, and never assume a fallback documented on one exists on
  the other. See also the 256-token truncation in `scripts/embed_minilm.py` — it
  emits no warning.
- **The model defaults to a stub.** `CHAMBER_MODEL ?? "stub"`, so `turn` runs
  offline and deterministically. `turn` is stub-safe. **`ask` is stub-poisonous** —
  it returns canned fluent prose with no citations, and `src/mcp_server.ts` warns
  that a reader takes it for a real refusal. Never demo `ask` on the stub.
- **`newId()` is random**, so anything used as an identity across a rebuild must be
  derived, not minted. Vault document ids are `(kind, ingestRoot, ref)`; a
  from-scratch re-index once renamed all 28,627 rows and orphaned every belief
  older than it.
- **Two receipts cannot prove one chain extends another.** That needs the tree —
  `rootAtSeq` replays leaves and re-derives the attested root. Comparing roots
  only works while the length is unchanged, which is why truncate-then-keep-writing
  passed every length-based check.

## Law worth not breaking

`commit_belief.ts` states FM-6: gate check + write are one transaction. Hoisting a
read out of `BEGIN IMMEDIATE` to avoid holding the lock across an embedder spawn
looked like a performance win and was a correctness loss — a debt minted between
the read and the lock is invisible to any in-lock re-check, because re-checking can
only prune what the earlier read already found. The spawn is the cost of the law.
Mitigate by returning early when there is nothing to compare against, not by moving
the check.

## Reviewing your own fixes

Assume a fix introduces a defect of the class it removes; that happened on four
consecutive rounds here. The tests you write alongside a fix confirm your intent
and routinely miss the mechanism — one "hostile name" test passed while the attack
worked, because it supplied an explicit `source` and never reached the vulnerable
default-source branch. Run the adversarial variant, and run the real path end to
end, before believing green.
