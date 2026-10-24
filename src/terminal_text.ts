/**
 * Text that came out of a file or a child process and is about to be printed to
 * a terminal.
 */

/**
 * `text` as a JSON string, with DEL and the C1 controls written as \u00XX too.
 * JSON.stringify escapes quotes, backslashes and the C0 controls (ESC among
 * them) but leaves U+007F and U+0080-U+009F raw, and a terminal acts on U+009B
 * (the 8-bit CSI). For text that comes out of a file or a child's stderr and
 * goes to a terminal. A loop, not a regular expression: a control-character
 * class is what the no-control-regex rule refuses.
 */
export function jsonForTerminal(text: string): string {
  let out = "";
  for (const ch of JSON.stringify(text)) {
    const c = ch.codePointAt(0) ?? 0;
    out += c === 0x7f || (c >= 0x80 && c <= 0x9f) ? `\\u${c.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}
