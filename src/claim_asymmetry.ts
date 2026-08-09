/**
 * Cheap evidence that two similar-looking claims are NOT the same claim.
 *
 * The paraphrase leg of the citation-debt gate blocks a new assertion when it
 * embeds close to the claim text of an open blocking debt. Calibration on
 * 2026-08-09 (`fixtures/paraphrase_calibration.json`) measured what that costs:
 * at the shipped 0.80, every number swap and every negation in the set is
 * blocked — "within 30 days" against "within 14 days" scores 0.910, "enforces
 * the sandbox" against "does not enforce the sandbox" scores 0.904. So an
 * operator *correcting* an indebted claim is refused on the grounds that the
 * correction restates it, which is close to the opposite of the intent.
 *
 * The cause is not the constant. Cosine over a bag-of-meaning embedding cannot
 * separate "says the same thing" from "says the opposite thing about the same
 * subject", and no threshold in the 0.50–0.99 sweep classifies the set cleanly.
 * This module supplies the missing signal in the two places it is cheapest to
 * detect, using text already in hand and no model.
 *
 * It is only ever allowed to *suppress* a block, never to cause one. That
 * direction is deliberate: this is a blocklist, and `src/mcp_bridge.ts` records
 * what happens when a blocklist is asked to decide what is permitted (twice —
 * the description, then the name). Asked only to narrow, its failure mode is a
 * paraphrase that gets through, which is the pre-existing behaviour of this leg
 * and not a new exposure. Asked to permit, its failure mode would be new.
 *
 * What it does not do: it says nothing about the 2-of-5 true paraphrases the
 * threshold already misses, and it cannot see disagreement that is neither
 * numeric nor negated — "opens at nine" against "closes at nine" is a real
 * contradiction that scores 0.880 and survives this check untouched.
 */

/** Number words this recognises. Deliberately small; see `readNumbers`. */
const UNITS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Negation markers, as a closed set of function words.
 *
 * Kept tight on purpose. "without", "fails to" and "refuses to" are genuine
 * negators, but they are also the kind of word a faithful paraphrase swaps in
 * and out ("without a receipt" / "unless they have a receipt"), and a marker
 * that fires on a true restatement costs a false negative in the leg this is
 * meant to improve. Contractions are matched by the `n't` suffix rather than
 * enumerated, so "isn't" and "shouldn't" need no entries.
 *
 * **"no" is deliberately absent, and it was measured out.** With it in the set,
 * `long_form_true_paraphrase` — a genuine restatement — was suppressed, because
 * one side phrases a positive rule negatively: "No production deployment may go
 * out unless the freeze has been in effect." That is a constraint, not a denial,
 * and English writes rules that way constantly. Dropping "no" keeps every
 * contradiction in the set suppressed (they all use "not" or "cannot") and
 * costs one real case: "no refunds are issued" against "refunds are issued"
 * reads as the same polarity here. A missed suppression leaves the gate exactly
 * where it was; a wrong one refuses a correct commit.
 */
const NEGATORS = new Set([
  "not", "never", "cannot", "none", "neither", "nor",
]);

/**
 * Lowercased word tokens; hyphens split so "seventy-two" is two tokens.
 *
 * Apostrophes are kept and the curly form is normalised to the straight one, so
 * "isn't" survives as a single token for the `n't` suffix test below. Splitting
 * it into "isn" and "t" would silently drop every contracted negation, which is
 * most of them in ordinary prose.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
}

/**
 * Every number in `text`, as a set of values.
 *
 * Digits and number words normalise to the same value, so "30 days" and "thirty
 * days" agree rather than reading as a swap. Adjacent tens-then-unit pairs fold
 * ("seventy two" → 72), which covers the hyphenated compounds a policy note
 * actually contains.
 *
 * It does not parse "a hundred and five", decimals, or ordinals. Those return
 * their parts or nothing, and the only consequence is that this check declines
 * to fire — which leaves the gate exactly where it was.
 */
export function readNumbers(text: string): Set<number> {
  const tokens = tokenize(text);
  const out = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^\d+$/.test(t)) {
      out.add(Number(t));
      continue;
    }
    const tens = TENS[t];
    if (tens !== undefined) {
      const next = tokens[i + 1];
      const unit = next === undefined ? undefined : UNITS[next];
      // "seventy two" is one number; "seventy days" is not.
      if (unit !== undefined && unit >= 1 && unit <= 9) {
        out.add(tens + unit);
        i++;
      } else {
        out.add(tens);
      }
      continue;
    }
    const unit = UNITS[t];
    if (unit !== undefined) out.add(unit);
  }
  return out;
}

/** How many negation markers `text` carries. */
export function countNegators(text: string): number {
  return tokenize(text).filter((t) => NEGATORS.has(t) || /.n't$/.test(t)).length;
}

export interface AsymmetryVerdict {
  /** True when the two texts carry evidence of being different claims. */
  differs: boolean;
  /** Which signal fired, for the audit record and the operator's message. */
  reason?: "number_conflict" | "negation_polarity";
  /** Human-readable detail, e.g. "30 vs 14". */
  detail?: string;
}

/**
 * Do these two claims disagree in a way a restatement would not?
 *
 * **Numbers.** Fires only on a genuine *swap*: each side must carry a value the
 * other lacks. Mere inequality would fire when a paraphrase adds a figure the
 * original left implicit ("within 30 days" / "within 30 days, or 5 working days
 * for card refunds"), and suppressing there would let a real restatement past.
 * Requiring conflict in both directions still catches every case the
 * calibration set contains.
 *
 * **Negation.** Compares parity rather than count, so "does not enforce" against
 * "enforces" fires, two separately-negated claims do not, and a double negative
 * reads as the positive it is.
 */
export function claimsDifferMaterially(a: string, b: string): AsymmetryVerdict {
  const na = readNumbers(a);
  const nb = readNumbers(b);
  if (na.size > 0 && nb.size > 0) {
    const onlyA = [...na].filter((n) => !nb.has(n));
    const onlyB = [...nb].filter((n) => !na.has(n));
    if (onlyA.length > 0 && onlyB.length > 0) {
      return {
        differs: true,
        reason: "number_conflict",
        detail: `${onlyA.join(", ")} vs ${onlyB.join(", ")}`,
      };
    }
  }
  if (countNegators(a) % 2 !== countNegators(b) % 2) {
    return {
      differs: true,
      reason: "negation_polarity",
      detail: "one claim negates what the other asserts",
    };
  }
  return { differs: false };
}
