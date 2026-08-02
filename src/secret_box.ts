/**
 * Local secret box for OAuth tokens at rest.
 * CHAMBER_TOKEN_KEY = 32-byte key as base64 or 64-char hex.
 * If unset, stores plaintext with prefix "plain:" (dev only).
 */

import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX_ENC = "enc:v1:";
const PREFIX_PLAIN = "plain:";

function deriveKey(): Buffer | null {
  const raw = process.env.CHAMBER_TOKEN_KEY;
  if (!raw || !raw.trim()) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
  } catch {
    /* fall through */
  }
  // Derive from passphrase
  return createHash("sha256").update(raw).digest();
}

export function hasTokenKey(): boolean {
  return !!deriveKey();
}

/** Encrypt for DB storage. */
export function sealSecret(plaintext: string): string {
  const key = deriveKey();
  if (!key) {
    if (process.env.NODE_ENV === "production" && process.env.CHAMBER_REQUIRE_TOKEN_KEY === "1") {
      throw new Error("CHAMBER_TOKEN_KEY required in production");
    }
    return PREFIX_PLAIN + plaintext;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX_ENC +
    Buffer.concat([iv, tag, ct]).toString("base64url")
  );
}

/** Decrypt from DB. */
export function openSecret(stored: string): string {
  if (stored.startsWith(PREFIX_PLAIN)) {
    return stored.slice(PREFIX_PLAIN.length);
  }
  if (!stored.startsWith(PREFIX_ENC)) {
    // Legacy plaintext row
    return stored;
  }
  const key = deriveKey();
  if (!key) {
    throw new Error("CHAMBER_TOKEN_KEY required to decrypt sealed token");
  }
  const buf = Buffer.from(stored.slice(PREFIX_ENC.length), "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function generateTokenKey(): string {
  return randomBytes(32).toString("base64");
}
