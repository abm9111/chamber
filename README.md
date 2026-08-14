# Chamber

Ask questions about your own notes. Get answers that cite their sources — and a
daily check that tells you when a source has changed underneath a conclusion you
already trusted.

Zero runtime dependencies. Everything is `node:sqlite` and files on your disk.
No account, no cloud call unless you point it at one.

## See it in two minutes

Requires Node **23.6+** — Chamber runs TypeScript directly, with no build step.

```bash
git clone <this repo> chamber && cd chamber
npm ci && node --experimental-strip-types src/cli.ts try
```

No config, no database, no model, no network. It builds a throwaway workspace,
runs the real code paths against it, and deletes it (`--keep` to look around).

![chamber try](https://raw.githubusercontent.com/abm9111/chamber/main/assets/chamber-try.gif)

That recording is scripted from [`assets/demo.tape`](assets/demo.tape) rather
than hand-captured, so it is regenerated when the output changes instead of
quietly showing a version of Chamber that no longer exists. Everything below is
the same command's actual output, trimmed:

```
$ chamber believe belief "Customers may return any purchase within 30 days of delivery."
  committed blf_ddcf4f3c9b2e81b8
  an unsourced assertion is not refused — it mints citation debt.

$ chamber debts
  dbt_18bd1c1171cdbfcb  [pending]

$ chamber pay-debt
  proposed 2 source(s), 2 pinned; best=0.694

$ chamber verify
  blf_ddcf4f3c9b2e81b8  2/2 pins verified
```

That is the ordinary state: a belief standing on evidence that still holds. Then
someone edits the note it was built on — `30 days` becomes `14 days`:

```
$ chamber ingest ./notes
  ingested 2 file(s) as 4 passage(s)

$ chamber verify
  blf_ddcf4f3c9b2e81b8  1/2 pins verified
    hash_mismatch: refunds.md#p0
```

Nobody asked it to re-examine that belief. The conclusion did not change; the
ground under it did, and the exit code is non-zero, so a scheduled job can act
on it. That is the whole product.

Four more scenarios — a rolled-back ledger caught by an outside anchor, a
sandbox that refuses rather than degrade, a hostile tool catalogue rejected —
are in [`demos/`](demos/), and run in CI so they cannot drift from the code.

## A dictionary for the words above

Everything Chamber does is rows in one SQLite file. Each term in the
transcripts names a table or a hash:

| Word | What it actually is |
|------|---------------------|
| **passage** | one chunk of one markdown file. `refunds.md#p0` is file path + chunk index. |
| **belief** | a row in `belief`: one asserted sentence, linked to the passages it stands on. |
| **pin** | a sha-256 of a cited passage's stored title, body and ref, taken at the moment of citation and kept in `belief_source`. |
| **verify** | re-read every pinned passage, recompute the hash, compare. Any mismatch exits non-zero. No model involved. |
| **citation debt** | a row in `citation_debt`, created when an assertion commits with no source. The same claim cannot commit again until the debt is paid. |
| **pay-debt** | retrieval proposes passages for the indebted claim; accepting them pins them. |
| **APORIA** | the verdict when no retrieved passage supports an answer. The reply is "I don't know", recorded as that. |
| **gate** | a check and a write inside one SQLite transaction — both commit or neither does. |
| **audit log** | append-only `audit_event`; each row's hash covers the previous row's hash, so editing history breaks every hash after it. |
| **anchor** | the log's root hash stored outside the database, so truncating the log is detectable rather than silent. |
| **the scheduler** | a launchd/systemd job running `ingest` + `verify`, notifying only on drift. |

None of it is hidden machinery: `sqlite3 ~/.local/share/chamber/chamber.sqlite
'.tables'` shows the whole thing.

## Answers that cite their sources

With a model configured, `chamber ask` judges every sentence on its own
citations. Against the same two sample notes, on a local 30B:

```
$ chamber ask "summarise our refund policy"

Customers may return any purchase within 30 days of delivery [2]. Refunds
are issued to the original payment method, usually within five working days
of the returned item arriving at the warehouse [2]. However, perishable goods
and personalised items cannot be returned once dispatched [1].

  [ALLOWED] Customers may return any purchase within 30 days of delivery [2]. Refu
     sources: refunds.md#p0 — refunds › Refund policy, refunds.md#p1 — refunds › Refund policy › Exceptions
```

The model is shown `[1]`…`[k]` and never a document id or a hash, so it cannot
fabricate a citation even in principle — the numbers are resolved back to files
after the answer is written. A sentence that cites nothing is marked
`UNSUPPORTED`: recorded, but not treated as load-bearing.

Asking something the corpus cannot answer is the more important case:

```
$ chamber ask "what should a customer do if they want to return a perishable
               item after the office has closed?"

I don't know

  [APORIA] I don't know
```

Both notes are in the index and both are relevant. Neither answers the
question, so nothing is composed from the pieces.

## Pointing it at your own notes

```bash
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

### Use it as a CI drift gate

The same verify loop works on a repo: claims in docs pinned to passages of
code or policy, `chamber verify --json` failing the build when the ground
moves. One line in a workflow — this repo ships the action:

```yaml
- uses: abm9111/chamber@v0.1.3
```

[`docs/CI_DRIFT_GATE.md`](docs/CI_DRIFT_GATE.md) is the one-page recipe;
[`demos/06_ci_drift_gate.ts`](demos/06_ci_drift_gate.ts) is the runnable
transcript.

### Run it daily

`deploy/launchd/com.chamber.verify.plist` (macOS) and `deploy/systemd/`
(Linux) run ingest and verify on a schedule, and raise a notification only when
something drifted. A check that correctly reports nothing on most days is a
check you stop reading, so it stays quiet until it isn't.

### Use it from an AI coding agent

`src/mcp_server.ts` exposes three tools over MCP — `chamber_ask`,
`chamber_verify`, `chamber_corpus` — so a host like Claude Code can query your
corpus and see the per-claim citation verdicts rather than just the prose.

From the npm package, the server is one subcommand:

```bash
claude mcp add -s user chamber \
  -e CHAMBER_PYTHON=/path/to/python-with-onnxruntime \
  -- npx -y @bu7umaid/chamber mcp
```

That form works when the host's spawn environment can resolve a Node 23.6+
`npx`. When it cannot — and MCP hosts often spawn with a minimal `PATH` — name
the interpreters absolutely:

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

The server resolves config once, on its first tool call, and pins it for the
life of the process — so **reconnect the server after editing config**. Editing
`model.base` while a host held the process open produced `ECONNREFUSED` against
the *old* address while the CLI answered fine from the same file, which reads
as a broken config rather than a stale daemon. The resolved database, mode and
base are printed to stderr on first use so the host's MCP log can settle it.

Nothing on that surface can activate a skill, approve a pending write, or
ingest — the gates exist so a *human* passes through them, and handing a model
the approval side would invert them rather than weaken them.

`chamber_ask` is not read-only, and the write is not just bookkeeping: every
claim goes through the commit gate, so a claim with verified citations is
recorded as a **belief with its pins** — which is exactly what `chamber verify`
later re-checks for drift. Unsourced assertions mint citation debt; spend is
recorded. This is the same behaviour as `chamber ask` on the command line. The
guarantee is that the gate is not bypassed, not that nothing is written.

## What a verified citation does and does not prove

Chamber proves a cited passage **is the passage it claims to be** — unmodified,
still present, still saying what the citation says it says.

It cannot tell you the claim follows from the passage. A model can cite a real
source and misread it, and every layer here will pass it. That is a stated
non-goal, it has been observed happening, and it is not solved.

Read [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) before trusting
any output. Seventeen limitations are documented there, including the two least
flattering. The sandbox confines only where bubblewrap works — Linux with
unprivileged user namespaces — and refuses to run anything anywhere else, which
is safe but is not the same as working. And citation debt blocks a verbatim
repeat reliably, while the paraphrase leg over it is a heuristic: calibration
found no cosine threshold that separates a restatement from a contradiction. A
numeric and negation check now removes the worst of that — an operator
correcting an indebted claim is no longer refused for restating it — but two of
five true paraphrases still slip through, and a contradiction that is neither
numeric nor negated still reads as a repeat.

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

`npm run probes` passes today, and that statement is dated the moment it is
written — run it rather than trust it. Two of these probes (`sandbox_escape`,
`debt_paraphrase`) spent weeks red against real, open defects before their
fixes landed, and they are wired in as gates precisely because they can go red
again. A gate that cannot fail reports safety it never checked.

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
demos/                  the four scenarios above, run in CI so they cannot rot
docs/KNOWN_LIMITATIONS.md   what does not work, and what it costs
```

MIT.
