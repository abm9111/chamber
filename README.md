# Chamber

Catches your AI agent quoting a number or a name that isn't in the note it
cites. When Claude Code (or any MCP host) answers from your notes, it is told
to run each claim through `chamber_check` first. Real output, trimmed:

```
2 claim(s): 1 supported · 1 terms absent · 0 nothing to check · 0 not judged

[TERMS_ABSENT] Q3 revenue was $420k, up 18% on Q2.
     the cited text does not contain: 420k
     checked: q3-review.md#p0
[SUPPORTED] Enterprise renewals moved to Dana Ortiz in August.
     every term Chamber recognises occurs in the cited text
     checked: q3-review.md#p0
```

The note says `$240k`. The agent wrote `$420k`. Edit the note afterwards and
the same check judges the new text, and the result adds `index is behind this
file`, because the index still holds the old copy.

In Claude Code, as a plugin. It asks for your notes folder and adds the
server and a `chamber-check` skill:

```
/plugin install chamber --marketplace abm9111/chamber
```

On Claude Code before 2.1.275, run `/plugin marketplace add abm9111/chamber`
first, then `/plugin install chamber@chamber`. The plugin takes one folder and
no `--exclude`; to keep part of a folder out, use the server line below.

Or the server alone, in any MCP host:

```bash
claude mcp add -s user chamber -- npx -y @bu7umaid/chamber mcp --notes ~/Notes
```

```json
{
  "mcpServers": {
    "chamber": {
      "command": "npx",
      "args": ["-y", "@bu7umaid/chamber", "mcp", "--notes", "/absolute/path/to/Notes"]
    }
  }
}
```

No model, no account, no network: the check is deterministic string matching
over `node:sqlite` and files on your disk. It checks numbers, capitalised
names, domains, file names and counts. It does not check meaning, so a negated
or reversed sentence built from the note's own words still passes. See
[what a verified citation does and does not prove](#what-a-verified-citation-does-and-does-not-prove).

Beyond the check: answers that cite their sources, and a daily job that tells
you when a source changed underneath a conclusion you already trusted.

## Run the check

The `npx` line above is all most people need. `--exclude <pattern>` repeats
after `--notes`. Config ingest roots and their excludes count too. Two other
ways in:

**From a checkout (Node 23.6+).** TypeScript runs straight from the repo, with
no build step. `try` builds a throwaway workspace, runs the real code paths
and deletes it. The published package runs on Node 22 (measured 22.23.1, which
prints Node's experimental-SQLite warning). Node 20.20.2 exits with
`ERR_UNKNOWN_BUILTIN_MODULE` because `node:sqlite` is absent. Node 23.6
remains the floor for a checkout.

```bash
git clone https://github.com/abm9111/chamber.git && cd chamber && npm ci && node --experimental-strip-types src/cli.ts try
```

**If `/mcp` does not list `chamber_check`,** the host started the server with a
minimal `PATH`. Take the interpreter from `command -v node` in your own shell
and point it at the published bin or at a checkout's `src/mcp_server.ts`. Those
are different files:

```bash
# published bin: bin/chamber.js loads dist/. This is not src/mcp_server.ts.
claude mcp add -s user chamber -- "$(command -v node)" /path/to/node_modules/@bu7umaid/chamber/bin/chamber.js mcp

# checkout only. src/mcp_server.ts is not in the npm install.
claude mcp add -s user chamber -- "$(command -v node)" --experimental-strip-types /path/to/chamber/src/mcp_server.ts
```

Ingest and `chamber_ask` need config. The check also reads config ingest roots
when they are set. See
[config: ingest, chamber_ask, and the check](#config-ingest-chamber_ask-and-the-checks-config-roots).

## What people actually do

There is no public trail of Chamber users yet. These are the adjacent failures
on X, which are the reason the check exists.

- Pointing Claude Code at an Obsidian folder reads files. It does not check the
  sentence. [Richard Kovacs, 28 Sep 2026](https://x.com/rchardkovacs/status/2104469882527973411):
  Claude returns a list of sources and he checks them. The remaining failure he
  names is confirmation bias, and he treats that as discipline.
- A tool the agent must remember to call is not a gate.
  [Saksham Arora, 2 Oct 2026](https://x.com/nerfsaksham/status/2106056221879124381):
  a shared-memory MCP only recalled a session if the other agent decided to
  search, so he put a hook before every message. `chamber_check` is the same
  shape. MCP `instructions` ask Claude to call it. Nothing blocks the turn if
  it skips. A Stop hook that requires a receipt is the missing piece; it is not
  in this repo yet.
- Viral vault posts (99.7% recall, thousands of links in minutes) are not
  measurements. The number in this repo is the 200-claim set in
  [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) §2: invented values
  mostly caught, negations not.

## See it in two minutes

The checkout command above builds a throwaway workspace, runs the real code
paths against it, and deletes it (`--keep` to look around). It does not open
a database.

![chamber try](https://raw.githubusercontent.com/abm9111/chamber/main/assets/chamber-try.gif)

That recording is scripted from [`assets/demo.tape`](assets/demo.tape) rather
than hand-captured, so it is regenerated when the output changes instead of
quietly showing a version of Chamber that no longer exists. Everything below is
that checkout command's actual output, trimmed:

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
`UNSUPPORTED`: recorded, but not treated as load-bearing. A sentence whose
numbers, names or domains are not in the passage it cites loses that citation
too, and says which terms were missing (`terms_absent`) — a real passage is not
evidence for a claim it does not contain. Headings in an answer print as
`[HEADING]` and are not recorded.

Asking something the corpus cannot answer is the more important case:

```
$ chamber ask "what should a customer do if they want to return a perishable
               item after the office has closed?"

I don't know

  [APORIA] I don't know
```

Both notes are in the index and both are relevant. Neither answers the
question, so nothing is composed from the pieces.

## Config: ingest, chamber_ask, and the check's config roots

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

`--exclude <pattern>` repeats after `--notes`; config ingest roots and their
excludes also count as declared folders for the check, and an exclude that
matches nothing refuses that folder. A root remembered only on an indexed row
does not authorize reading a file the index does not hold.

`model.base` may name any OpenAI-compatible endpoint. A loopback address needs
no API key; anything else reads `CHAMBER_API_KEY` from the environment, never
from the file.

```bash
chamber ingest           # index every configured root
chamber ask "..."        # ask, with citations
chamber verify           # re-check stored pins against the corpus
chamber corpus           # what is actually in the index
```

**Which embedder you get depends on how you installed.** An npm or Docker
install embeds with `local-hash-v1` vectors, without a warning, unless a local
Ollama server answers on 127.0.0.1:11434 or `CHAMBER_EMBEDDER=ollama` is
set: the npm package and both Dockerfiles do not carry `models/minilm/`
(the 23 MB MiniLM weights), so with hash vectors `chamber ingest` and the
retrieval behind `chamber_ask` match on character n-grams and not on meaning. `chamber_check` is not affected; it uses no model.
For MiniLM, use a clone of the repo, install its Python dependencies with
`pip install --require-hashes -r scripts/requirements-embed.txt`, and set
`CHAMBER_PYTHON` to the interpreter that has them. A clone whose interpreter
lacks onnxruntime falls back to hash vectors too, with a warning on stderr.

**Set your excludes before the first ingest.** There is no default exclude list.
Pointed at a folder of exported chat logs, Chamber will happily index all of
them and answer from them — see `chamber corpus` and
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) entry 11.
If the root is an Obsidian vault, exclude `.obsidian`, `.trash`, and
`*sync-conflict*` before that first ingest. A symlinked folder is indexed under
the link path. The check reads the real path too, because it uses the same
per-entry rules as ingest. A link that leaves the declared folder is not read.

## Use it as a CI drift gate

The same verify loop works on a repo: claims in docs pinned to passages of
code or policy, `chamber verify --json` failing the build when the ground
moves. One line in a workflow — this repo ships the action:

```yaml
- uses: abm9111/chamber@v0.2.2
```

[`docs/CI_DRIFT_GATE.md`](docs/CI_DRIFT_GATE.md) is the one-page recipe;
[`demos/06_ci_drift_gate.ts`](demos/06_ci_drift_gate.ts) is the runnable
transcript.

## Run it daily

`deploy/launchd/com.chamber.verify.plist` (macOS) and `deploy/systemd/`
(Linux) run ingest and verify on a schedule, and raise a notification only when
something drifted. A check that correctly reports nothing on most days is a
check you stop reading, so it stays quiet until it isn't.

## Render it in Obsidian

The companion plugin [Chamber Drift](https://github.com/abm9111/chamber-obsidian)
renders `verify --json`'s report as a vault sidebar panel and a per-note
banner — nothing more. It never verifies and never writes; Chamber does both,
on its own schedule, outside Obsidian. Setup, including the report-writing
one-liner and the Obsidian Sync caveat: [`docs/OBSIDIAN.md`](docs/OBSIDIAN.md).

## Use it from an AI coding agent

An agent that reads your vault with its own tools can check what it is about
to tell you. `chamber_check` takes the agent's claims and the notes it says
they came from, and answers per claim (abridged):

```
[SUPPORTED] One NVIDIA A100 80GB or an L40S can serve about 1,000 users for code completion.
     found in: ai-coding-setups-march-2026.md#p25
[TERMS_ABSENT] One NVIDIA A100 80GB can serve about 2,000 users for code completion.
     the cited text does not contain: 2000
```

The check uses no model. It reads the file on disk when the path is
absolute and the file sits in a declared folder. An indexed note that has since
changed is still judged, from the disk text, and the result adds `index is behind
this file`. A passage ref is judged from the indexed text. `SUPPORTED` means the
recognised terms occur in that text. It does not mean the sentence follows.
Then it checks that every number, capitalised name, domain, file name and count
in the claim occurs in the note. That catches invented values. It does not check lowercase names or
ordinary words, and it does not catch a negated or reversed sentence
built from the note's own words — see
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) §2 for what it was
measured to catch. It writes nothing unless called with `record: true`. Then
the supported claims are committed through the gate, pinned to the passages
that hold them, and `chamber_verify` reports any whose pinned passage changes,
once the note is re-ingested.
The server tells the host this in its MCP `instructions`, which Claude Code
puts in the agent's context. That is a prompt contract, not a runtime gate.

Four tools, not three. `chamber_check` is the one above. The other three cover
the rest: `chamber_ask` (Chamber's own configured model answers, with the same
per-claim verdicts), `chamber_verify` (drift in recorded claims) and
`chamber_corpus` (what is indexed). `CHAMBER_PYTHON` is optional, and only for
`chamber_ask`'s semantic retrieval; a missing onnxruntime falls back to hash
vectors. Ingest stays on the CLI so the model cannot re-index its own evidence.

Register the server with the [command above](#run-the-check). That `npx` runs
the published bin (`dist/`).

The server re-reads config on every tool call, so an edit to `model` takes
effect on the next call without a reconnect; a `CHAMBER_*` variable set in the
server's own environment still outranks the file. The **database** is the
exception: it stays pinned for the life of the process, because a call may be
awaiting the model with it open — reconnect the server to switch databases.
The resolved database, mode and base go to stderr on first use and whenever
they change, so the host's MCP log can settle what the server is using.

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
any output. Twenty-one limitations are documented there, including the two least
flattering. The sandbox is required by default, and the default refuses: tool
code (`tool-run`, `tool-synth`, `sandbox-test`, MCP tool verification) runs only
under bubblewrap, and only after a probe shows that bubblewrap confines. With no
such backend it refuses, and `CHAMBER_SANDBOX_REQUIRED=0` (or `false`, `no`,
`off`) is the explicit opt-out that runs a plain subprocess with a scrubbed
environment. That opt-out does not isolate: a probed run read `$HOME` and
resolved DNS (`docs/KNOWN_LIMITATIONS.md` §1). Isolation cannot be tested on
macOS, which has no bubblewrap. That path is off `chamber_check`. With the
opt-out, do not read "sandbox" as containment. Citation debt blocks a
verbatim repeat reliably, while the paraphrase leg over it is a heuristic:
calibration found no cosine threshold that separates a restatement from a
contradiction. A numeric and negation check now removes the worst of that — an
operator correcting an indebted claim is no longer refused for restating it —
but two of five true paraphrases still slip through, and a contradiction that
is neither numeric nor negated still reads as a repeat.

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
src/mcp_server.ts       MCP surface: ask, check, verify, corpus
src/commit_belief.ts    the belief gate; check and write in one transaction
src/pins.ts             content pins and drift verification
src/audit.ts            hash-chained log + incremental Merkle
src/config.ts           settings: flag → env → config file → default
src/db.ts               opens the database, loads every schema
probes/                 adversarial probes, run by npm run probes
demos/                  the four scenarios above, run in CI so they cannot rot
docs/KNOWN_LIMITATIONS.md   what does not work, and what it costs
docs/NEXT_LEVEL_PLAN.md     historical plan; several items already shipped
```

MIT.
