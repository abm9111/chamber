/**
 * Local secret box for OAuth tokens at rest.
 * CHAMBER_TOKEN_KEY = 32-byte key as base64 or 64-char hex, or a passphrase.
 *
 * Storing plaintext is opt-in via CHAMBER_ALLOW_PLAINTEXT_SECRETS=1.
 *
 * Blob formats, both self-describing so old rows keep opening:
 *   enc:v1:  base64url( iv(12) | tag(16) | ct )            -- legacy, read-only
 *   enc:v2:  base64url( salt(16) | iv(12) | tag(16) | ct )
 *   plain:   the secret, in the clear
 *
 * v2 exists because v1 derived a key from a passphrase with a single
 * unsalted SHA-256. Changing that in place would have orphaned every stored
 * token, so the version travels in the blob and `openSecret` dispatches on it.
 */

import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const PREFIX_V1 = "enc:v1:";
const PREFIX_V2 = "enc:v2:";
const PREFIX_PLAIN = "plain:";

const SALT_LEN = 16;
const IV_LEN = 12;
/**
 * GCM tags are 16 bytes here, always, and that is checked rather than assumed.
 *
 * Node accepts authentication tags of 4, 8 and 12-16 bytes. The previous code
 * took the tag as `buf.subarray(12, 28)` with no length check on `buf`, and
 * `subarray` clamps silently: a truncated blob yielded a *short* tag, which
 * `setAuthTag` then accepted. A shorter tag is a weaker forgery bound, so an
 * attacker who could truncate stored ciphertext could weaken the very check
 * that is supposed to detect them. Flagged by semgrep as `gcm-no-tag-length`.
 */
const TAG_LEN = 16;

/** Raw key material, or null when CHAMBER_TOKEN_KEY is unset or blank. */
function rawKey(): string | null {
  const raw = process.env.CHAMBER_TOKEN_KEY;
  if (!raw || !raw.trim()) return null;
  return raw;
}

/** True when the value is 32 bytes of key material rather than a passphrase. */
function directKey(raw: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  // Buffer.from(_, "base64") never throws -- it drops non-base64 characters --
  // so the length check is what decides, not a try/catch.
  const b = Buffer.from(raw, "base64");
  return b.length === 32 ? b : null;
}

/** v1 derivation, kept verbatim so blobs sealed by it still open. */
function deriveKeyV1(): Buffer | null {
  const raw = rawKey();
  if (!raw) return null;
  return directKey(raw) ?? createHash("sha256").update(raw).digest();
}

/**
 * v2 derivation: a passphrase goes through scrypt with a per-blob salt.
 *
 * A single unsalted SHA-256 over a passphrase is one hash per guess and shares
 * a rainbow table with every other user of the same passphrase. scrypt makes
 * each guess cost memory as well as time, and the salt makes precomputation
 * useless. N=2^15 keeps a single derivation near a few hundred milliseconds,
 * which is unnoticeable for a token read and expensive across a dictionary.
 *
 * Key material supplied directly is used directly: it is already 32 uniformly
 * random bytes, and stretching it would only cost time.
 */
function deriveKeyV2(salt: Buffer): Buffer | null {
  const raw = rawKey();
  if (!raw) return null;
  const direct = directKey(raw);
  if (direct) return direct;
  return scryptSync(raw, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
}

export function hasTokenKey(): boolean {
  return rawKey() !== null;
}

/**
 * Would `sealSecret` succeed right now?
 *
 * Exists so a caller can check *before* doing something it cannot undo.
 * `sealSecret` throws when no key is configured, and its only caller —
 * `persistToken` in src/mcp_oauth.ts — runs after the OAuth token endpoint has
 * already rotated and invalidated the previous refresh token. A throw at that
 * point destroyed the connection: new tokens issued, old one dead, nothing
 * written, and no retry that could work.
 *
 * Distinct from `hasTokenKey`, which answers whether a key exists. This
 * answers whether a write will go through, which is also true when the
 * operator has explicitly opted into plaintext.
 */
export function canSealSecrets(): boolean {
  return rawKey() !== null || process.env.CHAMBER_ALLOW_PLAINTEXT_SECRETS === "1";
}

/**
 * Encrypt for DB storage.
 *
 * Refuses rather than silently storing plaintext. The old guard demanded
 * *both* NODE_ENV=production and CHAMBER_REQUIRE_TOKEN_KEY=1 before it would
 * throw; deploy/Dockerfile set only the first and no shipped artifact set the
 * second, so both supported deployments stored OAuth access and refresh tokens
 * in the clear, prefixed `plain:` for easy grepping. Defaulting to the unsafe
 * branch and requiring two opt-ins to reach the safe one is backwards: the
 * escape hatch is now the thing that needs a flag.
 */
export function sealSecret(plaintext: string): string {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKeyV2(salt);
  if (!key) {
    if (process.env.CHAMBER_ALLOW_PLAINTEXT_SECRETS === "1") {
      return PREFIX_PLAIN + plaintext;
    }
    throw new Error(
      "CHAMBER_TOKEN_KEY is not set, so this secret would be stored in " +
        "plaintext. Set CHAMBER_TOKEN_KEY (see `chamber help`), or set " +
        "CHAMBER_ALLOW_PLAINTEXT_SECRETS=1 to accept that for local use.",
    );
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX_V2 + Buffer.concat([salt, iv, tag, ct]).toString("base64url");
}

/**
 * Decrypt a blob produced by any version of `sealSecret`.
 *
 * Every length is checked before it is used. `Buffer.subarray` clamps instead
 * of throwing, so without these checks a truncated row produced a short IV and
 * a short tag and failed somewhere far less legible -- or, for the tag, did not
 * fail at all.
 */
export function openSecret(stored: string): string {
  if (stored.startsWith(PREFIX_PLAIN)) {
    return stored.slice(PREFIX_PLAIN.length);
  }

  const v2 = stored.startsWith(PREFIX_V2);
  const v1 = stored.startsWith(PREFIX_V1);
  if (!v1 && !v2) {
    // Legacy plaintext row, written before this module existed.
    return stored;
  }

  const prefix = v2 ? PREFIX_V2 : PREFIX_V1;
  const buf = Buffer.from(stored.slice(prefix.length), "base64url");
  const saltLen = v2 ? SALT_LEN : 0;
  const min = saltLen + IV_LEN + TAG_LEN;
  if (buf.length < min) {
    throw new Error(
      `sealed secret is truncated: ${buf.length} bytes, need at least ${min}`,
    );
  }

  const salt = v2 ? buf.subarray(0, SALT_LEN) : Buffer.alloc(0);
  const iv = buf.subarray(saltLen, saltLen + IV_LEN);
  const tag = buf.subarray(saltLen + IV_LEN, saltLen + IV_LEN + TAG_LEN);
  const ct = buf.subarray(saltLen + IV_LEN + TAG_LEN);
  if (tag.length !== TAG_LEN) {
    throw new Error(`sealed secret has a ${tag.length}-byte tag, need ${TAG_LEN}`);
  }

  const key = v2 ? deriveKeyV2(salt) : deriveKeyV1();
  if (!key) {
    throw new Error("CHAMBER_TOKEN_KEY required to decrypt sealed token");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_LEN,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** True when `stored` is sealed under the current format. */
export function isCurrentFormat(stored: string): boolean {
  return stored.startsWith(PREFIX_V2);
}

export function generateTokenKey(): string {
  return randomBytes(32).toString("base64");
}

/** Constant-time compare for callers holding two secrets of their own. */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
