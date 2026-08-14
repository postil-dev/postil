import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createFlightReactServerErrorHandler } from "next/dist/server/app-render/create-error-handler";

import {
  MEMBERSHIP_RETRY_FALLBACK_MS,
  MEMBERSHIP_RETRY_MAX_DELAY_MS,
  MEMBERSHIP_VERIFICATION_UNAVAILABLE_DIGEST,
  membershipRetryDelayFromDigest,
  MembershipVerificationUnavailableError,
} from "@/lib/auth-navigation";

const RUN_TARGET =
  "/orgs/example-org/runs/11111111-2222-4333-8444-555555555555?tab=findings&severity=error";
const redirectCalls: string[] = [];

mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => RUN_TARGET }),
}));

mock.module("next/navigation", () => ({
  redirect: (destination: string) => {
    redirectCalls.push(destination);
    throw new Error(`unexpected redirect to ${destination}`);
  },
  useRouter: () => ({ refresh: () => undefined }),
}));

const { default: ErrorPage, ErrorContent } = await import("@/app/error");
const { handlePageSessionFailure } = await import("@/lib/session");

describe("authenticated page error boundary", () => {
  test("renders the retry UI at the original URL after Next serializes the server error", async () => {
    const retryAvailableAt = new Date(Date.now() + 60_000);
    let serverError: unknown;
    try {
      await handlePageSessionFailure(
        "verification_unavailable",
        retryAvailableAt,
      );
    } catch (error) {
      serverError = error;
    }
    expect(serverError).toBeInstanceOf(MembershipVerificationUnavailableError);

    const serializeServerError = createFlightReactServerErrorHandler(
      false,
      () => undefined,
    );
    const digest = serializeServerError(serverError);
    if (!digest) throw new Error("expected a serialized membership error digest");
    const encodedDelay = Number(digest.slice(digest.lastIndexOf(":") + 1));
    expect(digest).toStartWith(`${MEMBERSHIP_VERIFICATION_UNAVAILABLE_DIGEST}:`);
    expect(encodedDelay).toBeGreaterThan(59_000);
    expect(encodedDelay).toBeLessThanOrEqual(60_000);
    expect(membershipRetryDelayFromDigest(digest)).toBe(encodedDelay);

    const serializedError = Object.assign(
      new Error("The server component failed."),
      { digest },
    );
    const markup = renderToStaticMarkup(
      <ErrorPage
        error={serializedError}
        reset={() => undefined}
      />,
    );

    expect(redirectCalls).toEqual([]);
    expect(RUN_TARGET).toBe(
      "/orgs/example-org/runs/11111111-2222-4333-8444-555555555555?tab=findings&severity=error",
    );
    expect(markup).toContain("Service unavailable");
    expect(markup).toContain("Organization access could not be verified.");
    expect(markup).toContain("GitHub membership verification is temporarily unavailable.");
    expect(markup).toContain(
      "Your current page is preserved while you wait to try again.",
    );
    expect(markup).toContain("Try again");
    expect(markup).toContain("Retry available in 1 minute.");
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('id="membership-retry-status"');
    expect(markup).toContain('id="membership-retry-announcement"');
    expect(markup).not.toContain("unexpected error");
  });

  test("exposes retry progress and blocks repeated submissions", () => {
    const markup = renderToStaticMarkup(
      <ErrorContent
        digest={MEMBERSHIP_VERIFICATION_UNAVAILABLE_DIGEST}
        headingRef={{ current: null }}
        membershipVerificationUnavailable
        onRetry={() => undefined}
        retryRemainingMs={1_000}
        retryPending
      />,
    );

    expect(markup).toContain("Trying again...");
    expect(markup).toContain("Checking organization access.");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup.match(/Checking organization access\./g)).toHaveLength(2);
  });

  test("keeps ordinary retry progress free of membership-specific language", () => {
    const markup = renderToStaticMarkup(
      <ErrorContent
        headingRef={{ current: null }}
        membershipVerificationUnavailable={false}
        onRetry={() => undefined}
        retryPending
      />,
    );

    expect(markup).toContain("Retrying this page.");
    expect(markup).not.toContain("Checking organization access.");
  });

  test("uses bounded fallback timing for absent or malformed retry metadata", () => {
    expect(
      membershipRetryDelayFromDigest(
        MEMBERSHIP_VERIFICATION_UNAVAILABLE_DIGEST,
      ),
    ).toBe(MEMBERSHIP_RETRY_FALLBACK_MS);
    expect(
      membershipRetryDelayFromDigest(
        `${MEMBERSHIP_VERIFICATION_UNAVAILABLE_DIGEST}:invalid`,
      ),
    ).toBe(MEMBERSHIP_RETRY_FALLBACK_MS);
    expect(
      membershipRetryDelayFromDigest(
        `${MEMBERSHIP_VERIFICATION_UNAVAILABLE_DIGEST}:${2 * MEMBERSHIP_RETRY_MAX_DELAY_MS}`,
      ),
    ).toBe(MEMBERSHIP_RETRY_MAX_DELAY_MS);
    expect(membershipRetryDelayFromDigest("unrelated-error")).toBeUndefined();
  });

  test("keeps a future server backoff when the client wall clock is ahead", () => {
    const serverNow = Date.parse("2026-08-10T12:00:00.000Z");
    const clientNow = serverNow + 60 * 60 * 1_000;
    const error = new MembershipVerificationUnavailableError(
      serverNow + 30_000,
      serverNow,
    );

    expect(serverNow + 30_000 - clientNow).toBeLessThan(0);
    expect(membershipRetryDelayFromDigest(error.digest)).toBe(30_000);
    expect(
      membershipRetryDelayFromDigest(
        `${MEMBERSHIP_VERIFICATION_UNAVAILABLE_DIGEST}:0`,
      ),
    ).toBe(MEMBERSHIP_RETRY_FALLBACK_MS);
  });
});
