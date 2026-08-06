# Chamber

Ask questions about your own notes. Get answers that cite their sources — and a
daily check that tells you when a source has changed underneath a conclusion you
already trusted.

Zero runtime dependencies. Everything is `node:sqlite` and files on your disk.
No account, no cloud call unless you point it at one.

## What it actually does

```
$ chamber ask "should we lead with cite-or-refuse or drift detection?"

According to the research note, lead with **cite-or-refuse**, treating
drift detection as a secondary feature.

  * The decision section states "Lead with cite-or-refuse" [3]
  * Drift is "the quiet differentiator that earns attention" once trusted [3]

  [UNSUPPORTED] According to the research note, lead with cite-or-refuse…
  [ALLOWED]     The decision section states "Lead with cite-or-refuse…
     sources: research/2026-08-04__x-demand.md#p5
  [ALLOWED]     Drift is "the quiet differentiator that earns attention…
     sources: research/2026-08-04__x-demand.md#p5
```

Every line is judged on its own citations. The opening summary carries none, so
it is marked `UNSUPPORTED` — recorded, but not treated as load-bearing. The
model is shown `[1]`…`[k]` and never a document id or a hash, so it cannot
fabricate a citation even in principle.

Months later:

```
$ chamber verify

blf_50c26c3b  1/3 pins verified
  "All three product lines hit their Q3 numbers."
  hash_mismatch: committed against ops.md#p0, which now holds something else

1 belief(s) checked, 0 with no verified support left, 1 with some support lost
```

Exit code is non-zero, so a scheduled job can act on it. The conclusion did not
change; the ground under it did.

## Quickstart

Requires Node **23.6+** — Chamber runs TypeScript directly, with no build step.

```bash
git clone <this repo> chamber && cd chamber
npm link                 # puts `chamber` on your PATH
chamber init             # writes ~/.config/chamber/config.json
```

Then edit that config to add a notes folder and a model:

```json
{
  "database": "~/.local/share/chamber/chamber.sqlite",
  "model": { "base": "http://127.0.0.1:8087/v1", "name": "your-model", "mode": "openai" },
  "ingest": [{ "root": "~/Notes", "exclude": ["transcripts", "attachments"] }]
}
```

`model.base` may name any OpenAI-compatible endpoint. A loopback address needs
no API key; anything else reads `CHAMBER_API_KEY` from the environment, never
from the file.

```bash
chamber ingest           # index every configured root
chamber ask "..."        # ask, with citations
chamber verify           # re-check stored pins against the corpus
chamber corpus           # what is actually in the index
```

**Set your excludes before the first ingest.** There is no default exclude list.
Pointed at a folder of exported chat logs, Chamber will happily index all of
them and answer from them — see `chamber corpus` and
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) entry 11.

### Run it daily

`deploy/launchd/com.chamber.verify.plist` (macOS) and `deploy/systemd/`
(Linux) run ingest and verify on a schedule, and raise a notification only when
something drifted. A check that correctly reports nothing on most days is a
check you stop reading, so it stays quiet until it isn't.

### Use it from an AI coding agent

`src/mcp_server.ts` exposes three tools over MCP — `chamber_ask`,
`chamber_verify`, `chamber_corpus` — so a host like Claude Code can query your
corpus and see the per-claim citation verdicts rather than just the prose.

```bash
claude mcp add -s user chamber \
  -e CHAMBER_PYTHON=/path/to/python-with-onnxruntime \
  -- /absolute/path/to/node --experimental-strip-types /path/to/chamber/src/mcp_server.ts
```

Both absolute paths are deliberate. A spawned MCP server does not inherit your
interactive shell's `PATH`: `node` may resolve to a version below the 23.6
floor, and `python3` to one without `onnxruntime` — which makes the embedder
fall back to non-semantic hash vectors and every question answer "nothing in
the corpus matches." Naming the interpreters is the only reliable fix. See
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) entry 15.

Nothing on that surface can commit a belief, activate a skill, approve a
pending write, or ingest. The gates exist so a *human* passes through them;
letting a model write into the ledger it is held to would invert them rather
than weaken them. `chamber_ask` is not purely read-only, though — exactly as on
the command line, it mints citation debt for unsourced claims and records
spend.

## What a verified citation does and does not prove

Chamber proves a cited passage **is the passage it claims to be** — unmodified,
still present, still saying what the citation says it says.

It cannot tell you the claim follows from the passage. A model can cite a real
source and misread it, and every layer here will pass it. That is a stated
non-goal, it has been observed happening, and it is not solved.

Read [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) before trusting
any output. Fifteen limitations are documented there, including two that are
unflattering: the sandbox does not isolate, and citation debt blocks a verbatim
repeat but not a paraphrase.

## The invariant

> No assertion may become executable, citable, or load-bearing except through a
> gate whose check and write commit in one transaction — anything else may
> decay, park, or be defeated, but it may never silently pass.

| Gate | Blocks when |
|------|-------------|
| `commitBelief` | assertion with open blocking citation debt; missing or unverifiable pins; a defeater used as a source; a belief-typed commit on the fast path |
| `tryActivateSkill` | open holds; load-bearing stale beliefs; content ≠ last critic-cleared hash; capability manifest over-ask |

Both gates write into a hash-chained audit log — `entry_hash = sha256(prev_hash
|| canonical JSON)` with an incremental Merkle tree — so altering a past
decision breaks every hash after it. Retraction types (`defeater`, `unknown`)
commit freely and never mint blocking debt.

Defaults are refusals: memory and skill writes require approval, learned skills
land in quarantine rather than applying silently, and a pending write that
expires is **not** an approved one.

## Development

```bash
npm test        # 308 tests
npm run typecheck
npm run probes  # adversarial probes; each one asserts a defect is absent
```

`npm run probes` **is expected to fail today.** Two probes report real, open
defects — `sandbox_escape` and `debt_paraphrase` — and they are wired in
deliberately. A gate that cannot fail reports safety it never checked.

## Layout

```text
src/ask.ts              retrieval → prompt → per-claim citation gate
src/mcp_server.ts       the read side over MCP: ask, verify, corpus
src/commit_belief.ts    the belief gate; check and write in one transaction
src/pins.ts             content pins and drift verification
src/audit.ts            hash-chained log + incremental Merkle
src/config.ts           settings: flag → env → config file → default
src/db.ts               opens the database, loads every schema
probes/                 adversarial probes, run by npm run probes
docs/KNOWN_LIMITATIONS.md   what does not work, and what it costs
```

MIT.
