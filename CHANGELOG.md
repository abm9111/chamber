# Changelog

All notable changes to Chamber. Versions before 0.1.6 are described in the git
history and the GitHub releases.

## 0.2.0 — 2026-10-23

### Added

- `chamber pin <tag>` keeps a release checkout at
  `~/.local/share/chamber-release`, detached at that tag, and points the 08:30
  LaunchAgent at it. The job used to call the `chamber` on `PATH`, which
  `npm link` points at the development checkout, so it ran whatever branch was
  checked out. It now runs
  `node "$HOME/.local/share/chamber-release/bin/chamber.js"` and never fetches.
  Pin refuses before moving anything when the installed job's script is not
  the shipped one, when the release checkout has tracked changes or `dist/`,
  or when the tag has no `bin/chamber.js`.

### Changed (breaking)

- **Tool code is refused unless something isolates it.** `CHAMBER_SANDBOX_REQUIRED`
  unset or empty used to mean "run it in a plain subprocess". It now means
  required: `tool-run`, `tool-synth`, `sandbox-test` and MCP tool verification
  run only under bubblewrap, and only after a probe shows that it confines.
  Anywhere without bubblewrap (macOS, most CI runners) they refuse, and the
  refusal ends with `Set CHAMBER_SANDBOX_REQUIRED=0 to run tool code without
  isolation.` `0`, `false`, `no` and `off` are the explicit opt-out.
  `tool-run` and `sandbox-test` print that refusal and the opt-out (the
  `sandbox-test` JSON carries it as `error`), and `tool-synth` exits 1 when a
  synthesis is rejected.
- **The talk allowlists fail closed.** An empty `CHAMBER_DISCORD_ALLOWED_USERS`
  used to let every user talk to the Discord bot, and the Slack runner had no
  talk gate at all. Both now answer nobody until their list is set, and
  `CHAMBER_SLACK_ALLOWED_USERS` is new. Existing bots stop answering until the
  variable is set. Each runner logs one line at startup when its list is empty.
  Approver lists are unchanged.
- `POST /approve` and `POST /reject` record `decided_by = 'http'`. The `actor`
  field in the body is ignored; it used to be written as given, so a caller
  could sign its approval as `human` or `slack:U123`.
- A request body over 1 MiB is a 413, and a body that is not a JSON object is a
  400 `invalid_json` (it was a 500 carrying the parser's message). The cap is
  the `client_max_body_size 1m` that `deploy/nginx-chamber.conf` already sets in
  front of the server.

### Fixed

- **A stalled model no longer hangs the process.** Every model request now has
  a timeout: 180 s by default, `CHAMBER_MODEL_TIMEOUT_MS` to change it. A value
  that is not a whole number of milliseconds from 1 to 2147483647 is refused by
  name, never replaced by the default. The MCP server's queue moves on.
- **The HTTP server refuses a foreign `Host` when no token is set**, closing DNS
  rebinding against a loopback server. With a token set nothing changes.
- **A server error no longer sends its text to the client.** The body is
  `{"error":"internal_error","id":"..."}`; the cause and stack are on stderr
  beside the same id.
- **OAuth endpoints are checked on the parsed URL.** `http://127.0.0.1.evil.example`
  and `http://127.0.0.1@evil.example` used to pass as loopback.
- **The database file is `0600`.** A new one is created that way, in
  directories made `0700`; an existing one owned by you with group or other
  bits set is tightened, once, with a line on stderr. `-wal` and `-shm` follow.
- **No token, secret or body on a curl command line.** The MCP client, the
  OAuth client, and the Slack, Discord and Telegram calls pass the URL, headers
  and body to curl on stdin (`src/http_sync.ts`). The two gateway-runner calls
  that had no timeout now have 30 s.
- **`POST /turn` no longer stops the server.** It runs on a worker thread with
  its own connection to the same database, so `/health` answers while a turn
  waits on the embedder. A route that needs the write lock the turn holds, and
  `/turn` itself, now answers 503 `busy` with `Retry-After: 1` instead of
  freezing; see `docs/KNOWN_LIMITATIONS.md` entry 21. If a worker crashes, only
  the turns that worker was running fail; the others carry on.

### Ingest and `chamber_check`

- **`chamber_check` reads a declared notes folder.** An absolute path under a
  folder declared with `--notes` or a config ingest root is judged from the
  file on disk, with no ingest; no database is needed, and an existing one is
  opened to say whether the index is behind. The install line is
  `npx -y @bu7umaid/chamber mcp --notes ~/Notes`. An edited indexed note is
  judged from the new text and says the index is behind; `record` is refused
  until the index matches the disk. A config that does not parse fails the
  check. A root known only from indexed rows does not authorize reading a file
  the index skipped, and every citation spelling, including a passage ref and a
  `vdoc_` id, meets the same exclude refusal before the file is opened.
- **Re-ingest skips unchanged passages.** A passage whose text, title and
  source ref hash the same, and whose vector is a finite 384-dimension MiniLM
  vector, is kept: no embedder call, no row rewrite. A hash vector or a changed
  passage is embedded as before. The document row and its vector commit
  together, so a failed vector write cannot leave a skippable hash on an old
  vector. The log says how many passages were written and how many were kept.
- **One MiniLM process per ingest.** `ingestDirectory` starts one
  `embed_minilm.py --serve` process for the batches it embeds (restarted at
  most once after a failure) and closes it before it returns, so the model loads once per root instead of once per
  changed file. A root that skips every passage never starts it.
- **MiniLM text goes on stdin.** Batches are split into groups of at most
  12,288 UTF-8 bytes. The script refuses an argument longer than 2,048
  characters before it imports the model.

### Supply chain, CI, `chamber pin` and docs

- **Dependency advisories.** `npm audit fix` moved `proxy-addr` (critical) and
  `brace-expansion` (high) inside their ranges in `package-lock.json`;
  `npm audit` now reports 0. CI fails on `npm audit --audit-level=high`.
- **CI installs and scans.** The embedder's Python packages come from
  `scripts/requirements-embed.txt`, pinned with hashes and installed with
  `--require-hashes`. A new job runs gitleaks 8.30.1 (checked against a
  SHA-256) over the whole history, and the image job now builds and scans both
  `Dockerfile` and `deploy/Dockerfile` under the same trivy gate. Dependabot
  opens weekly updates for npm, GitHub Actions and both Dockerfiles.
- **The stdio image is cleaned like the deploy image.** The root `Dockerfile`
  now runs `apt-get upgrade` and removes npm, npx and corepack; the image had
  three fixable HIGH findings and now has none.
- **MiniLM weights are checked before they load.** `scripts/embed_minilm.py`
  hashes `model_quantized.onnx` and compares it with `models/minilm/VERSION`;
  a mismatch, a missing `VERSION` or a missing `SHA-256:` line exits 3 in every
  mode, before the model is imported. The TypeScript side throws on it
  (`MinilmIntegrityError`) in every mode, `auto` included, in `embedLocal`,
  `embedLocalBatch` and `minilmAvailable()`, so `ingest`, `search` and `ask`
  stop with the hash mismatch instead of writing or querying with
  `local-hash-v1` vectors. A missing interpreter or dependency still degrades
  with a warning, and `CHAMBER_EMBEDDER=hash` still chooses hash on purpose.
  A commit that meets refused weights still goes through (FM-6), but its
  `debt:degraded` audit row now names `MinilmIntegrityError` and the hash
  mismatch instead of a generic reason, stderr says so once, and the refusal
  line keeps the hash `VERSION` records instead of cutting it at 300 characters.
- **One version everywhere.** `server.json` said 0.1.10 while the package said
  0.1.9, and the MCP server reported a third, hand-typed copy. The server now
  reads `package.json`, `server.json` agrees, and a test fails when any of
  them, or the newest CHANGELOG heading, disagree.
- **`chamber-jobs.service` is hardened** with the directives
  `chamber.service` already had, including a `@system-service` syscall filter.
- **The bwrap sandbox unshares more.** `--unshare-pid`, `--unshare-ipc`,
  `--unshare-uts` and `--new-session` join `--unshare-net`. A payload's `/proc`
  used to list every host process. `probes/sandbox_confines.ts` checks the pid
  namespace with a process needle that it first proves visible without the
  sandbox.
- **`chamber pin` runs the release before it moves anything.** Pin fetches the
  tag, then runs `node bin/chamber.js --version` under `/bin/sh -lc` in a
  throwaway clone of the release checkout; it must exit 0 and print the version
  in `package.json` (as its last line, so a login profile that echoes does not
  fail the pin). Only then does it move the checkout and write the plist. A
  release that does not run, or a pin that is interrupted while it runs, leaves
  the checkout, the plist and the loaded job as they were, so a job that was
  already pinned keeps running the release it ran before and a first pin whose
  release does not run leaves no checkout behind. (A first pin killed during its
  fetch or its proof leaves an empty `git init` that the next pin accepts and
  finishes.) What stays open is the move itself, a `git checkout` during which a
  job that starts sees neither release; `deploy/SCHEDULING.md` names it and the
  command that finishes an interrupted move, and pin prints that command when
  its own `git checkout` fails. A throwaway clone that cannot be removed is
  named on stderr and does not change the result. The job plist is read with
  `/usr/bin/plutil -convert json` where that exists, as far as we know the
  parser launchd's own reader is built on (a `Program` key is refused,
  ProgramArguments must be exactly `/bin/sh -lc <shipped script>`, and a plist
  plutil cannot convert, such as one with a `<data>` or `<date>` value, is
  refused). Pin tries the rewrite as a dry run before it fetches or moves
  anything, so a plist it accepts but cannot rewrite in place is refused with
  nothing moved. Where plutil exists the same plist with only the script
  changed is what gets written: the rewrite is parsed again and compared, and a
  rewrite that cannot be compared with the original is refused. Where there is
  no plutil the text reader decides: it requires exactly the XML declaration
  and DOCTYPE of the shipped plist, refuses processing instructions and key
  tags with extra characters, and checks only that the rewrite reads back as
  pinned. The plist is replaced atomically, git runs with prompts off and
  without inherited `GIT_DIR`, with timeouts, an http(s) origin carrying
  credentials is refused, and a commented-out `ProgramArguments` block or a
  `Program` key no longer confuses the plist check.
- **The daily snapshot reports what happened.** `verify exit code` was always
  0 (it read `$?` after an `echo`); it now carries verify's status. Drift,
  Corpus and Ledger run the pinned release checkout (the Ledger opens the live
  database with its `src/db.ts`, not the development checkout's, which used to
  apply its schema to that file at 10:07), or say to run `chamber pin`, and the
  Drift section opens with `release: <tag>` (from `git describe --tags --always`
  in that checkout; `none` when it is missing, `unknown` when it is not a git
  checkout), so a report names the release it ran. The launchd template runs the
  release checkout's copy of the script, which takes effect for a tag that
  contains it.
- **Docs.** New `docs/BACKUP.md` (live backups with `.backup`, not `cp`;
  restore; `chamber checkpoint verify` afterwards). `docs/KNOWN_LIMITATIONS.md`
  entry 1 describes the sandbox as it is, entry 3 no longer claims a scheduled
  export, entry 13 says what the scheduled job's log now shows (its database and
  `=== verify exit N ===`) and what it still does not, and the README's count
  matches. The sample outputs in
  `deploy/SCHEDULING.md` match what `chamber verify` prints.

## 0.1.9 — 2026-10-03

### Changed

- The published description names the check: numbers, capitalised names, and
  file names in the indexed note. Local, no model. It does not judge meaning.
- The README that ships with the package separates checkout, the npx install,
  and config. Checkout is Node 23.6+ from this repo. npx runs the published
  bin. Config is for ingest and chamber_ask.

## 0.1.8 — 2026-09-28

### Fixed

- **Ingest no longer reads hidden folders or non-notes through links.** A
  symlink into a dotted folder (`notes → .obsidian`, `y.md → .obsidian/x.md`)
  was walked and indexed without `--include-dotted`, and a `.md` link to a
  non-note file took the link's extension. The dotted and extension rules now
  apply to where a link lands, and a linked note needs a note name as well as
  a note target. Existing rows indexed that way are removed by `chamber
  prune`.
- **The claim check reads what a citation shows.** The model is shown each
  passage's title and path; a name found only there (a company in its page's
  file name) is now found, from the file's own name and title only — never
  folder names, never numbers of any kind.
- Quantities match across scales by value: `1M AED` / `1 million AED`,
  `11k` / `11,000`. A glued `m`, `M` or `K` counts as a scale only next to a
  currency, so `9m yacht` and `3M tape` vouch for no millions. A bare number
  is no longer satisfied by a scaled one (`9 users` against `9 million users`
  passed before).
- A family name before its version counts (`Qwen` in `Qwen3.5-122B`); a
  capital before a digit does not (`GPT` in `GPT4`, `B` in `B2B`).
- A closing quote or bracket after a full stop still ends the sentence, and
  abbreviations before one (`Dr.”`, `(Gen.)`) still hide no name.

Measured on a held-out set of 200 claims and 74 real answer claims judged
blind: see `docs/KNOWN_LIMITATIONS.md` §2.

### Changed

- The README leads with `chamber_check`: the check your AI agent runs on your
  notes.

## 0.1.7 — 2026-09-28

### Added

- **`chamber_check` (MCP): the check your AI agent runs on your notes.** An
  agent passes its own claims with the notes they came from (absolute paths,
  `file.md#pN` refs or passage ids). Each claim comes back `SUPPORTED`,
  `TERMS_ABSENT` (naming the missing terms), `NO_TERMS`, `STALE` (the note
  changed on disk since it was indexed, so it is not judged), `NOT_FOUND` or
  `NO_SOURCE`. Unlike the check on model answers, it also checks the word that
  opens a claim, unless it is a common word ("Postgres was chosen in 2024").
  It reads a note only when the note's real path is a note ingest indexed —
  never through a link to an excluded, hidden or non-note file, and never a
  FIFO or device — and anything else fails closed as `STALE` with the
  reason. The check uses no model. It is read-only unless `record: true`, which
  commits only the supported claims through the gate, pinned to a small
  covering set of the passages that hold their terms.
- The MCP server sends `instructions` on `initialize`, telling the host when to
  call `chamber_check` and what `SUPPORTED` does not mean.

### Fixed

Upgrade if you rely on `[ALLOWED]`: the first fix below affects `ask`.

- **A term split across two cited passages no longer counts as found.**
  Passages were joined with a newline, so "…was 5" ending one and "million
  users…" opening the next satisfied "5 million", which neither says. This
  affected `ask` and every path through the commit gate.
- A name set apart by markup at the start of a claim (`**Tesla** makes it`,
  `- **Tesla:** …`) is checked again; after a label colon, a common word is
  skipped only when the phrase carries on, so a lone value (`Model: Claude`,
  `Released: May 5`) is checked.
- The claim-support term check now treats file names (`package.json`) and
  counts written as words (`four`, `twenty-five`) as terms, and reads `’`
  and `'` as one apostrophe. After a label colon it skips a common word
  instead of flagging it ("**Privacy:** Users…").

## 0.1.6 — 2026-09-27

### Security

- **A real citation no longer certifies a claim its passage does not contain.**
  Before this release a verified pin proved only that the cited passage exists
  and is unchanged, so "Kingroon filament is made on the Moon and costs $900 per
  kg [1]" came back `[ALLOWED]` over a real note about Kingroon. Every number,
  name and domain in a claim must now occur in the passages it cites; a claim
  that fails keeps none of its citations and lands as `DEBT`, `UNSUPPORTED` or,
  with `--strict`, `REFUSED`, naming the missing terms as `terms_absent: …`.
  The check runs where beliefs are written, so `ask`, `turn`, the server and
  the Discord, Slack and gateway runners all get it.
- **A cited line containing "as noted", "acknowledged" or "no evidence" no
  longer skips the gate.** Such lines were classed as chatter or aporia —
  never recorded, never printed — even when they cited a source.
- **Debt payment checks and writes its pin under one lock**, and re-checks the
  debt's status there: a waived debt could be auto-paid, and a prune between
  the check and the write could leave a debt paid by a deleted passage.

Upgrade if you rely on `[ALLOWED]`. The remaining known gaps in the support
check — it is a term check, not entailment — are listed in
`docs/KNOWN_LIMITATIONS.md` §2.

### Added

- `ask` shows the rest of a split section it retrieves a piece of. Long
  sections are stored in several passages and retrieval could return one, so
  answers were drawn from part of a table; each sibling piece is now shown as
  its own numbered, verifiable passage. A note says when a section the answer
  cites was cut short.
- `chamber prune` removes passages whose file is now covered by an ingest
  root's `exclude` list, not only files deleted from disk. An excluded
  passage is removed even when a belief cites it — the dry run names each
  such belief first, the audit log records `evidence_pruned`, and `verify`
  reports the pin `not_found`. No path of an excluded file is kept.
- `chamber --version` (also `-v`, `version`), which works with a broken config.
- The MCP server re-reads its config on every call, so a changed model base
  takes effect without reconnecting. An explicit `CHAMBER_*` environment
  variable still wins; the database stays pinned until reconnect.

### Changed

- Headings in an answer print as `[HEADING]` and are no longer recorded as
  unsourced observations. Bolded claims are no longer stored with a mangled
  leading `*`.
- The ingest metadata of each passage now carries its section number.
  **Run `chamber ingest` once after upgrading** — until then sibling
  expansion stays off for passages written by older versions. Existing pins
  are unaffected: the pin hash covers title, body and reference only.
- `qs` (dev dependency only) 6.15.3 → 6.16.0; `npm audit` reports no
  vulnerabilities.

### Verified

Sandbox isolation was re-proven on Linux with bubblewrap: the probe payload
ran, could not read `/etc/passwd`, and had no network.
