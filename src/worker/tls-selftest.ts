import { optionalEnv } from "@/lib/env";
import { redactSecrets } from "@/lib/redact";

/**
 * Startup TLS self-test: one outbound HTTPS request to exercise the system CA
 * trust store before the worker starts claiming jobs.
 *
 * The original incident: an image shipped without a system CA bundle, so the
 * spawned CLI's every outbound TLS call failed with "No CA certificates were
 * loaded from the system" and every review failed permanently. The worker
 * itself booted clean because it made no TLS call before claiming jobs. This
 * probe surfaces that class of image regression at boot so a CA-broken deploy
 * fails fast instead of silently failing every review.
 *
 * Fail-policy is deliberately narrow: only a TLS/certificate verification
 * error is fatal (the caller exits non-zero). A plain network blip — DNS, a
 * refused connection, a timeout, a non-2xx HTTP status — must NOT block boot,
 * since the registry being briefly unreachable is not a reason to refuse to
 * start the worker; the queue's retries cover transient networks.
 */

/** Where the self-test points, resolved from env with a GitHub API fallback. */
export function tlsSelfTestUrl(): string {
  // The configured model API base must be reachable for any review to work;
  // fall back to the GitHub API, which every job also calls.
  const base = optionalEnv("POSTIL_API_BASE", "https://api.github.com") as string;
  try {
    return new URL(base).origin;
  } catch {
    return "https://api.github.com";
  }
}

/**
 * True only for TLS/certificate trust failures, not generic network errors.
 *
 * Node/undici surface these via an error `code` (or a nested `cause.code`)
 * such as UNABLE_TO_GET_ISSUER_CERT_LOCALLY, SELF_SIGNED_CERT_IN_CHAIN, or
 * CERT_HAS_EXPIRED, and/or a message mentioning the certificate. A bare
 * ECONNREFUSED / ETIMEDOUT / ENOTFOUND must read as transient (false).
 */
export function isTlsError(err: unknown): boolean {
  if (err == null) return false;
  const code = (err as { code?: string }).code ?? "";
  const cause = (err as { cause?: { code?: string } }).cause;
  const causeCode = cause?.code ?? "";
  for (const c of [code, causeCode]) {
    // OpenSSL/undici trust-store error codes. Anchored tokens avoid matching
    // unrelated codes (ECONNRESET etc. contain none of these as whole words).
    if (typeof c === "string" && /(?:CERT|^ERR_TLS|_SSL_|^CA_|_CA$|ISSUER)/i.test(c)) return true;
  }
  const message =
    (err instanceof Error ? err.message : String(err)) +
    " " +
    (cause instanceof Error ? cause.message : "");
  return /certificate|\bca certificates?\b|no ca certificates were loaded|\bssl\b|\btls\b/i.test(
    message,
  );
}

/**
 * Make one bounded HEAD request and classify the outcome. Throws only on a
 * TLS/certificate error (fatal); resolves on success or on a non-TLS network
 * blip (logged, non-fatal). `fetchImpl` is injectable for tests.
 */
export async function tlsSelfTest(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<void> {
  const url = tlsSelfTestUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(url, { method: "HEAD", signal: controller.signal });
    console.log(`tls self-test ok (${url})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isTlsError(err)) {
      throw new Error(
        `Postil worker cannot start: TLS/certificate verification failed reaching ${url}.\n` +
          `This usually means the image is missing its system CA bundle, so every ` +
          `outbound TLS call (model API, GitHub) would fail and every review/respond ` +
          `job would fail permanently.\n` +
          `Fix: install ca-certificates in the runtime image. Underlying error: ${message}`,
      );
    }
    // A non-TLS network problem (DNS, refused, timeout) is not a config defect
    // we should refuse to boot over.
    console.warn(
      `tls self-test inconclusive (non-TLS network error, continuing): ${redactSecrets(message)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
