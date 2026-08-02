/**
 * Lightweight credential pattern scan before skill activation.
 * Heuristic only — fail closed on strong hits.
 */

export interface SecretScanHit {
  kind: string;
  index: number;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "aws_secret_like", re: /\baws[_-]?secret[_-]?access[_-]?key\b\s*[:=]\s*['"][^'"]{12,}/gi },
  { kind: "generic_api_key", re: /\b(api[_-]?key|apikey|secret[_-]?key)\b\s*[:=]\s*['"][^'"]{16,}/gi },
  { kind: "bearer_token", re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g },
  { kind: "private_key_block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { kind: "slack_token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { kind: "discord_bot_token", re: /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b/g },
  { kind: "github_pat", re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { kind: "openai_sk", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
];

export function scanForSecrets(text: string): SecretScanHit[] {
  const hits: SecretScanHit[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ kind, index: m.index });
      if (hits.length >= 20) return hits;
    }
  }
  return hits;
}

export function skillSecretScanRefuse(body: string): string | null {
  const hits = scanForSecrets(body);
  if (!hits.length) return null;
  const kinds = [...new Set(hits.map((h) => h.kind))].join(",");
  return `skill body matches credential patterns (${kinds}) — refuse activate; scrub and re-approve`;
}
