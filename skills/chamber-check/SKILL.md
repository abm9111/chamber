---
name: chamber-check
description: Use when an answer repeats numbers, names, dates, or file names taken from the user's notes or Obsidian vault, before stating them, or when the user asks whether something you said is actually in their notes. Runs Chamber's local check, which confirms those terms occur in the cited note. It does not judge meaning.
---

# Check claims against the user's notes

Chamber confirms that every number, capitalised name, domain, file name and
count in a claim occurs in the note it came from. It runs on the user's
machine, with no model and no network.

## When

- Before you state a figure, name, date or file name you read in the user's notes.
- When the user asks "is that actually in my notes?" about something you said.
  Check the earlier answer claim by claim.

## How

1. Split the answer into single factual claims. One claim per sentence.
2. Call `chamber_check` with each claim and the note it came from: the absolute
   path you read, a `file.md#p3` ref, or a passage id.
3. Report each result as Chamber returns it:
   - `SUPPORTED`: the recognised terms occur in that note.
   - `TERMS_ABSENT`: say the note does not support it. Do not state the claim as fact.
   - `NOT_FOUND`: say the note was not found under the declared folders.
   - `not indexed yet` or `index is behind this file`: the check read the file
     on disk; the index has not caught up with it.

## What a pass does not prove

`SUPPORTED` is string matching. A negated or reversed sentence built from the
note's own words still passes. Lowercase names and ordinary words are not
checked. Do not tell the user a claim is "verified" or "true"; say its terms
occur in the note.

## If the `chamber_check` tool is missing

Chamber is not connected. Tell the user, and give them one of these:

```
/plugin install chamber --marketplace abm9111/chamber
```

or, without the plugin:

```
claude mcp add -s user chamber -- npx -y @bu7umaid/chamber mcp --notes ~/Notes
```

Do not imitate the check by reading the note yourself and calling it verified.
