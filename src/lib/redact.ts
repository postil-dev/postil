const SECRET_NAME_RE =
  /(KEY|SECRET|TOKEN|PASS|PWD|CRED|COOKIE|AUTH|SESSION|DATABASE_URL|PRIVATE_KEY)/i;

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted github token]"],
  [/\bgh[opsru]_[A-Za-z0-9_]{20,}\b/g, "[redacted github token]"],
  [/\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g, "[redacted api key]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted api key]"],
  [/\bph[cp]_[A-Za-z0-9_-]{20,}\b/g, "[redacted posthog token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted jwt]"],
  [/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted database url]"],
];

export function redactSecrets(
  input: unknown,
  extraValues: Array<string | undefined | null> = [],
): string {
  let output = input instanceof Error ? input.message : String(input);
  for (const value of secretValues(extraValues)) {
    output = output.split(value).join("[redacted]");
  }
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function redactAndTruncate(
  input: unknown,
  limit: number,
  extraValues: Array<string | undefined | null> = [],
): string {
  return redactSecrets(input, extraValues).slice(0, limit);
}

function secretValues(extraValues: Array<string | undefined | null>): string[] {
  const values = new Set<string>();
  for (const value of extraValues) addValue(values, value);
  for (const [name, value] of Object.entries(process.env)) {
    if (SECRET_NAME_RE.test(name)) addValue(values, value);
  }
  return Array.from(values).sort((a, b) => b.length - a.length);
}

function addValue(values: Set<string>, value: string | undefined | null): void {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length < 8) return;
  values.add(trimmed);
}
