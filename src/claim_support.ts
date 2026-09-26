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
const DOMAIN = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|ae|net|org|io|co|ai|dev|app|store|shop|uk|us|de|sa)\b/gi;
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
  /(?:(?<![\p{L}\p{N}%°+)\]])-)?\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)*(?:\s?(?:k|mn|bn|thousand|million|billion|trillion|lakh|crore)(?![\p{L}\p{N}])|(?<=\p{Nd})m(?![\p{L}\p{N}])|\s?%)?/giu;

/**
 * Applied to claim and passage alike, so both sides read one spelling.
 * Every dash that serves as a minus (en dash, the Unicode minus, hyphen and
 * fullwidth forms — not the em dash, which is punctuation) becomes `-`:
 * "fell –5%" and "fell −5%" were read unsigned (round-5 review). Dotted
 * initialisms lose their dots, so `U.S.` and `US` are one term rather than
 * `U` and `S`.
 */
function normalize(text: string): string {
  return text
    .replace(/[‐‑‒–−﹣－]/g, "-")
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
  /(?<![\p{L}\p{N}])(?:\p{N}*\p{Lu}[\p{L}\p{N}]*|\p{Ll}+\p{Lu}[\p{L}\p{N}]*)(?:['’-][\p{L}\p{N}]+)*/gu;

function stripMarkup(text: string): string {
  return text
    .replace(/^\s*\d{1,3}[.)]\s+/, "") // list numbering is not a claimed number
    .replace(/\[\d{1,2}\]/g, " ") // citations are not claims about the source
    // Emphasis markers removed, not spaced: "**10%**–20%" must keep its
    // dash next to the quantity it follows, or the range reads as a minus.
    .replace(/[*`]/g, "")
    .replace(/[_#>]/g, " ");
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
  // Sentence ends only. A first version also counted `: ; — – ( -` as
  // openers, which skipped every name after a label or a dash —
  // "Manufacturer: Tesla [1]" and "Kingroon PLA (Tesla) [1]" were ALLOWED.
  const before = text.slice(0, index).trimEnd();
  if (before === "") return true;
  if (!/[.!?]$/.test(before)) return false;
  // A period after an abbreviation ends no sentence: "e.g. Tesla" and
  // "Dr. Tesla" left the name unchecked (round-2 review, VIGIL AIML-001).
  // By list, and by shape: the list alone was a blocklist, and "a.k.a.",
  // "U.S.", "Jr." each hid the next name (VIGIL AIML-001). Dotted initials and
  // one- or two-letter words before a period are read as abbreviations. Being
  // wrong here only means the next word is checked — the safe direction.
  return !(
    ABBREVIATION.test(before) ||
    /(?:^|[\s(])(?:\p{L}{1,3}\.){2,}$/u.test(before) ||
    // A capitalised one- or two-letter word (Jr., Sr., Mt.); longer titles
    // are listed. Round 5 widened this to any capitalised word of up to five
    // letters, and "Paris.", "China.", "Sony." then hid nothing but flagged
    // the next sentence's ordinary opening word (round-6 review).
    /(?:^|[\s(])\p{Lu}\p{Ll}?\.$/u.test(before)
  );
}

const ABBREVIATION =
  /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|approx|ca|cf|incl|esp|Dr|Mr|Mrs|Ms|Prof|St|Inc|Ltd|Co|Corp|No|Fig|Vol|p|pp|Sgt|Gen|Rev|Bros|Dept|Ave|Univ|Col|Capt|Lt|Gov|Sen|Rep|Ft|Blvd|Rd|Est|Assn|Jr|Sr)\.$/i;

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
  return n.replace(THOUSANDS, "$1").replace(/[.,]+$/, "");
}

/**
 * The specific terms of a claim, in order of appearance, deduplicated
 * case-insensitively. Exported for tests and for the diagnostic reason string.
 */
export function specificTerms(claim: string): string[] {
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
  for (const m of text.matchAll(NUMBER)) add(bareNumber(m[0]));
  for (const m of text.matchAll(NAME)) {
    if (CONNECTIVES.has(m[0].toLowerCase())) continue;
    if (atSentenceStart(text, m.index) && !looksLikeName(m[0])) continue;
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
export function missingTerms(claim: string, passages: string[]): string[] {
  const haystack = normalize(passages.join("\n"));
  const numeric = haystack.replace(THOUSANDS, "$1");
  return specificTerms(claim).filter((term) => {
    const num = /^(-?[\p{Nd}][\p{Nd},.]*)(.*)$/u.exec(term);
    const suffix = num?.[2]!.trim() ?? "";
    // Only a bare number or a number with a unit takes the number path. A
    // digit-led *name* (`3DPrintU`, `9XFabs`) sent there lost its word edge
    // ("Buy3DPrintU" satisfied it) and its possessive/hyphen handling
    // (round-4 review); names keep the name rules.
    if (num && (suffix === "" || UNIT.test(suffix))) {
      return !numberFound(numeric, num[1]!, suffix);
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
      ? "(?![\\p{Nd}]|[.,]\\p{Nd})"
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
  const range = "[\\p{L}\\p{N}%°+)\\]]";
  // Closing emphasis may sit between the quantity and the dash
  // ("**10%**–20%"). `[^]`, not `.`: `.` does not match a line break, so a
  // minus opening a line read unsigned — "Sales grew 5%" came back ALLOWED
  // over "…:\n-5%" end to end (VIGIL on 6e20674).
  const closers = "[*_`]*";
  const before = digits.startsWith("-")
    ? `(?<!${range}${closers}|[.,])`
    : `(?<![\\p{Nd}.,])(?<!(?:^|(?![*_\`])(?!${range})[^])${closers}-)`;
  return new RegExp(`${before}${escapeRegex(digits)}${tail}`, "iu").test(numeric);
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

const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
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
    const right =
      !isAlnum(haystack[end]) || (isLower(haystack[end - 1]) && isUpper(haystack[end]));
    if (left && right) return true;
  }
  return false;
}
