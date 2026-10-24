/**
 * Text that came out of a file, a child process or the network and is about to
 * be printed to a terminal.
 */

/** The short escapes JSON has: the two quoting characters and five controls. */
const SHORT_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
]);

/**
 * One code point that is a letter, a mark, a number, punctuation or a symbol
 * (Unicode general categories L, M, N, P, S). `\p{}` is not a control-character
 * class, so the no-control-regex rule has nothing to refuse. A lone surrogate
 * is a code point to this expression and is in none of these categories.
 */
const KEPT: RegExp = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/** `\uXXXX` for one UTF-16 code unit. */
function unitEscape(unit: number): string {
  return `\\u${unit.toString(16).padStart(4, "0")}`;
}

/**
 * `text` as a JSON string literal that is safe to print: a character is kept
 * only if it is the space (U+0020) or a letter, mark, number, punctuation mark
 * or symbol (general categories L, M, N, P, S), and every other code point is
 * written as \uXXXX, as a surrogate pair above U+FFFF. That covers the C0
 * controls, DEL and the C1 controls (a terminal acts on U+009B, the 8-bit CSI),
 * the format characters (bidi overrides and isolates, zero-width characters, the
 * byte order mark, the Arabic letter mark), the line and paragraph separators,
 * every space but U+0020 (the no-break and ideographic spaces among them),
 * private-use characters, lone surrogates and code points that are unassigned.
 * A closed set rather than a list of what to escape: a character this does not
 * know about is escaped, not passed.
 *
 * `"` and `\` and the five controls JSON has a short form for (\b \f \n \r \t)
 * are written as JSON.stringify writes them, so JSON.parse of the result is the
 * input. The price is that text which needs an escaped character to read right
 * shows the escape: the zero-width joiner inside an emoji sequence, the
 * zero-width non-joiner in Persian, the ideographic space in Chinese.
 *
 * For text that comes out of a file, a child's stderr or a server and goes to a
 * terminal. A loop and `\p{}`, not a control-character class in a regular
 * expression, which is what the no-control-regex rule refuses.
 */
export function jsonForTerminal(text: string): string {
  let out = '"';
  for (const ch of text) {
    const short = SHORT_ESCAPES.get(ch);
    if (short !== undefined) {
      out += short;
      continue;
    }
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x20 || KEPT.test(ch)) {
      out += ch;
    } else if (c > 0xffff) {
      const offset = c - 0x10000;
      out += unitEscape(0xd800 + (offset >> 10)) + unitEscape(0xdc00 + (offset & 0x3ff));
    } else {
      out += unitEscape(c);
    }
  }
  return `${out}"`;
}
