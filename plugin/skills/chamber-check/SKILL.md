---
name: chamber-check
description: Use when an answer repeats numbers, names, dates, or file names taken from the user's notes or Obsidian vault, before stating them, or when the user asks whether something you said is actually in their notes. Runs Chamber's local check, which confirms those terms occur in the cited note. It does not judge meaning.
---

# Check claims against the user's notes

Chamber confirms that every number, capitalised name, domain, file name and
count in a claim occurs in the note it came from. The check runs on the user's
machine, with no model and no network.

## When

- Before you state a figure, name, date or file name you read in the user's notes.
- When the user asks "is that actually in my notes?" about something you said.
  Check the earlier answer claim by claim.

## How

1. Split the answer into single factual claims. One claim per sentence.
2. Call `chamber_check` with each claim and the note it came from: the absolute
   path you read, a `file.md#p3` ref, or a passage id.
3. Report each result by its label, and read the lines under it, which say why:
   - `SUPPORTED`: the recognised terms occur in that note.
   - `TERMS_ABSENT`: the note lacks the terms listed. Do not state the claim as fact.
   - `NO_TERMS`: the claim has nothing Chamber can check. Nothing was verified;
     do not call it supported.
   - `NOT_FOUND`: a cited source could not be read. The line under it says why:
     outside the declared folders, excluded, too large, empty, or missing. Do
     not tell the user the note does not exist unless that line says so.
   - `STALE`: the note on disk no longer matches the index. Not judged.
   - `NO_SOURCE`: you cited nothing. Cite the note and check again.

## What a pass does not prove

`SUPPORTED` is string matching. A negated or reversed sentence built from the
note's own words still passes. Lowercase names and ordinary words are not
checked. Do not tell the user a claim is "verified" or "true"; say its terms
occur in the note.

## If the `chamber_check` tool is missing

Chamber is not connected. Tell the user, and do not imitate the check by
reading the note yourself and calling it verified.

- If the user has not installed it (Claude Code 2.1.275 or later):
  `/plugin install chamber --marketplace abm9111/chamber`
- If the plugin is installed, its server failed to start. Common causes: Node
  older than 22.5 (Chamber needs `node:sqlite`), or no notes folder set; run
  `/plugin configure chamber@chamber`. `/mcp` shows the server's error.
- Outside Claude Code, any MCP host:
  `npx -y @bu7umaid/chamber@0.2.1 mcp --notes /absolute/path/to/Notes`
