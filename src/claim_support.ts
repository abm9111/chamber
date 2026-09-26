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
const NUMBER =
  /\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)*(?:\s?(?:k|mn|bn|thousand|million|billion|trillion|lakh|crore)(?![\p{L}\p{N}])|(?<=\p{Nd})m(?![\p{L}\p{N}])|\s?%)?/giu;
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
    .replace(/[*_`#>]/g, " ");
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
  return !ABBREVIATION.test(before);
}

const ABBREVIATION =
  /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|approx|ca|cf|incl|esp|Dr|Mr|Mrs|Ms|Prof|St|Inc|Ltd|Co|Corp|No|Fig|Vol|p|pp)\.$/i;

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
  let text = stripMarkup(claim);
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
  const haystack = passages.join("\n");
  const numeric = haystack.replace(THOUSANDS, "$1");
  return specificTerms(claim).filter((term) => {
    const num = /^([\p{Nd}][\p{Nd},.]*)(.*)$/u.exec(term);
    if (num) return !numberFound(numeric, num[1]!, num[2]!.trim());
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
function numberFound(numeric: string, digits: string, suffix: string): boolean {
  const tail =
    suffix === ""
      ? "(?![\\p{Nd}]|[.,]\\p{Nd})"
      : `\\s?${escapeRegex(suffix)}(?![\\p{L}\\p{N}])`;
  return new RegExp(`(?<![\\p{Nd}.,])${escapeRegex(digits)}${tail}`, "iu").test(numeric);
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
