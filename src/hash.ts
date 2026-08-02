import { createHash } from "node:crypto";

/** Canonical claim hash — kills revision-mint livelock when used as upsert key. */
export function claimHash(type: string, text: string): string {
  const canonical = `${type}\n${text.trim().replace(/\s+/g, " ")}`;
  return sha256(canonical);
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
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
