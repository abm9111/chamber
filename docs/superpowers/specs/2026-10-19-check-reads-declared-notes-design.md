# The check reads a declared notes folder

**Date:** 2026-10-19
**Status:** approved, ready for planning
**Scope:** one implementation plan. The MCP check answers from notes a person declared, without an ingest and without embedding.

## Goal

A stranger who adds the server with one notes folder can call `chamber_check` on a file in that folder and get a real verdict. Measured on published 0.1.9: the README's install line, against an empty database, returns `NOT_FOUND` (`not under any ingest root — not indexed`) for every absolute path. `npx @bu7umaid/chamber ingest <folder>` makes the same call return `TERMS_ABSENT`. The ingest is what the README's npx path never mentions, and on a real vault it embeds every passage before the check, which only reads passage text, can run.

## Why this shape

The check and the ingest disagree about what "the note" is, and the README currently describes the ingest's answer. `src/check.ts` resolves an absolute path only through `ingestRoot` values stored on `vector_document` rows, then re-reads the file to see whether the index still matches. A file with no row is `NOT_FOUND`. A file whose bytes have changed is `STALE` and is not judged. Both are the wrong result for an agent that just read the file with its own tools: the text to judge is the text it read.

The read has to stay inside a folder a person named. Letting the check open any path the model supplies would undo the fail-closed rule from 0.1.7 and 0.1.8: the model could ask whether any file on disk contains a given string. Ingest stays the only writer. The check gains a reader.

## Success criteria

Each one is a runnable check.

1. An empty database, a folder declared with `--notes`, and no ingest. A claim that the note's `1,000` is `2,000` returns `TERMS_ABSENT` naming `2000`. The database file does not exist afterwards.
2. The same claim, citing a path outside the folder, a dotted path, an excluded path, a link that leaves the folder, a `.md` name pointing at a non-note, or a pipe, is not judged. The file is not opened. The problem line is the walk's own reason for that entry.
3. An indexed note edited on disk is judged from the disk text, the result says the index is behind, and `record: true` does not write a belief.
4. A `file.md#pN` ref or a passage id is judged from the indexed text. When the disk file has since changed, the verdict is still about the indexed text and the result says so.
5. A folder whose `--exclude` matches nothing judges nothing in that folder and names the pattern. A second declared folder still returns verdicts.
6. `npm test`, `npm run typecheck`, and `npm run probes` pass, and the new probe goes red when the empty-database case is broken.

## Declared folders

A declared folder is one notes directory plus its exclude patterns. Dotted entries are excluded. There is no `--include-dotted` on this command; a dotted note that was ingested with that flag remains reachable by passage ref, because that path reads the index.

Folders come from three places, and all three count:

- `chamber mcp --notes <path>` (`--exclude <pattern>` repeats, and binds to the `--notes` it follows). The same grammar works when the server is started as `node src/mcp_server.ts --notes <path>`, which is the checkout line the README already documents.
- The `ingest` roots in the config file, each with the excludes already stored on that root.
- Every distinct `ingestRoot` already stored on a `vault_page` row. The harness calls `checkClaims` with no config and no `--notes`, and today's absolute-path verdicts resolve through those rows. Leaving them out makes `check: an agent's claims are judged against the note it cites` return `no notes folder declared` for a note it just ingested. A root that exists only on rows has the dotted and symlink rules and no extra excludes: an exclude passed once on the `chamber ingest` command line is not stored anywhere, so the check cannot replay it. Excludes the check enforces are the ones on `--notes` and in config. The README already says to put them in config before the first ingest.

`~` is expanded the way config roots already are. A missing config file means no config roots, which is what `loadConfig` does today. A config file that does not parse, or whose roots overlap each other, still fails the call out loud. This design does not relax ingest's overlap ban.

The same resolved path declared twice merges its excludes. A `--notes` folder and a config root that resolve to the same path do too.

Nested folders are allowed, including a `--notes` folder inside a config root. A file is read only when every declared folder that contains it allows it. An inner exclude adds a restriction. It does not lift an outer one. So:

```bash
chamber mcp --notes ~/Vault --exclude transcripts --notes ~/Vault/research --exclude raw
```

`~/Vault/research/raw/a.md` is refused because of `raw`. `~/Vault/transcripts/a.md` is refused because of `transcripts`. `~/Vault/research/b.md` is read: it passes both folders.

An `--exclude` before any `--notes`, a repeated flag with no value, and any flag this command does not define (`--include-dotted` included) exit the process with the message on stderr and nothing on stdout, before the process speaks MCP. A dead server is a failure the host shows. A flag that is skipped would look like the control was on.

On the first `chamber_check` call, each declared folder that has at least one exclude pattern is walked once, far enough to count matches. Folders with no patterns are not walked. The walk does not read file bodies and does not write the database. A pattern that matched nothing poisons that folder for the life of the process: every absolute path under it is unjudged, and stderr names the pattern once. Other folders are unaffected. The walk is not repeated per call. Reconnecting the server is how a fixed pattern takes effect. The config on this machine declares six roots, two of them with a pattern (`transcripts`, `kimi-cli-source`), so the first call walks those two and does not walk Inbox.

The session's working directory is not a declared folder. A user-scoped server is started in whatever directory the host chose.

## How a file is read

`walk` in `src/ingest.ts` and the check call one classifier for a single directory entry: dotted name, exclude, symlink target, dotted target, excluded target, target that leaves the root, directory cycle, not a regular file, not a markdown name, not a markdown target. `walk` becomes a loop over that classifier, so the two cannot drift.

For an absolute path the check walks from each containing declared folder down to the file, classifying every entry on the way. A link the classifier allows is followed, and the open is of the resolved target, with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` on that target, then the regular-file check, the inode re-check, and the 32 MB cap. That is the order `readAndCompare` already uses. Opening the cited path itself with `O_NOFOLLOW` would fail an in-root symlink, and `check: a linked note inside the root and a note with large frontmatter are judged` requires that note to come back `SUPPORTED`. Whether an index row is the same file is decided by the existing realpath match (`sameFile`), not by string equality with the path the agent passed.

A link that resolves outside its declared folder is not opened. The other folder can be named with a second `--notes`. A relative path such as `notes/ops.md` is not joined onto a declared folder, and an unindexed relative path stays `NOT_FOUND`. A relative path that resolves to exactly one indexed file is then judged as that file's absolute path, so it and the absolute path cannot disagree about an edit. A path held by two roots stays `NOT_FOUND` with `held by 2 ingest roots` and is not read. Joining a relative source onto a folder would let it read a file the index never agreed was the one cited.

A file the walk cannot read is not judged, even when an index row exists. That covers a file that is gone (`run chamber prune` when a row exists), a file over 32 MB, a file whose body is empty, and a pipe. A pipe must return without blocking; the harness bound is five seconds. The indexed text is not a fallback for an absolute path. A passage ref is the only citation that is judged from the row when the file is gone.

## Verdicts

`NO_SOURCE`, `NO_TERMS`, and `TERMS_ABSENT` keep their meaning. `SUPPORTED` still means every recognised term occurs in the judged text. It does not mean the sentence follows from the note.

| Cited source | Text judged | Status | Extra line | `record: true` |
|---|---|---|---|---|
| Absolute path, allowed, no index row | disk | `SUPPORTED` / `TERMS_ABSENT` / `NO_TERMS` | `not indexed yet` | refused |
| Absolute path, index row, disk matches | disk, which equals the index | as today | none | as today, for `SUPPORTED` |
| Absolute path, index row, disk differs | disk | from the disk text | `index is behind this file` | refused |
| Absolute path the folder rules refuse, or that cannot be read | nothing | `NOT_FOUND` | the classifier's or the read's reason | refused |
| `file.md#pN` or a passage id, row exists, disk matches | indexed text | as today | none | as today, for `SUPPORTED` |
| `file.md#pN` or a passage id, row exists, disk differs or the file is gone | indexed text | from that text | `file on disk has changed since this passage was indexed` | refused |
| `file.md#pN` or a passage id, no such row | nothing | `NOT_FOUND` | today's problem line | refused |
| Passage ref whose row has no ingest root | nothing | `NOT_FOUND`, as today | today's root-missing line | refused |

A passage ref is judged from the index because that is the text `chamber_ask` showed. An absolute path is judged from disk because that is the text the agent's own read returned.

A claim with several sources is judged only when every source can be judged. One refused source makes the claim `NOT_FOUND` and lists every problem. A verdict from the sources that happened to resolve would certify the claim on a partial reading.

`record: true` still goes through `enforceClaimContract` and still only for `SUPPORTED`. It is allowed only when an index row holds the judged text and the file on disk still matches that row. Every other `SUPPORTED` result is returned with the line `not recorded: the index does not hold this text`, and nothing is written. That covers a disk reading with no row, a disk reading whose row is behind, and a passage ref whose disk file has since changed: pinning the old row would record a belief against text the file no longer contains. A claim that is not `SUPPORTED` is still not recorded, and it does not gain that line.

Displayed refs for a disk reading are `<path relative to the outermost containing declared folder>#pN`, so a file inside both `~/Vault` and `~/Vault/research` is cited as `research/b.md#p0`.

`NOT_FOUND`'s summary line becomes `not judged — a cited source could not be read`. The problem line carries the reason. The current summary, `resolved to an indexed note`, is false for a file the folder rules refused. `STALE` stays in the status union and keeps its summary, so an old transcript still parses. This server no longer returns it for an edited file, and a row with no ingest root stays `NOT_FOUND` with the line it has today. No new `STALE` case is added.

When every cited source is an absolute path and the resolved database file does not exist, the call does not create it. Each such verdict includes `not indexed yet`. A passage ref needs the index, so that call may open the database and therefore create it, which is what `openChamberDb` does today. `chamber_ask`, `chamber_verify`, and `chamber_corpus` are unchanged and still open the database on first use.

The index comparison reads existing rows. It does not embed, and it does not write.

## Errors

- No declared folder, absolute path: `NOT_FOUND`, problem `no notes folder declared — chamber mcp --notes <folder>`. Passage refs still resolve against the index.
- Folder poisoned by an exclude that matched nothing: `NOT_FOUND`, problem `--exclude matched nothing: "<pattern>" — nothing in this folder was checked`. Stderr names it once on the walk.
- Unknown flag or a missing flag value: exit 1, stderr, no stdout, no MCP framing.
- Unreadable config, or config roots that overlap: the check throws, as a tool call already does when `loadConfig` throws. Declared `--notes` folders are not consulted in place of a broken config.
- The limits on claims per call, sources per claim, and claim length stay as they are and are still enforced before any file is read.

## What the server tells the host

`INSTRUCTIONS` and the `chamber_check` tool description gain the same facts, in the words they already use:

- The check reads notes from folders declared with `--notes` or with the config's ingest roots.
- An absolute path is the file on disk. A passage ref is the indexed text.
- `SUPPORTED` means the recognised terms occur in the judged text. It does not mean the sentence follows, and a negated or reversed sentence built from the note's own words still passes.

The description stops saying that the check first requires the note to be indexed and unchanged. That sentence is what this design changes.

## Tests

**Classifier parity**, in the harness. One tree holding a dotted link target, a link that leaves the root, a `.md` link to a JSON file, an excluded target, a pipe, and a directory cycle. `walk` and the check's path walk classify each entry the same way, including the reason string.

**The stranger probe**, `probes/check_declared_notes.ts`, added to the `probes` script in `package.json`. It spawns `src/mcp_server.ts` the way `check: chamber_check over MCP` already does: one `initialize` and one `tools/call`, with `--notes` on argv and `CHAMBER_DB` pointed at a path that does not exist. An in-process `checkClaims` call does not pass through `getDb`, so it cannot show that the server created a database. The probe asserts `TERMS_ABSENT` and the missing term `2000`, then asserts the database path still does not exist. A second process, `chamber mcp --not-a-flag`, must exit 1 with nothing that parses as JSON on stdout. Breaking the disk read, creating the database, or answering a bad flag with MCP framing fails the probe.

**Harness cases beside it.**

- An indexed note edited on disk: verdict from the new text, problem `index is behind this file`, `record: true` writes no belief.
- A `file.md#p0` ref after that edit: verdict from the indexed text, problem `file on disk has changed since this passage was indexed`.
- Two folders, one with `--exclude` matching nothing: that folder's claim is `NOT_FOUND` and names the pattern; the other folder's claim is a verdict.
- No `--notes` and no config roots: `NOT_FOUND` with `no notes folder declared — chamber mcp --notes <folder>`.
- A claim citing one allowed file and one path outside the folder: `NOT_FOUND`, and the allowed file's terms do not produce `SUPPORTED`.
- The absolute path of an in-root symlink, and the real path of a note ingested through a containing symlink, are both judged from disk. `docs/KNOWN_LIMITATIONS.md` currently says the real path comes back `STALE` because following it would mean re-deriving the walk's rules. The shared classifier is that re-derivation. `check: letter case is free; a note under a linked folder fails closed` changes with it: both paths are judged, and a link that leaves the root is still not read.

These existing assertions change, and the plan updates them in the same change rather than leaving them red:

- `check: a note edited or deleted since ingest is not judged`. An edit is judged from the new text (`Postgres` supported, `SQLite` absent) and says the index is behind. The comment above that assertion is the reason: judging the old copy let `SQLite` pass for a note that no longer says it. A file added under the ingested root is judged and says `not indexed yet`, not `NOT_FOUND`. A deleted absolute path stays unjudged and still says `chamber prune`.
- `check: files that are not plain notes are never read`, the hidden-folder link, the excluded-target link, and the symlink-escape assertion. The reason substrings and the five-second FIFO bound stay. The status becomes `NOT_FOUND`, because `STALE` is no longer returned for a file the rules refuse.
- `check: a nested root that excluded a note does not hide the outer root's copy` stays `SUPPORTED`. The inner exclude was an argument to `ingestDirectory` and is not stored, and the same two roots in a config file are still rejected as overlap. The check does not invent excludes it cannot see.

## Docs

The README install line becomes:

```bash
claude mcp add -s user chamber -- npx -y @bu7umaid/chamber mcp --notes ~/Notes
```

A Cursor `mcp.json` entry is shown with the same arguments and the same `--notes`. The README this branch carries does not mention Cursor.

Every README sentence that says an edited note, or the real path of a note inside a linked folder, comes back `STALE` and is not judged, is rewritten. On this branch those sentences are in the ingest section and the MCP section. On main, the lead example says it too. The replacement says the verdict is about the file on disk and an edited indexed note adds `index is behind this file`.

One line states the Node floors that were measured. Node 22.23.1 runs the published package and prints Node's experimental-SQLite warning. Node 20.20.2 exits with `ERR_UNKNOWN_BUILTIN_MODULE` because `node:sqlite` does not exist there. Node 23.6 remains the floor for a checkout, because that path runs TypeScript. The `engines` field stays `>=23.6`. Lowering it would let a checkout start on Node 22 and die inside type stripping. The guard in `bin/chamber.js` covers Node below 23.6 only when `dist/` is absent, so the README line is the warning an npx user on Node 20 actually sees.

`docs/KNOWN_LIMITATIONS.md` is not rewritten beyond a dated correction on the `chamber_check` bullet. That bullet says a note inside a symlinked folder is `STALE` at its real path, because following the link would mean re-deriving the walk's rules in the check. After this change the shared classifier is that re-derivation, the real path is judged from disk, and an edited file is no longer `STALE`. Leaving the bullet as it stands would document a refusal the code no longer makes.

## Out of scope

- A `chamber check` CLI command. The same function can grow one later. This plan's caller is the MCP tool.
- A Stop hook, a plugin manifest, and a catch corpus. Each is a later project and each depends on this one.
- Making ingest skip unchanged passages, cap embedder batches, or run the scheduled job from a release.
- Reading a file outside a declared folder, following a link that leaves one, or treating the process's working directory as a folder.
- Writing the index from the check, embedding during the check, and creating a database on an absolute-path-only call.
- Changing `engines`, the Obsidian plugin's README, or the package name.
