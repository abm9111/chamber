# Chamber as a CI drift gate

Docs make claims about code and policy. The code and the policy move. This
page wires `chamber verify` into CI so the build goes red when the ground
moves under a written claim — no model involved at any step; the check is
hash comparison.

`demos/06_ci_drift_gate.ts` is this page as a runnable transcript, and runs
in this repo's own CI so it cannot drift from the code.

## The loop

```bash
# once, in the repo
chamber init                       # config with repo-relative roots
chamber ingest ./docs              # markdown → citable passages
chamber index-code ./src           # code chunks → citable passages

# pin a claim to the passages that back it
chamber believe belief "The late fee is five percent, per src/fees.ts."
chamber pay-debt                   # retrieval proposes the passages; accept pins them

# every CI run
chamber ingest ./docs && chamber index-code ./src
chamber verify --json              # exit 1 when any pin no longer holds
```

`verify --json` prints one object: the resolved `database`, `checked`,
`broken`, `degraded`, the sourceless complement, files gone from disk, and
per-belief failures with reasons. Exit is non-zero when `broken + degraded >
0` — partial evidence loss fails the run.

## Reading the failure

- **`hash_mismatch`** (markdown sources): the cited passage is not what is
  stored at that position any more — edited, or shifted by an insertion above
  it. The report names what the position holds now.
- **`not_found`** (typical for code sources): code chunk ids are derived from
  content, so an edit replaces the row entirely. For a code pin, `not_found`
  IS the drift signal: the exact text the claim was pinned to no longer
  exists anywhere in the file.

## Persisting the belief store

The pins live in the SQLite database. In CI you need the same database across
runs, or every run starts with zero beliefs and verify has nothing to check:

- **Commit it** (`chamber.sqlite` in-repo): simplest, works today, binary
  diffs are ugly.
- **Cache it** (actions/cache keyed on a stable name): survives runs, lost on
  cache eviction — treat eviction as "re-pin day", not as a pass.

A text export/import for beliefs would be the clean third option; it does not
exist yet.

## GitHub Actions sketch

```yaml
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npx -y @bu7umaid/chamber ingest ./docs
      - run: npx -y @bu7umaid/chamber index-code ./src
      - run: npx -y @bu7umaid/chamber verify --json
```

(Point `CHAMBER_DB`/config at the persisted database per the section above;
`chamber config show` prints what resolved.)

## Honest limits

- A **deleted** source file's rows persist and its pins verify against stored
  content; verify *names* these files (`… no longer on disk`) but does not
  fail on them yet — tombstones are the planned second phase
  (KNOWN_LIMITATIONS entry 5).
- Verification proves the cited passage **is** what it claimed to be — not
  that the claim follows from it (stated non-goal, KNOWN_LIMITATIONS entry 2).
- Re-pinning after an intentional change is a human step by design:
  `chamber pay-debt` re-proposes sources; the gate exists so a person passes
  through it.
