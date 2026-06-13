/**
 * Classify a worker job failure as permanent (deterministic, non-retryable)
 * or transient (worth retrying with backoff).
 *
 * Motivation: a review/respond job that throws because the spawned CLI hit a
 * deterministic environment defect — a missing system CA bundle, a missing or
 * non-executable binary, a build/loader error, a malformed payload, an
 * unsupported forge — gains nothing from the queue's three-attempt retry. The
 * second and third attempts fail identically, burn the budget, and leave a
 * permanently-failed review with no useful output. The original incident was
 * the spawned CLI exiting with "No CA certificates were loaded from the
 * system" on real PRs; the queue retried it three times as if transient.
 *
 * Design rule: be conservative. A wrong "permanent" verdict suppresses the
 * retries a genuinely transient failure needs, which is strictly worse than an
 * extra retry on a deterministic one. So this returns true ONLY for signatures
 * that cannot plausibly succeed on a retry of the same job against the same
 * image, and it explicitly defers to "transient" for any provider 5xx/429,
 * timeout, deadline, or network/socket error — even when such a phrase appears
 * alongside a permanent-looking one. When in doubt, transient (retry).
 */

/**
 * Phrases that mark a failure as genuinely transient. These take precedence:
 * if any appears in the message, the failure is retryable regardless of any
 * permanent-looking phrase also present. This guards against a permanent
 * pattern accidentally matching a substring of an otherwise transient error
 * (e.g. a 503 body that happens to mention a certificate).
 */
const TRANSIENT_SIGNATURES: RegExp[] = [
  // Our own deadline/timeout wrappers (review.ts / respond.ts) and generic timeouts.
  /\bdeadline\b/i,
  /\btimed?\s*out\b/i,
  /\btimeout\b/i,
  // Provider throttling / availability.
  /\brate[\s-]?limit/i,
  /\b429\b/,
  /\b5\d{2}\b/, // any 5xx status (500, 502, 503, 504, ...)
  /\bservice unavailable\b/i,
  /\bbad gateway\b/i,
  /\bgateway timeout\b/i,
  /\btoo many requests\b/i,
  /\boverloaded\b/i,
  // Network / socket transients.
  /\beconnreset\b/i,
  /\beconnrefused\b/i,
  /\betimedout\b/i,
  /\beconnaborted\b/i,
  /\bepipe\b/i,
  /\benetunreach\b/i,
  /\behostunreach\b/i,
  /\beai_again\b/i,
  /\bsocket hang up\b/i,
  /\bconnection (?:reset|refused|closed|timed out)\b/i,
  /\bnetwork (?:error|timeout|unreachable)\b/i,
  /\btemporarily unavailable\b/i,
];

/**
 * Phrases that mark a failure as permanent: a deterministic defect of the
 * environment, image, payload, or request shape that a retry cannot fix.
 * Kept deliberately narrow.
 */
const PERMANENT_SIGNATURES: RegExp[] = [
  // CA / TLS trust store broken in the image (the original incident). A
  // missing system CA bundle fails every outbound TLS call deterministically.
  /no ca certificates were loaded/i,
  /\bca certificates?\b/i,
  /\bca[\s-]?bundle\b/i,
  /unable to get local issuer certificate/i,
  /self[\s-]?signed certificate/i,
  /\bcertificate\b/i, // cert verify / unknown CA / expired-in-image trust failures
  /\bunknown_?ca\b/i,
  /\bself_?signed_?cert\b/i,
  // Missing / non-executable CLI binary.
  /cli not found/i,
  /failed to spawn postil cli/i,
  /\benoent\b/i,
  /\beacces\b/i,
  /not executable/i,
  /not found or not executable/i,
  // Build / module-loader defects baked into the image.
  /\bbuilder error\b/i,
  /loader error/i,
  /module not found/i,
  /cannot find module/i,
  /\bsegmentation fault\b/i,
  // Malformed job payload (will be malformed on every attempt).
  /payload malformed/i,
  /malformed payload/i,
  // Unsupported forge (deterministic routing/config error).
  /unsupported forge/i,
  /unknown forge/i,
  /unknown job kind/i,
];

/**
 * Returns true ONLY for clearly deterministic, non-retryable failures.
 *
 * Transient signatures win ties: if a transient phrase is present, the result
 * is false even when a permanent-looking phrase also appears. This keeps the
 * classifier conservative — normal retries still happen for provider 5xx/429,
 * timeouts, deadlines, and network/socket errors.
 */
export function isPermanentFailure(message: string): boolean {
  if (!message) return false;
  // Transient takes precedence: never suppress retries for a transient class,
  // even if a permanent-looking token also appears in the same message.
  if (TRANSIENT_SIGNATURES.some((re) => re.test(message))) return false;
  return PERMANENT_SIGNATURES.some((re) => re.test(message));
}
