/**
 * Common English words, for one decision in claim_support.ts: whether a
 * capitalised word right after a label colon is an ordinary word or a name.
 *
 * A label is followed by a capital whatever comes next, so the capital says
 * nothing. Checking every such word flagged answers formatted as
 * "**Claude Code:** Users point…" — 6 of 9 flags on the community-corpus
 * answers were "Users", "People", "Claiming", "Large" (2026-09-27). A word on
 * this list is skipped there; any other word is checked, so "Manufacturer:
 * Tesla" is caught. Sentence starts after . ! ? use it only in
 * `chamber_check` (TermOptions.openings); for model answers a hand-written
 * list flagged too many ordinary openers — see atSentenceStart().
 *
 * Hand-written, not derived from a licensed frequency list. Nouns that are
 * also brand or product names (apple, amazon, windows, claude, word, drive,
 * sync…) and words that are values (may, first) are deliberately left out:
 * missing a common word costs a false flag, including a brand costs a miss.
 */

const WORDS = `
a about above across act action actually add after again against age ago agree ahead aim air all allow almost
alone along already also although always among amount an analysis and another answer any anyone anything
approach area around as ask at available avoid away back bad base basic be because become before begin behind
being believe below best better between big bit both bring build business but by call can care case cause
certain chance change check choice choose claim clear close come common community compare complete concept
consider context continue control copy core cost could course create current data day deal decide default
depend describe design detail develop difference different direct do document does done down each early easy
edit effect either else end enough entire error even event ever every everyone everything example exist
expect experience explain extra fact fail fair far fast feature feel few field file final find fine fit
fix focus follow for form found free from full future general get give go goal good great group grow guide
half hand happen hard have he help her here high his hold how however human idea if important in include
increase information inside instead interest into issue it item its just keep key kind know large later
learn least leave less let level life like likely limit line link list little live local long look lose lot
low main maintain make manage manual many matter maybe mean method might mind miss model more most
move much must name natural near need never new next no none normal not note nothing now number of off offer
often old on once one only open option or order other others our out over own part people perhaps person
personal place plan plus point possible post power prefer present pretty problem process provide
public put question quick quite rather read real reason recent record reduce related remain remember report
require result return review right risk role rule run same save say search see seem send set several
share short should show side similar simple since single size small so solution some someone something
sometimes source specific start state step still stop store such suggest support sure system take talk task
team tell term test than that the their them then there these they thing think this those though through time
to today together too tool top total track true try turn type under understand unless until up update use
used useful user usually value very view want way we well what when where whether which while who whole why
with within without work world would write wrong year yes yet you your
access account actual additional advice agent answers approaches argue article aspect assume attempt author
avoid benefit block bring browse bug capture certain chat clean client collect comment complex concern
confirm connect content convert correct count cover criticism custom daily debate deep delete detect dispute
doubt draft easy effort enable ensure entry especially evaluate exact expert export fetch folder format
frequent handle hide highlight import improve input install instance judge large layer limit load manage mention
merge modern monthly multiple native note notes offline online output own paid pay performance plugin
power practical prefer price privacy private product prompt quality rank raise rate reach ready regular reliable
remote reply request respond response rewrite safe scope secure security select sense server service setup
simple skip slow smart sort speed stable standard strong structure style subscription summary switch tag
theme trust trusted typical unclear upload usage version voice warn weak web week whole wish worry
during per via despite unlike whereas upon toward towards beyond besides beside onto per unless
once twice meanwhile otherwise therefore thus hence overall finally firstly secondly lastly additionally
furthermore moreover instead rather regardless given following according based compared running setting
getting putting using having making taking going coming looking asking building adding
`;

export const COMMON_WORDS: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));

/** Is `word` (any case) a common word, allowing plain English inflections? */
export function isCommonWord(word: string): boolean {
  const w = word.toLowerCase().replace(/['’]s$/, "");
  if (COMMON_WORDS.has(w)) return true;
  // Plural, past and -ing only, each leaving a stem of 3+ letters. -er, -est
  // and -ly turned names into listed words (Finder → find, Forest → for), and
  // a 2-letter stem made Bing "be" (review B, 2026-09-27).
  const stems = [
    w.replace(/ies$/, "y"),
    w.replace(/es$/, ""),
    w.replace(/s$/, ""),
    w.replace(/ed$/, ""),
    w.replace(/ed$/, "e"),
    w.replace(/ing$/, ""),
    w.replace(/ing$/, "e"),
    w.replace(/(\p{L})\1ing$/u, "$1"), // running → run
    w.replace(/(\p{L})\1ed$/u, "$1"), // stopped → stop
  ];
  return stems.some((s) => s !== w && s.length >= 3 && COMMON_WORDS.has(s));
}
