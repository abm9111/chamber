# Chamber plan (execution)

**What this file is.** The current execution state, kept short enough to stay
true. `docs/NEXT_LEVEL_PLAN.md` is the design document behind it — it is dated
2026-08-02, predates most of what is listed here, and is a record of intent
rather than of state. Where the two disagree, this file is the one that was
checked against the code.

Rewritten 2026-08-16 at `8fb3fea`. The previous version tracked Phase 1 and
listed four items under "Next" — a tree-sitter/Merkle index, debt payment from
search, an SCIP consumer, and a sandbox tool path. **All four had shipped**
(`src/code_index.ts`, `src/merkle.ts`, `src/debt.ts`, `src/scip.ts`,
`src/sandbox.ts`); nobody had gone back to tick them. A plan that lists
finished work as pending is worse than no plan, in a repository whose product
detects exactly that.

## Where it stands

`0.1.3` on npm as `@bu7umaid/chamber`, on the MCP Registry, the GitHub
Marketplace and Glama. Four CI jobs gate every push: `typecheck`, `lint`,
374 tests, 6 probes — plus the demos and the isolation probe, which only the
Linux runner can honestly execute.

Shipped and load-bearing:

- **The citation gate.** Beliefs commit with pinned sources; `chamber verify`
  re-derives whether each pin still says what it said, and exits non-zero when
  support is lost — partially as well as wholly.
- **Retrieval.** Passage chunking, hybrid lexical + vector, MiniLM ONNX via
  `scripts/embed_minilm.py` with a hash-vector fallback on the singular path.
- **The drift gate as a product surface.** `chamber verify --json`, the
  composite GitHub Action, `docs/CI_DRIFT_GATE.md`.
- **Code awareness.** `chamber index-code`, Merkle + incremental Merkle, an
  optional SCIP consumer.
- **Debt.** Citation debt with a search-driven payment proposal
  (`pending → proposed_paid → paid`), and a paraphrase leg over it.
- **Isolation.** bwrap-backed sandbox, proven confining in CI — the payload
  runs, cannot read `/etc/passwd`, and has no network.
- **Surfaces.** CLI, MCP server (stdio), HTTP server with token auth and a CORS
  allowlist, Slack/Discord/Telegram gateways.

## Open

Nothing here is a surprise; `docs/KNOWN_LIMITATIONS.md` carries 19 entries with
what each costs and what would fix it. What follows is only the subset that is
actually next, grouped by what kind of thing is missing.

**Needs a decision, not work**

- **The paraphrase threshold has no good value.** 25 labelled pairs
  (`npm run calibrate:paraphrase`) show no FP-free cutoff exists between 0.50
  and 0.99. The real fix is NLI, not a better constant — that is a scope call.
- **`node:24-slim` carries a CRITICAL zlib (`will_not_fix`) and HIGH CVEs in
  perl/util-linux and npm's bundled `tar`.** Pre-existing to the base image,
  found 2026-08-16, owned by nobody. Options: pin a digest, add a trivy image
  scan to CI, or document and accept.

**Needs measurement before it can be designed**

- **Retrieval quality has no corpus-level regression guard** (KL 12). There is
  a seeded golden set and a report-only runner (`npm run eval:retrieval`); it
  does not gate, and should not until it has enough signal to be fair.
- **Proper-noun conflict in the paraphrase leg.** Tempting next step, and
  paraphrases legitimately drop names — so it needs its own labelled set first.

**Work, when it is wanted**

- **Checkpoints are manual, unsigned, and land in `/tmp`** (KL 3), and the
  anchor log sits on the same machine as the database it attests. Genuine
  externality needs off-box anchoring; signing alone does not close it.
- **The corpus has no notion of deletion** (KL 5); a shrunk note reports its
  tail citations as `not_found` (KL 6).
- **Per-tool MCP drift detection does not exist** (KL 7).
- **The embedder runs one subprocess per passage** (KL 15) and truncates at 256
  tokens with no warning.
- **CJK lexical retrieval does not work** (KL 11).

## Non-goals (unchanged)

No in-house compiler, no swarm theater, no "local = cloud quality" claims.

## Keeping this file honest

`npm run probes` is the gate; `npm test` is necessary and never sufficient.
When an item here ships, delete it from this file in the same commit — the
previous version of this document is the argument for why.
