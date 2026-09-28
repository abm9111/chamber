/**
 * Does a cited passage contain the specifics of the claim that cites it?
 *
 * The pin gate proves a passage exists and is unchanged. It cannot say whether
 * the passage says what the claim says, and a model citing a real passage for
 * a sentence it never contains got `[ALLOWED]` — measured live, 2026-09-26:
 * "Kingroon filament is manufactured on the Moon and costs $900 per kg [1]"
 * over a real filament note.
 *
 * This is not entailment and does not pretend to be. It checks the parts of a
 * claim that are cheap to check mechanically and expensive to get wrong:
 * numbers, capitalised names and domains. Every one must occur somewhere in
 * the cited passages. A fabrication built only from words the passage already
 * holds ("the policy forbids returns") passes — KNOWN_LIMITATIONS §2.
 *
 * Failing closed costs a real claim its `[ALLOWED]`: it lands as DEBT or
 * UNSUPPORTED with the missing terms named, which is visible and recoverable.
 * Failing open is the defect this exists to remove, so ambiguity resolves
 * toward "missing".
 */

/**
 * Capitalised words that open sentences and label lists. Excluded because a
 * passage need not repeat a model's connective tissue — "However" is not a
 * name. Kept short on purpose: every entry is a word the check can no longer
 * see, and matching is already case-insensitive, so any word the passage does
 * contain passes without being listed here.
 */
const CONNECTIVES = new Set([
  "a", "an", "the", "this", "that", "these", "those", "it", "its", "they",
  "their", "there", "here", "he", "she", "we", "you", "i", "in", "on", "at",
  "for", "with", "by", "from", "of", "to", "as", "and", "but", "or", "if",
  "when", "while", "also", "both", "each", "every", "all", "some", "most",
  "many", "several", "other", "others", "only", "not", "no", "yes", "however",
  "according", "based", "per", "via", "note", "overall", "additionally",
  "otherwise", "then", "so", "thus", "because", "although", "unlike",
]);

/** Domains end in a label a model might write bare: `3DPrintU.ae`, `amazon.com`. */
import { isCommonWord } from "./common_words.ts";

const DOMAIN = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|ae|net|org|io|co|ai|dev|app|store|shop|uk|us|de|sa)\b/gi;
/**
 * A file name with a code or document extension, with any directory path in
 * front of it; the term is the base name. Lowercase names were no term at
 * all, so a claim that a plan "modifies package.json" passed against a note
 * that never mentions it (checker benchmark, 2026-09-27: 2 of 25 invented
 * values were file names). Checked by base name so "tests live in
 * prune.test.mjs" is judged against a passage that gives the full path.
 */
const FILE =
  /(?<![\p{L}\p{N}_.~/-])(?:[\p{L}\p{N}_.~-]+\/)*([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.(?:json|jsonl|md|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|sh|ya?ml|toml|ini|cfg|conf|txt|csv|tsv|sql|html|css|xml|lock|ipynb|pdf|sqlite|db))(?![\p{L}\p{N}_])/giu;
/** "Node.js", "Next.js": a product name, left to the name rules. */
const PRODUCT_JS = /^\p{Lu}[\p{L}\p{N}]*\.js$/u;

/**
 * Counts written as words. "Plan 2 added four entries" passed against a note
 * saying two (checker benchmark, 2026-09-27): only digits were terms. "one"
 * is left out — it is a pronoun at least as often ("no one", "one of").
 * A count is found as the word or as its digits, either way round.
 */
const UNITS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
/**
 * A hyphenated ordinal or fraction is not a count: "twenty-first" is not 20,
 * "two-thirds" not 2, "three-quarters" not 3 (review B, 2026-09-27). Closed
 * lists, and an ordinal only after a tens word: a suffix pattern (-st, -nd,
 * -th) also swallowed "five-month", "three-second", "two-hand" (review D).
 */
const ORDINAL = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth";
const FRACTION = "half|halves|thirds?|quarters?|fifths?|sixths?|sevenths?|eighths?|ninths?|tenths?";
const WORD_END = "(?![\\p{L}\\p{N}_])";
const NUMBER_WORD = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:(${TENS.slice(2).join("|")})(?:[- ](${UNITS.slice(1).join("|")}))?(?!-(?:${ORDINAL})${WORD_END})|(${[...UNITS.slice(2), ...TEENS].join("|")}))${WORD_END}(?!-(?:${FRACTION})${WORD_END})`,
  "giu",
);
function numberWordValue(word: string): number | undefined {
  const w = word.toLowerCase().split(/[- ]/);
  if (w.length === 1) {
    const u = UNITS.indexOf(w[0]!);
    if (u >= 2) return u;
    const t = TEENS.indexOf(w[0]!);
    if (t >= 0) return 10 + t;
    const d = TENS.indexOf(w[0]!);
    return d >= 2 ? d * 10 : undefined;
  }
  const d = TENS.indexOf(w[0]!), u = UNITS.indexOf(w[1]!);
  return d >= 2 && u >= 1 ? d * 10 + u : undefined;
}
/**
 * Does the passage spell out the count `n`? Each spelled number is read whole,
 * so "five" inside "fifty-five" is 55, not 5 — a word search let "fifty-five"
 * satisfy "5" and "seventy-seven" satisfy "seventy" (self-review).
 */
function spelledFound(haystack: string, n: number): boolean {
  for (const m of haystack.matchAll(NUMBER_WORD)) {
    // "-five" is minus five, as "-5" is: not a count of five.
    if (haystack[m.index - 1] === "-" && !/[\p{L}\p{N}]/u.test(haystack[m.index - 2] ?? "")) continue;
    if (numberWordValue(m[0]) === n) return true;
  }
  return false;
}
/**
 * A spelled count's digits, standing alone: "four" is not satisfied by the 4
 * in `Qwen3.5-2B-Q4_K_M` (review C: the benchmark claim that motivated counts
 * as terms was still passing that way).
 */
function countDigitsFound(numeric: string, n: number): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_.,-])${n}(?![\\p{L}\\p{N}_]|[.,]\\p{Nd})`, "u").test(numeric);
}
/**
 * A number, with its thousands separators and every dotted part, so a version
 * (`0.84.4`) or an address (`127.0.0.1`) is one term. Taking one decimal part
 * split them into `0.84` and a stray `4` that no passage holds on its own —
 * measured on the vault eval, 2026-09-26.
 */
//
// Any script's digits (`\p{Nd}`): an ASCII-only `\d` never saw `٩٠٠`, and a
// claim that wrote its number that way was checked for nothing. A scale word
// or suffix stays attached, so `$9 billion` and `9k` are not satisfied by a
// passage that says `$9` (review, 2026-09-26).
// A leading minus stays with its number when it is a sign, not a range dash:
// "-5%" and "5%" satisfied each other (VIGIL AIML-003), while "19-25" is two
// numbers.
// `k` and `m` only glued to the number: a spaced `k` was captured as "5 k"
// but could not match itself once spacing was refused for single letters
// (round-5 review).
const NUMBER =
  /(?:(?<![\p{N}%°+)\]]\uE000*)(?<![\p{L}_])-\uE000*)?\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)*(?:\s?(?:k|mn|bn|thousand|million|billion|trillion|lakh|crore)(?![\p{L}\p{N}])|(?<=\p{Nd})m(?![\p{L}\p{N}])|\s?%)?/giu;

/**
 * Applied to claim and passage alike, so both sides read one spelling.
 * Every dash that serves as a minus (en dash, the Unicode minus, hyphen and
 * fullwidth forms — not the em dash, which is punctuation) becomes `-`:
 * "fell –5%" and "fell −5%" were read unsigned (round-5 review). Dotted
 * initialisms lose their dots, so `U.S.` and `US` are one term rather than
 * `U` and `S`.
 */
/**
 * Where markup stood: not alphanumeric, so a word edge; skipped by signs.
 * A private-use code point, so it cannot occur in text by accident (and is
 * not a control character, which lint rightly refuses in a regex).
 */
const SEP = "\uE000";

function normalize(text: string): string {
  return text
    // Markup becomes SEP, a boundary for words and numbers that the sign
    // rules see through. Deleting it (359d706) merged neighbours — "2*3"
    // satisfied "23", "Tes*la" satisfied "Tesla" — and covered only `*` and
    // backticks, so "-_5%_", "-~~5%~~", "-<b>5%</b>" still hid a sign
    // (VIGIL on 359d706). Claim and passage alike.
    // Minus entities are minus signs (VIGIL AIML-006).
    .replace(/&minus;|&#8722;|&#x2212;/gi, "-")
    .replace(/<\/?[A-Za-z][^<>]{0,200}>/g, SEP)
    .replace(/~~|==/g, SEP)
    // `_` inside a token is part of it — "1_000", "MAX_PASSAGES" — and only
    // at a token's edge is it emphasis. Turning every `_` into a boundary
    // let "1" be satisfied by "1_000" (VIGIL AIML-007). A digit group
    // separator is dropped so "1_000" reads as 1000.
    .replace(/(\p{Nd})_(?=\p{Nd})/gu, "$1")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, SEP)
    .replace(/[*`]/g, SEP)
    .replace(/[‐‑‒–−﹣－]/g, "-")
    // One apostrophe: models write ’, scraped notes keep ' — "You’re" was
    // flagged against a passage quoting "You're" (community corpus, 2026-09-27).
    .replace(/[’‘ʼ]/g, "'")
    // Spaced forms too ("J. R. R.", "U. S."), without eating the space after
    // the last dot — round-6 review flagged "J.R.R." against "J. R. R.".
    .replace(/(?<![\p{L}\p{N}])(?:\p{Lu}\.(?:\s(?=\p{Lu}\.))?){2,}/gu, (m) =>
      m.replace(/[.\s]/g, ""),
    );
}
/**
 * A name: a capitalised word or acronym in any script (`Škoda`, `Möbius` —
 * an ASCII class cut the latter to `M`), optionally led by digits (`9XFabs`,
 * `3DPrintU`), or a lowercase-led word with an inner capital (`eBay`).
 * Hyphens and apostrophes inside are kept.
 */
const NAME =
  /(?<![\p{L}\p{N}_])(?:\p{N}*\p{Lu}[\p{L}\p{N}_]*|\p{Ll}+\p{Lu}[\p{L}\p{N}_]*)(?:['’-][\p{L}\p{N}_]+)*/gu;

function stripMarkup(text: string): string {
  return text
    .replace(/^\s*\d{1,3}[.)]\s+/, "") // list numbering is not a claimed number
    // A bullet ("- ", "* " — already markup here — "+ ", "• ") opens a line
    // as a sentence start does; left in, "- **Privacy:** …" made "Privacy" a
    // mid-sentence word and it was flagged (community corpus, 2026-09-27).
    .replace(/^\s*[-+•\uE000]\s+/u, "")
    .replace(/\[\d{1,2}\]/g, " ") // citations are not claims about the source
    .replace(/[#>]/g, " ");
}

/**
 * Is the word at `index` the first word of a sentence or clause?
 *
 * English capitalises it whatever it is, so "Made in China" makes "Made" look
 * like a name. Treating it as one flagged ordinary sentences — measured on the
 * first run of this check. A sentence-initial word is therefore only checked
 * when its shape says name regardless of position: an acronym (`UAE`), an
 * inner capital (`AliExpress`) or a digit (`3DPrintU`). The cost is stated
 * rather than hidden: a fabrication whose only specific is its opening plain
 * name ("Tesla makes it [1]") is not caught.
 */
function atSentenceStart(text: string, index: number): boolean {
  // Sentence ends only; label colons are handled in afterLabel().
  const before = text.slice(0, index).replace(new RegExp(SEP, "g"), " ").trimEnd();
  if (before === "") return true;
  // A closing quote or bracket after the stop still ends the sentence:
  // '…the same cliff.” [2] Models can…' flagged "Models" on a real answer
  // (the citation is blanked, leaving .” before the word).
  if (!/[.!?]["'”’)\]]*$/.test(before)) return false;
  // The abbreviation tests read the text up to the stop: "Dr.” Tesla" and
  // "(see U.S.) Tesla" still leave the name checked.
  const stop = before.replace(/["'”’)\]]+$/, "");
  // A period after an abbreviation ends no sentence: "e.g. Tesla" and
  // "Dr. Tesla" left the name unchecked (round-2 review, VIGIL AIML-001).
  // By list, and by shape: the list alone was a blocklist, and "a.k.a.",
  // "U.S.", "Jr." each hid the next name (VIGIL AIML-001). Dotted initials and
  // one- or two-letter words before a period are read as abbreviations. Being
  // wrong here only means the next word is checked — the safe direction.
  return !(
    ABBREVIATION.test(stop) ||
    /(?:^|[\s(“‘"'])(?:\p{L}{1,3}\.){2,}$/u.test(stop) ||
    // A capitalised one- or two-letter word (Jr., Sr., Mt.); longer titles
    // are listed. Round 5 widened this to any capitalised word of up to five
    // letters, and "Paris.", "China.", "Sony." then hid nothing but flagged
    // the next sentence's ordinary opening word (round-6 review).
    /(?:^|[\s(“‘"'])\p{Lu}\p{Ll}?\.$/u.test(stop)
  );
}

const ABBREVIATION =
  /(?:^|[\s(“‘"'])(?:e\.g|i\.e|vs|etc|approx|ca|cf|incl|esp|Dr|Mr|Mrs|Ms|Prof|St|Inc|Ltd|Co|Corp|No|Fig|Vol|p|pp|Sgt|Gen|Rev|Bros|Dept|Ave|Univ|Col|Capt|Lt|Gov|Sen|Rep|Ft|Blvd|Rd|Est|Assn|Jr|Sr)\.$/i;

/**
 * Is the word at `index` the first word after a label colon ("**Access
 * control:** People recommend…")? Models format answers this way constantly,
 * and checking the ordinary word there produced 6 of 9 flags on the
 * community-corpus answers (2026-09-27: "Users", "People", "Claiming",
 * "Large"). Only a common word is skipped here, so "Manufacturer: Tesla" is
 * still checked. Sentence starts after . ! ? keep their older rule: widening
 * the common-word test to them flagged ordinary openers ("Sales", "Shipping")
 * that a hand-written list cannot cover.
 */
function afterLabel(text: string, index: number): boolean {
  return /:$/.test(text.slice(0, index).replace(new RegExp(SEP, "g"), " ").trimEnd());
}

/**
 * Does the phrase carry on after `end` — another word (past spaces, markup,
 * slashes, quotes, brackets) or a label colon? A lone value does not: "Model:
 * Claude [1]", "Released: May 5", "Price: Free [1]". Requiring a lowercase
 * word flagged "**Privacy / “where…”:**" and "Pointing Claude Code at…" on the
 * community corpus.
 */
function continues(text: string, end: number): boolean {
  return /^[\s\uE000/&"“”'‘’(),;|→—–-]*(?:\p{L}|:)/u.test(text.slice(end));
}

function looksLikeName(word: string): boolean {
  return /\p{N}/u.test(word) || /^.+\p{Lu}/u.test(word);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Thousands separators dropped, so `1,210` in a claim matches `1210` in a
 * passage and back. Only a comma followed by exactly three digits is one: a
 * decimal comma (`1,5`) was collapsed too, and `15 EUR` then matched a
 * passage saying `1,5 EUR` — a tenfold error certified (review, 2026-09-26).
 */
const THOUSANDS = /(\p{Nd}),(?=\p{Nd}{3}(?!\p{Nd}))/gu;
function bareNumber(n: string): string {
  // A trailing comma is punctuation ("Tier 1, easily"), not part of the
  // number — leaving it flagged "1," on the vault eval.
  return n.replace(/\uE000/g, "").replace(THOUSANDS, "$1").replace(/[.,]+$/, "");
}

/**
 * The specific terms of a claim, in order of appearance, deduplicated
 * case-insensitively. Exported for tests and for the diagnostic reason string.
 */
export interface TermOptions {
  /**
   * Also check a capitalised word opening a sentence, unless it is a common
   * word. Off for model answers, where it flagged ordinary openers ("Sales",
   * "Shipping"); on for `chamber_check`, whose callers state one claim at a
   * time and usually open it with its subject — "Postgres was chosen in 2024"
   * passed against a note saying SQLite (review of chamber_check).
   */
  openings?: boolean;
}

export function specificTerms(claim: string, opts: TermOptions = {}): string[] {
  let text = stripMarkup(normalize(claim));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string): void => {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  };
  // Domains first, then blank them out: `Amazon.ae` must be checked as one
  // term, not as the name `Amazon` plus nothing.
  for (const m of text.matchAll(DOMAIN)) add(m[0]);
  text = text.replace(DOMAIN, " ");
  text = text.replace(FILE, (whole: string, base: string) => {
    if (PRODUCT_JS.test(whole)) return whole;
    add(base);
    return " ";
  });
  for (const m of text.matchAll(NUMBER_WORD)) add(m[0].toLowerCase().replace(" ", "-"));
  for (const m of text.matchAll(NUMBER)) add(bareNumber(m[0]));
  for (const m of text.matchAll(NAME)) {
    if (CONNECTIVES.has(m[0].toLowerCase())) continue;
    if (numberWordValue(m[0]) !== undefined) continue;
    if (looksLikeName(m[0])) {
      add(m[0]);
      continue;
    }
    // An ordinary word in an opening position: on the common list, and the
    // phrase carries on ("Users point…", "**Privacy:**"). A lone value after a
    // label ("Model: Claude [1]", "Released: May 5") is checked.
    const ordinary = isCommonWord(m[0]) && continues(text, m.index + m[0].length);
    const wrapped = /\uE000[\s\uE000]*$/u.test(text.slice(0, m.index));
    if (atSentenceStart(text, m.index)) {
      // A plain opener keeps the older rule on model answers. Markup right
      // before it — "**Tesla** makes it [1]", "- **Tesla:** makes…" — is the
      // way models set a subject apart, and was checked until the label-colon
      // change stripped markup here (review B, 2026-09-27); it stays checked.
      // A plain opener under `openings` is skipped when common, whatever
      // follows: "One NVIDIA A100…" and "Adding --live…" open sentences, not
      // labels, and requiring the phrase to carry on flagged them.
      if (wrapped ? ordinary : opts.openings ? isCommonWord(m[0]) : true) continue;
    } else if (afterLabel(text, m.index) && ordinary) {
      continue;
    }
    add(m[0]);
  }
  return out;
}

/**
 * Terms of `claim` that occur in none of `passages`. Empty means supported as
 * far as this check can see; it never means "true".
 *
 * Numbers match on digit boundaries so `90` is not found inside `900` or
 * `2090`. Words match case-insensitively on word boundaries so `Moon` is not
 * found inside `Moonlight`.
 */
export function missingTerms(claim: string, passages: string[], opts: TermOptions = {}): string[] {
  return missingTermsIn(claim, joinPrepared(passages.map(preparePassage)), opts);
}

/**
 * Between passages: a private-use character no term pattern matches or treats
 * as space. Joined with "\n", a spaced unit crossed the join — "…was 5" ending
 * one passage and "million users…" opening the next satisfied "5 million",
 * which neither passage says (review A, 2026-09-27).
 */
const BETWEEN = "\n\uE001\n";

/**
 * The text a citation shows: the passage body, plus the names in its title
 * and file path. The model is shown "[n] title (path)" above each body, so a
 * company named only in its page's path ("…companies_flexengage") was flagged
 * on a claim that quoted it (held-out benchmark, 2026-09-28: 3 of 10 wrong
 * flags). Only names come from title and path — their digits are dropped, so
 * a date in a path ("2026-09-27__…") cannot supply a claimed "27". All three
 * are covered by the passage's pin hash.
 */
export function citedPassage(body: string, title: string | null, sourceRef: string | null): PreparedText {
  const path = (sourceRef ?? "").replace(/#p\d+$/, "").replace(/\.(?:md|markdown)$/i, "").replace(/[_/.#]+/g, " ");
  const names = `${title ?? ""}\n${path}`.replace(/\p{Nd}+/gu, " ");
  return joinPrepared([preparePassage(body), preparePassage(names)]);
}

/** A passage normalised once, for callers that judge many claims against it. */
export interface PreparedText {
  haystack: string;
  numeric: string;
}
export function preparePassage(body: string): PreparedText {
  const haystack = normalize(body);
  return { haystack, numeric: haystack.replace(THOUSANDS, "$1") };
}
export function joinPrepared(parts: PreparedText[]): PreparedText {
  return {
    haystack: parts.map((p) => p.haystack).join(BETWEEN),
    numeric: parts.map((p) => p.numeric).join(BETWEEN),
  };
}

/** `missingTerms` over passages already prepared (and joined). */
export function missingTermsIn(claim: string, text: PreparedText, opts: TermOptions = {}): string[] {
  return termsMissingIn(specificTerms(claim, opts), text);
}

/** Which of `terms` (from specificTerms) the prepared text does not hold. */
export function termsMissingIn(terms: string[], text: PreparedText): string[] {
  const { haystack, numeric } = text;
  return terms.filter((term) => {
    const counted = numberWordValue(term);
    if (counted !== undefined) {
      return !(countDigitsFound(numeric, counted) || spelledFound(haystack, counted));
    }
    const num = /^(-?[\p{Nd}][\p{Nd},.]*)(.*)$/u.exec(term);
    const suffix = num?.[2]!.trim() ?? "";
    // Only a bare number or a number with a unit takes the number path. A
    // digit-led *name* (`3DPrintU`, `9XFabs`) sent there lost its word edge
    // ("Buy3DPrintU" satisfied it) and its possessive/hyphen handling
    // (round-4 review); names keep the name rules.
    if (num && (suffix === "" || UNIT.test(suffix))) {
      if (numberFound(numeric, num[1]!, suffix)) return false;
      if (scaledValueFound(numeric, num[1]!, suffix)) return false;
      // "3 tools" against a note that says "three tools".
      return !(suffix === "" && /^\p{Nd}{1,2}$/u.test(num[1]!) && spelledFound(haystack, Number(num[1])));
    }
    return !nameFound(haystack, term);
  });
}

/**
 * Every number-led term — bare, or with `%`, `m`, `k`, `lakh`, a scale word —
 * is found on digit boundaries in the thousands-normalised passage: no digit,
 * `.` or `,` before it, no further digit (or decimal part) after it. Matching
 * the suffixed forms as words, which `d4bb231` did, treated `.` as a word
 * edge, and "5%" was found inside "0.5%", "5 million" inside "2.5 million"
 * (round-3 review). One optional space between number and suffix, so "9%"
 * and "9 %" are the same claim.
 */
/**
 * A quantity written at another scale: "1 million" for "1M", "11,000" for
 * "11k", "$2.4m" for "2.4 million" (held-out benchmark, 2026-09-28: 3 of 10
 * wrong flags). Compared by value, and only when one side carries a scale
 * word — two bare numbers keep the digit-boundary rules above. A sign must
 * agree. `m` is read as million, as in "$5m"; the spaced "5 m" (metres) was
 * never a scale here and still is not.
 */
const SCALE: Readonly<Record<string, number>> = {
  "": 1, k: 1e3, thousand: 1e3, lakh: 1e5, m: 1e6, mn: 1e6, million: 1e6, crore: 1e7, bn: 1e9, billion: 1e9, trillion: 1e12,
};
function scaledValue(digits: string, suffix: string): number | undefined {
  const scale = SCALE[suffix.toLowerCase()];
  if (scale === undefined) return undefined;
  const n = Number(digits.replace(/,/g, ""));
  return Number.isFinite(n) ? n * scale : undefined;
}
function scaledValueFound(numeric: string, digits: string, suffix: string): boolean {
  const want = scaledValue(digits, suffix.trim());
  if (want === undefined) return false;
  const claimScaled = SCALE[suffix.trim().toLowerCase()] !== 1;
  for (const m of numeric.matchAll(NUMBER)) {
    const term = bareNumber(m[0]);
    const parts = /^(-?[\p{Nd}][\p{Nd},.]*)(.*)$/u.exec(term);
    if (!parts) continue;
    const suf = parts[2]!.trim();
    const have = scaledValue(parts[1]!, suf);
    if (have === undefined) continue;
    if (!claimScaled && SCALE[suf.toLowerCase()] === 1) continue;
    if (Math.abs(have - want) <= Math.abs(want) * 1e-9) return true;
  }
  return false;
}

/** The units a number-led term may carry; anything else makes it a name. */
const UNIT = /^(?:%|k|m|mn|bn|thousand|million|billion|trillion|lakh|crore)$/i;
/**
 * Units a space may separate from their number. Not `m` or `k`: with a space
 * allowed, "$5m" was satisfied by "5 m long" — metres certifying millions —
 * and "3M tape" by "3 m tape" (round-4 review).
 */
const SPACED_UNIT = /^(?:%|k|mn|bn|thousand|million|billion|trillion|lakh|crore)$/i;

function numberFound(numeric: string, digits: string, suffix: string): boolean {
  const space = SPACED_UNIT.test(suffix) ? "\\s?" : "";
  const tail =
    suffix === ""
      ? // A bare number is not found in one that carries a scale: "9 users"
        // was satisfied by "9 million users" and "11 stores" by "11k stores"
        // (found 2026-09-28). A spaced "m" is metres, not a scale.
        "(?![\\p{Nd}]|[.,]\\p{Nd})(?!(?:k|m|mn|bn)(?![\\p{L}\\p{N}])|\\s?(?:thousand|million|billion|trillion|lakh|crore)(?![\\p{L}\\p{N}]))"
      : `${space}${escapeRegex(suffix)}(?![\\p{L}\\p{N}])`;
  // A dash is a sign when nothing alphanumeric stands before it — after a
  // space, `(`, `|`, `=`, `:`, a quote, a comma... (round-5 review: "|-5%|"
  // and "change=-5%" satisfied an unsigned "5%"). After a digit it is a
  // range ("19-25"), after a letter a version or id ("AGPL-3.0", "TASK-003").
  // A signed claim needs the same: "-3.0" is not satisfied by "AGPL-3.0".
  // A dash is a range or id marker only right after a letter, a digit, a
  // unit or a closing bracket ("19-25", "AGPL-3.0", "2°–8°C", "10%–20%",
  // "12+–18", "(a)-3"); anywhere else it is a minus. Round 6 had it the
  // other way round — a closed list of sign positions — and markdown was not
  // on it: "**-5%**" certified "Sales grew 5%" (VIGIL AIML-002). Every
  // character not known to end a quantity now leaves the dash a sign.
  // A dash is a range or id marker right after a letter (AGPL-3.0), or
  // after a quantity — a digit, %, °, +, a closing bracket — with or without
  // markup between (19-25, 2°–8°C, **10%**–20%). Anywhere else, including
  // after a letter *and markup* ("<td>Q3 sales</td><td>-5%" — VIGIL
  // AIML-005, which 4693bfb introduced by skipping markup after letters
  // too), it is a minus.
  // `[^]`, not `.`: `.` does not match a line break (VIGIL on 6e20674).
  const quantity = "[\\p{N}%°+)\\]]";
  const sep = "\\uE000*";
  const signed = digits.startsWith("-");
  const body = signed ? `-${sep}${escapeRegex(digits.slice(1))}` : escapeRegex(digits);
  const before = signed
    ? `(?<!${quantity}${sep})(?<![\\p{L}_.,])`
    : `(?<![\\p{Nd}.,])(?<!(?<!${quantity}${sep})(?<![\\p{L}_])-${sep})`;
  return new RegExp(`${before}${body}${tail}`, "iu").test(numeric);
}

/**
 * A name is present if the passage has it whole, or has it without the
 * inflection prose adds to it, or — for a hyphenated join — has every part.
 *
 * "buy Kingroon's PLA" and "the AliExpress-Kingroon deal" were each flagged
 * against a passage that names Kingroon and AliExpress plainly (review,
 * 2026-09-26). The fallbacks only ever strip to something the claim already
 * said, and every part must still be found on its own. A plural fallback was
 * tried and removed: it turned `Mars` into `Mar`, which a passage's "Mar 5"
 * satisfied.
 */
function nameFound(haystack: string, term: string): boolean {
  if (containsWord(haystack, term)) return true;
  const base = term.replace(/['’]s?$/i, "");
  if (base !== term && base !== "" && containsWord(haystack, base)) return true;
  // An acronym's plural (`LLMs`, `APIs`) against its singular. Only for an
  // all-caps stem: the general plural fallback turned `Mars` into `Mar`.
  if (/^\p{Lu}{2,}s$/u.test(base) && containsWord(haystack, base.slice(0, -1))) return true;
  const parts = base.split("-").filter(Boolean);
  return parts.length > 1 && parts.every((p) => nameFound(haystack, p));
}

// `_` counts: "MAX_PASSAGES" is one token, not satisfied by "MAX_OTHER".
const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
const isLower = (c: string | undefined): boolean => c !== undefined && /\p{Ll}/u.test(c);
const isUpper = (c: string | undefined): boolean => c !== undefined && /\p{Lu}/u.test(c);

/**
 * Case-insensitive whole-word search, where a lower-to-upper case change also
 * counts as a word edge. Scraped tables glue cells together —
 * `Soap Making & FormingHandicraft workshops` — and a model that splits them
 * back into words is quoting its source faithfully; plain `\b` flagged it.
 * `Moonlight` still does not contain `Moon`: that edge is lower-to-lower.
 */
function containsWord(haystack: string, term: string): boolean {
  const low = haystack.toLowerCase();
  const needle = term.toLowerCase();
  for (let i = low.indexOf(needle); i !== -1; i = low.indexOf(needle, i + 1)) {
    const end = i + needle.length;
    const left =
      !isAlnum(haystack[i - 1]) || (isLower(haystack[i - 1]) && isUpper(haystack[i]));
    // A letter followed by a digit is an edge too: a family name before its
    // version ("Qwen" in "Qwen3.5-122B") was flagged on a faithful claim.
    const right =
      !isAlnum(haystack[end]) ||
      (isLower(haystack[end - 1]) && isUpper(haystack[end])) ||
      (/\p{L}/u.test(haystack[end - 1] ?? "") && /\p{Nd}/u.test(haystack[end] ?? ""));
    if (left && right) return true;
  }
  return false;
}
