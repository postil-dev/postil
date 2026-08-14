import { beforeEach, describe, expect, mock, test } from "bun:test";

let verificationCalls = 0;
let approved = 0;
let denied = 0;

class RedirectSignal extends Error {}

mock.module("@/lib/session", () => ({
  requireVerifiedPageSessionUser: async () => {
    verificationCalls += 1;
    return { id: 7, githubId: 123, login: "administrator" };
  },
}));

mock.module("@/lib/cli-auth", () => ({
  approveDeviceAuthorization: async () => {
    approved += 1;
    return true;
  },
  denyDeviceAuthorization: async () => {
    denied += 1;
    return true;
  },
  findDeviceAuthorizationByUserCode: async () => ({
    id: "22222222-3333-4444-8555-666666666666",
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000),
  }),
  normalizeUserCodeInput: (value: string) => value.trim().toUpperCase(),
}));

const membershipRows = [{ orgId: 17 }];
const query = {
  select() {
    return query;
  },
  from() {
    return query;
  },
  innerJoin() {
    return query;
  },
  where() {
    return query;
  },
  limit() {
    return Promise.resolve(membershipRows);
  },
};

mock.module("@/lib/db", () => ({
  getDb: () => query,
  schema: {
    orgMembers: { orgId: "org_members.org_id", userId: "org_members.user_id", role: "org_members.role" },
    organizations: { id: "organizations.id", slug: "organizations.slug" },
  },
}));

mock.module("next/navigation", () => ({
  redirect: (destination: string) => {
    throw new RedirectSignal(destination);
  },
}));

const { approveDeviceAuthorizationAction, denyDeviceAuthorizationAction } =
  await import("@/app/cli/authorize/actions");

beforeEach(() => {
  verificationCalls = 0;
  approved = 0;
  denied = 0;
});

describe("CLI device authorization session checks", () => {
  test("freshly verifies the approving administrator", async () => {
    const form = new FormData();
    form.set("code", "ABCD-1234");
    form.set("orgSlug", "example-org");

    await expect(approveDeviceAuthorizationAction(form)).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(verificationCalls).toBe(1);
    expect(approved).toBe(1);
  });

  test("freshly verifies the user before denying a device request", async () => {
    const form = new FormData();
    form.set("code", "ABCD-1234");

    await expect(denyDeviceAuthorizationAction(form)).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(verificationCalls).toBe(1);
    expect(denied).toBe(1);
  });
});
