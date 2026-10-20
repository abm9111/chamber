import { sha256 } from "./hash.ts";

/**
 * Recompute a vault_page pin from the stored row.
 * This is the only vault-page formula. `upsertDocument` (src/vector.ts) calls
 * this function to mint the stored hash, so there is no second copy to keep
 * byte-identical. The contract test is
 * `pins/upsertDocument stores the hash vaultPageHash returns`.
 *
 * The framing is JSON.stringify of a fixed 3-element array, NOT
 * [...].join("\n"): joining is not injective across its own separator, so
 * {title:"X", body:"Y\nZ"} and {title:"X\nY", body:"Z"} hashed identically.
 * That let a pin verify against a document it was not computed from, and made
 * an edit moving a newline from the end of a title to the start of a body
 * undetectable drift. JSON escapes separators inside each field, so the array
 * framing itself is unambiguous about where one field ends and the next
 * begins.
 *
 * That is a claim about the separators, not about the whole formula, and it
 * does not by itself make this function injective: title and source_ref are
 * nullable columns, and `row.title ?? ""` — coalescing NULL to "" *before*
 * building the array — collapsed exactly the distinction JSON.stringify was
 * introduced to preserve, because the coalescing ran before the array existed
 * rather than inside it. `JSON.stringify([null, body, ref])` and
 * `JSON.stringify(["", body, ref])` are different strings; `?? ""` made sure
 * the formula never produced the first one, so a title or source_ref that
 * flipped between SQL NULL and "" between ingests hashed identically — the
 * same undetectable-drift failure the array framing above exists to close,
 * reopened one line later. The values below are therefore passed through,
 * not defaulted: NULL stays `null` and "" stays `""`. The one default that
 * remains, `?? null`, is not a coalesce-to-placeholder — it normalizes
 * `undefined` to `null`, because inside a JSON array a bare `undefined`
 * element also serializes to `null`, and leaving that implicit would make the
 * formula correct only by the accident that SQLite always yields `null` and
 * never `undefined` for these columns.
 */
export function vaultPageHash(row: {
  title: string | null;
  body: string;
  source_ref: string | null;
}): string {
  return sha256(
    JSON.stringify([row.title ?? null, row.body, row.source_ref ?? null]),
  );
}
