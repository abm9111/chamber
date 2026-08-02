/**
 * Passage-level chunking for markdown corpus ingest.
 *
 * WHY THIS EXISTS
 *
 * Ingest used to store one `vector_document` row per file, so an entire
 * long-form note became a single embedding. Two independent mechanisms made
 * long notes unretrievable, and both were measured rather than assumed:
 *
 *  1. TRUNCATION. `scripts/embed_minilm.py` caps the tokenizer at 256 tokens
 *     (`enable_truncation(max_length=256)`). Text past that cap is never
 *     embedded at all — a fact in section 6 of a long note is not "diluted",
 *     it is simply absent from the vector, and no amount of query phrasing can
 *     retrieve it. Measured onset of truncation, by appending a distinctive
 *     tail and checking whether the vector moved: ~1550 chars of easy prose,
 *     ~800 chars of a mixed vault note, ~550 chars of dense markdown (code
 *     spans, links, punctuation). Those three numbers are why the budget below
 *     is counted in estimated *tokens* and not in characters: no single
 *     character cap bounds the window across content types — 550 would be
 *     needed for the worst case, which would shred ordinary prose into
 *     fragments.
 *  2. DILUTION. Whatever does fit is mean-pooled, so one relevant sentence is
 *     averaged against everything around it and a short unrelated note wins on
 *     cosine similarity.
 *
 * The consequence is worse than ordinary poor search. When `ask` retrieves the
 * wrong-but-real note, the model cites it, the pin verifies perfectly against
 * the row it was minted from, and the claim commits `[ALLOWED]`. A citation
 * gate cannot catch a wrong-but-real citation; only chunking can.
 *
 * GUARANTEES this module owns, each pinned by a test:
 *  - deterministic: same body in, byte-identical passages out. Idempotent
 *    ingest rests entirely on this, because the passage ordinal is part of
 *    `sourceRef` and `sourceRef` is a pin-hash input.
 *  - bounded: every passage is at or under `PASSAGE_MAX_TOKENS`, including
 *    pathological input with no paragraph or sentence boundaries anywhere.
 *  - lossless: every non-blank line of the body appears in some passage.
 *  - terminating: the oversized-unit path always makes progress.
 *
 * Zero runtime dependencies — `node:` builtins only, and in fact none are
 * needed here.
 */

/**
 * Hard cap on one passage, in estimated tokens.
 *
 * The real limit is MiniLM's 256, and `estimateTokens` is calibrated to sit at
 * or slightly above the true wordpiece count (see below), so 220 leaves margin
 * on the content types where the estimator is tightest. A passage over the cap
 * loses its tail before it is ever embedded, which is the defect being fixed,
 * so this is a hard bound rather than a preference.
 */
export const PASSAGE_MAX_TOKENS = 220;

/**
 * Size a passage is packed towards before the next unit starts a new one.
 *
 * The tradeoff the whole design turns on: too small and a passage loses the
 * context that makes it interpretable, too large and it reproduces the
 * averaging problem this module exists to fix. 150 estimated tokens is roughly
 * 600–900 characters of prose — two or three paragraphs — which keeps a
 * passage a self-contained unit of argument while staying well clear of the
 * window. Passages are also *prefixed with their heading breadcrumb*, which is
 * what makes the smaller end of this range safe: a short passage still carries
 * the headings that say what it is about.
 */
export const PASSAGE_TARGET_TOKENS = 150;

/**
 * Floor on the content budget once the heading breadcrumb has been charged
 * against the cap. A deeply nested passage with long headings could otherwise
 * be left no room for content at all.
 */
const MIN_CONTENT_TOKENS = 40;

export interface Passage {
  /**
   * 0-based ordinal within the file. This is the identity component: it is
   * what `passageSourceRef` puts in `source_ref`, so it must be a pure
   * function of the body — never of wall-clock time, iteration order of a map,
   * or anything else that could differ between two runs over the same bytes.
   */
  index: number;
  /**
   * Heading breadcrumb, outermost first, heading *text* (not the `#` markers).
   * Empty for a note with no headings. Used to build a human-meaningful title
   * and citation label.
   */
  headings: string[];
  /**
   * The passage text that is embedded, hashed and shown to the model.
   *
   * Begins with the breadcrumb rendered as its original markdown heading
   * lines, then the content slice. The breadcrumb is *in the body* rather than
   * only in the title because `upsertDocument` embeds `body` alone — a passage
   * reading "Records are kept for 90 days" is close to meaningless as a vector
   * unless "# Policy Manual / ## Data / ### Retention" travels with it.
   */
  body: string;
}

/**
 * Approximate the BERT wordpiece count of `text`, with no tokenizer and no
 * dependency.
 *
 * Counts alphanumeric runs (charging longer runs extra, since those are what
 * wordpiece actually splits) plus one for every other non-space character,
 * which is what makes it track dense markdown: backticks, brackets, pipes and
 * hyphens are each roughly a token, and they are exactly what collapses the
 * character-per-token ratio in real notes.
 *
 * Calibration against the measured 256-token truncation boundary of the three
 * corpora described in the module header — the estimate at each true boundary:
 *   easy prose        327   (over-estimates by ~28%; splits early, which is safe)
 *   dense markdown    242
 *   mixed vault note  255
 * Two of three land within 5% of 256 and the third errs towards splitting
 * sooner. Erring that way is the correct direction: an over-estimate costs a
 * slightly smaller passage, an under-estimate costs silently truncated text.
 *
 * Whitespace is deliberately uncounted, which is what lets the packer add
 * `\n\n` between units without having to re-measure the join.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/g)) {
    const t = m[0]!;
    n += t.length > 1 ? Math.ceil(t.length / 6) : 1;
  }
  return n;
}

/**
 * The identity of one passage: the file's root-relative path, plus its
 * ordinal.
 *
 * Chosen over a heading slug (two sections can share a heading, so slugs
 * collide within a file) and over a content hash (a content-addressed ref
 * changes whenever the text changes, which would turn every edit into
 * `not_found` instead of the `hash_mismatch` that tells an operator the note
 * moved under a citation). The ordinal is stable for an unchanged file and
 * shifts for an edited one, which is exactly the drift signal `chamber verify`
 * is built to report.
 *
 * The path is kept as a prefix so that everything downstream that reasons
 * about paths still works: `--exclude` assertions compare against the prefix,
 * and a citation still reads as a location in the vault.
 */
export function passageSourceRef(path: string, index: number): string {
  return `${path}#p${index}`;
}

/**
 * Recover the file path from a passage `source_ref`.
 *
 * Only strips a trailing `#p<digits>`, so a note whose *filename* contains a
 * `#` survives the round trip: `odd#p1.md#p0` → `odd#p1.md`.
 */
export function passagePathOf(sourceRef: string): string {
  return sourceRef.replace(/#p\d+$/, "");
}

// ─── section parsing ─────────────────────────────────────────────────────────

interface Section {
  /**
   * Identity of this section within the note, distinct from its heading text.
   *
   * Two sections can carry the same heading — `## Status` under `# Project` and
   * under `# Archive` is the ordinary shape of a vault note, not an exotic one
   * — so "is this section an ancestor of that one" must be answered by identity.
   * Answering it by comparing heading *line strings* made an unrelated
   * same-titled section count as the carrier of an empty one, and the empty
   * section then vanished from the corpus.
   */
  id: number;
  /** Ids of strict ancestors, outermost first. Parallel to `ancestorLines`. */
  ancestorIds: number[];
  /** Verbatim heading lines of strict ancestors, outermost first. */
  ancestorLines: string[];
  /** This section's own verbatim heading line, or null for the preamble. */
  ownLine: string | null;
  /** Breadcrumb of heading text, ancestors first, including this section. */
  headings: string[];
  /** Content lines, excluding this section's own heading line. */
  lines: string[];
  /** Heading level, 0 for the preamble. */
  level: number;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^[ \t]{0,3}(```+|~~~+)/;

/**
 * Split a body into heading-delimited sections.
 *
 * Fenced code blocks are tracked so that a `# comment` inside a shell block
 * does not register as a heading — that would both invent a bogus section
 * boundary and put shell text into a citation's breadcrumb. A fence is closed
 * only by a marker of the same character and at least the same length, which
 * is what CommonMark requires and what keeps a ```` ``` ```` inside a ````` ~~~ `````
 * block from closing it.
 */
function parseSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  const stack: { id: number; level: number; line: string; text: string }[] = [];
  let nextId = 1;
  let current: Section = {
    id: 0,
    ancestorIds: [],
    ancestorLines: [],
    ownLine: null,
    headings: [],
    lines: [],
    level: 0,
  };
  let fence: string | null = null;

  for (const line of lines) {
    const fenceHit = FENCE_RE.exec(line);
    if (fenceHit) {
      const marker = fenceHit[1]!;
      if (fence === null) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      current.lines.push(line);
      continue;
    }
    // An indented line is a code block, not a heading, even outside a fence.
    const heading = fence === null && !/^ {4,}/.test(line) ? HEADING_RE.exec(line) : null;
    if (!heading) {
      current.lines.push(line);
      continue;
    }

    sections.push(current);
    const level = heading[1]!.length;
    const text = heading[2]!.trim();
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    const ancestorIds = stack.map((s) => s.id);
    const ancestorLines = stack.map((s) => s.line);
    const headings = [...stack.map((s) => s.text), text];
    const id = nextId++;
    stack.push({ id, level, line, text });
    current = {
      id,
      ancestorIds,
      ancestorLines,
      ownLine: line,
      headings,
      lines: [],
      level,
    };
  }
  sections.push(current);
  return sections;
}

// ─── size-bounded packing ────────────────────────────────────────────────────

/** Split lines into paragraphs on blank-line boundaries. */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (buf.length > 0) {
        out.push(buf.join("\n").trim());
        buf = [];
      }
      continue;
    }
    buf.push(line);
  }
  if (buf.length > 0) out.push(buf.join("\n").trim());
  return out.filter((p) => p !== "");
}

/**
 * Cut `text` into pieces of at most `budget` estimated tokens, by character
 * position.
 *
 * The last-resort path, reached only when a single sentence is itself over
 * budget: a base64 blob, a minified line, a wide table row. It must terminate
 * on input containing no separator of any kind, so the cut length is derived
 * from the text's own measured token density and then walked *down* until it
 * fits, with a floor of one character so progress is guaranteed even if the
 * estimate is wildly wrong.
 */
function hardSplit(text: string, budget: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (estimateTokens(rest) <= budget) {
      out.push(rest);
      break;
    }
    const density = rest.length / Math.max(1, estimateTokens(rest));
    let cut = Math.max(1, Math.min(rest.length - 1, Math.floor(budget * density)));
    while (cut > 1 && estimateTokens(rest.slice(0, cut)) > budget) {
      cut = Math.floor(cut * 0.8);
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out;
}

/**
 * Break one oversized paragraph down to units that each fit `budget`:
 * sentences first, then a hard character split for whatever is still too big.
 */
function splitOversized(text: string, budget: number): string[] {
  const sentences = text.split(/(?<=[.!?])[ \t]+|\n/).filter((s) => s.trim() !== "");
  const out: string[] = [];
  for (const s of sentences.length > 1 ? sentences : [text]) {
    if (estimateTokens(s) <= budget) out.push(s);
    else out.push(...hardSplit(s, budget));
  }
  return out;
}

/**
 * Greedily pack units into chunks.
 *
 * A chunk is closed when the next unit would push it over `budget`, or when it
 * has already reached `target`. Closing at `target` rather than only at
 * `budget` is what keeps chunk sizes clustered instead of every chunk being
 * pushed to the very edge of the window, where the estimator has the least
 * margin.
 */
function pack(units: string[], budget: number, target: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  for (const u of units) {
    const ut = estimateTokens(u);
    if (cur.length > 0 && (curTokens + ut > budget || curTokens >= target)) {
      chunks.push(cur.join("\n\n"));
      cur = [];
      curTokens = 0;
    }
    cur.push(u);
    curTokens += ut;
  }
  if (cur.length > 0) chunks.push(cur.join("\n\n"));
  return chunks;
}

// ─── public entry point ──────────────────────────────────────────────────────

/**
 * Split a markdown body into embedding-sized passages.
 *
 * Strategy, in order of preference — coarsest natural boundary first, so a
 * passage is a semantic unit wherever the note gives us one:
 *   1. markdown headings (a heading always starts a new passage);
 *   2. blank-line paragraph boundaries, within an oversized section;
 *   3. sentence boundaries, within an oversized paragraph;
 *   4. a character cut, for text with no boundary of any kind.
 *
 * Setext headings (`Title` underlined with `===` or `---`) are not treated as
 * boundaries — only ATX `#` headings are. They are still ingested, as ordinary
 * content of the surrounding section, so nothing is lost; such a note simply
 * chunks on paragraph boundaries instead of heading ones. Obsidian writes ATX,
 * and `---` is ambiguous with both frontmatter and horizontal rules, which
 * splitFrontmatter already has to disambiguate by heuristic.
 *
 * Sections are never merged with their neighbours even when both are tiny.
 * Merging would buy slightly larger passages at the cost of a breadcrumb that
 * no longer truthfully describes the whole passage, and the breadcrumb is what
 * a citation is displayed as — a passage labelled "## Retention" that also
 * contains half of "## Deletion" is a wrong-but-real citation of exactly the
 * kind this module exists to prevent. Hoisting ancestor headings into every
 * passage already supplies the context that merging was meant to recover.
 */
export function splitPassages(body: string): Passage[] {
  const sections = parseSections(body);
  const passages: Passage[] = [];

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;

    // Charge the breadcrumb against the cap, since it is part of the embedded
    // body. If the headings are so long that no useful content budget is left,
    // drop ancestors from the outside in — the innermost heading is the most
    // informative, and an unbounded prefix would otherwise blow the cap.
    const fullPrefix = [...s.ancestorLines, ...(s.ownLine !== null ? [s.ownLine] : [])];
    let prefixLines = fullPrefix;
    const roomFor = (lines: string[]): number =>
      PASSAGE_MAX_TOKENS - estimateTokens(lines.join("\n"));
    while (prefixLines.length > 1 && roomFor(prefixLines) < MIN_CONTENT_TOKENS) {
      prefixLines = prefixLines.slice(1);
    }
    // Even the innermost heading alone can exhaust the window — a heading that
    // is really a sentence, or one carrying a long URL. The prefix is repeated
    // into every passage of the section and is charged against the same cap as
    // the content, so an unbounded one would push the passage over and have its
    // tail silently dropped before embedding: the exact defect this module
    // exists to remove, reintroduced through its own fix. Demote it to ordinary
    // content instead, where the oversized-unit path below bounds it like
    // anything else and nothing is lost.
    const demoted = roomFor(prefixLines) < MIN_CONTENT_TOKENS;
    const prefix = demoted ? "" : prefixLines.join("\n");
    const budget = Math.max(
      MIN_CONTENT_TOKENS,
      PASSAGE_MAX_TOKENS - estimateTokens(prefix),
    );
    const target = Math.max(1, Math.min(PASSAGE_TARGET_TOKENS, budget));

    // Heading lines the prefix could not keep — trimmed ancestors, or the whole
    // breadcrumb when it was demoted. They are re-entered as ordinary content
    // so they still reach some passage body: an ancestor whose own section was
    // empty emits no passage of its own and relies on a descendant's breadcrumb
    // to carry it, so dropping it here would leave it in no body at all and
    // invisible to retrieval. Content units, not a repeated prefix, so it lands
    // once at the top of the section rather than in every chunk of it.
    const spilled = demoted ? fullPrefix : fullPrefix.slice(0, fullPrefix.length - prefixLines.length);

    const units: string[] = [];
    for (const p of [...spilled, ...paragraphs(s.lines)]) {
      if (estimateTokens(p) <= budget) units.push(p);
      else units.push(...splitOversized(p, budget));
    }

    let chunks = pack(units, budget, target);
    if (chunks.length === 0) {
      // A heading with no content of its own. Its text is not dropped when a
      // following subsection will hoist it into its own breadcrumb; when
      // nothing will, emit the breadcrumb alone so no line of the note is lost.
      // Carried by *a descendant of this section*, matched on section identity
      // rather than on heading text — `## Status` under `# Project` and under
      // `# Archive` are different sections that share a line, and comparing
      // lines let the second one count as the first one's carrier, dropping the
      // first from the corpus entirely.
      const carried =
        s.ownLine !== null && sections.slice(i + 1).some((n) => n.ancestorIds.includes(s.id));
      if (prefix === "" || carried) continue;
      chunks = [""];
    }

    for (const c of chunks) {
      passages.push({
        index: passages.length,
        headings: s.headings,
        body: prefix === "" ? c : c === "" ? prefix : `${prefix}\n\n${c}`,
      });
    }
  }

  // Safety net: a non-blank body must never ingest as nothing. Reaching here
  // would mean every section was skipped, which the `carried` rule above is
  // written to prevent — but the cost of being wrong is a silently missing
  // note, so the invariant is enforced rather than assumed. Split rather than
  // returning the body whole: an unbounded passage here would be truncated at
  // the embedder, which is the very defect this module exists to remove, and a
  // fallback that reintroduces it is not a safety net.
  if (passages.length === 0 && body.trim() !== "") {
    return hardSplit(body.trim(), PASSAGE_MAX_TOKENS).map((b, i) => ({
      index: i,
      headings: [],
      body: b,
    }));
  }
  return passages;
}
