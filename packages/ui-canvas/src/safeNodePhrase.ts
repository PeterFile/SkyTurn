const MAX_COMPACT_PHRASE_LENGTH = 80;
const UNSAFE_PHRASE_PATTERNS = [
  /workflowintent/i,
  /toolcalls?/i,
  /\bstd(err|out)\b/i,
  /\btoken\s*=/i,
  /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=/i,
  /\bbearer\s+[A-Za-z0-9._-]+/i,
  /\bauthorization\b/i,
  /\bcookie\b/i,
  /private key/i,
  /\.env\b/i,
  /[{}]/,
];

export function safeCompactPhrase(value: string, unsafeFallback?: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  if (UNSAFE_PHRASE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return unsafeFallback ?? null;
  }
  if (normalized.length <= MAX_COMPACT_PHRASE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_COMPACT_PHRASE_LENGTH - 3).trimEnd()}...`;
}
