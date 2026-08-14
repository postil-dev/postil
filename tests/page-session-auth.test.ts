import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  MembershipVerificationUnavailableError,
  PROTECTED_RETURN_TO_HEADER,
} from "@/lib/auth-navigation";

const RUN_TARGET =
  "/orgs/example-org/runs/11111111-2222-4333-8444-555555555555?tab=findings&severity=error";
const redirectCalls: string[] = [];
let protectedReturnTarget: string | null;

class RedirectSignal extends Error {}

mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({
    get: (name: string) =>
      name === PROTECTED_RETURN_TO_HEADER ? protectedReturnTarget : null,
  }),
}));

mock.module("next/navigation", () => ({
  redirect: (destination: string) => {
    redirectCalls.push(destination);
    throw new RedirectSignal(destination);
  },
}));

const { handlePageSessionFailure } = await import("@/lib/session");

beforeEach(() => {
  protectedReturnTarget = RUN_TARGET;
  redirectCalls.length = 0;
});

describe("page session failure control flow", () => {
  test("keeps a valid session on the protected URL during a transient outage", async () => {
    await expect(
      handlePageSessionFailure("verification_unavailable"),
    ).rejects.toBeInstanceOf(MembershipVerificationUnavailableError);
    expect(redirectCalls).toEqual([]);
  });

  test("preserves the exact protected path and query after sign-out", async () => {
    await expect(handlePageSessionFailure("unauthenticated")).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(redirectCalls).toEqual([
      `/login?next=${encodeURIComponent(RUN_TARGET)}`,
    ]);
  });

  test("ignores a forged return target when the protected header is unavailable", async () => {
    protectedReturnTarget = "https://evil.example/account";

    await expect(handlePageSessionFailure("unauthenticated")).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(redirectCalls).toEqual(["/login"]);
  });
});
