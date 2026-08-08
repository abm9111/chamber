import { createHash } from "node:crypto";

/** Canonical claim hash — kills revision-mint livelock when used as upsert key. */
export function claimHash(type: string, text: string): string {
  const canonical = `${type}\n${text.trim().replace(/\s+/g, " ")}`;
  return sha256(canonical);
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * JSON with object keys in a fixed order, so the same value always produces the
 * same bytes.
 *
 * Anything hashed or signed has to agree on those bytes across processes and
 * across a round trip through a file — `JSON.stringify` preserves insertion
 * order, so a receipt that was parsed and re-serialised can hash differently
 * while being the same value. `omitKeys` drops fields at any depth, which is how
 * a signature is excluded from the bytes it signs.
 */
export function stableStringify(
  value: unknown,
  omitKeys: readonly string[] = [],
): string {
  const omit = new Set(omitKeys);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !omit.has(k))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, walk(val)]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** Content pin for corpus citations — never hash a URL alone. */
export function snapshotHash(parts: {
  body: string;
  authorOrPageId: string;
  publishedAt?: string;
  mediaTranscript?: string;
}): string {
  const payload = [
    parts.body.trim(),
    parts.authorOrPageId,
    parts.publishedAt ?? "",
    parts.mediaTranscript ?? "",
  ].join("\n");
  return sha256(payload);
}

export function newId(prefix = "ch"): string {
  return `${prefix}_${sha256(`${Date.now()}-${Math.random()}`).slice(0, 16)}`;
}
