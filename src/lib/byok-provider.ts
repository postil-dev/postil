export const API_FORMATS = ["openai-compatible", "anthropic"] as const;
export type ApiFormat = (typeof API_FORMATS)[number];

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED_HEADERS = new Set([
  "accept",
  "anthropic-version",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "forwarded",
  "host",
  "http-referer",
  "proxy-authorization",
  "transfer-encoding",
  "x-api-key",
  "x-title",
]);
const RESERVED_PREFIXES = ["sec-", "x-forwarded-"];

export function parseApiFormat(value: string): ApiFormat | null {
  return API_FORMATS.includes(value as ApiFormat) ? (value as ApiFormat) : null;
}

/** Validate the one optional gateway-auth header without allowing protocol collisions. */
export function validateAdditionalAuthHeader(name: string, apiFormat: ApiFormat): void {
  if (name.length > 128 || !HEADER_TOKEN.test(name)) {
    throw new Error("Additional authentication header must be a valid HTTP header name.");
  }
  const normalized = name.toLowerCase();
  if (
    (normalized === "authorization" && apiFormat !== "anthropic") ||
    RESERVED_HEADERS.has(normalized) ||
    RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    throw new Error(
      "Additional authentication header conflicts with a provider or transport header.",
    );
  }
}

export function validateAdditionalAuthValue(value: string): void {
  if (value.length > 8_192 || /[\0\r\n]/.test(value)) {
    throw new Error(
      "Additional authentication value must be one line and at most 8192 characters.",
    );
  }
}
