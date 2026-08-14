import { beforeEach, describe, expect, mock, test } from "bun:test";

let verifiedUser = {
  id: 7,
  githubId: 123,
  login: "operator",
  name: null,
  email: null,
  avatarUrl: null,
};
let verificationCalls = 0;
const database = { marker: "database" };

class NotFoundSignal extends Error {}

mock.module("@/lib/session", () => ({
  requireVerifiedPageSessionUser: async () => {
    verificationCalls += 1;
    return verifiedUser;
  },
}));

mock.module("@/lib/db", () => ({ getDb: () => database }));

mock.module("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal();
  },
}));

const { requireOperatorAccess } = await import("@/lib/operator-access");

beforeEach(() => {
  process.env.POSTIL_OPERATOR_GITHUB_IDS = "123";
  verifiedUser = {
    id: 7,
    githubId: 123,
    login: "operator",
    name: null,
    email: null,
    avatarUrl: null,
  };
  verificationCalls = 0;
});

describe("operator access", () => {
  test("uses fresh membership verification before granting operator access", async () => {
    const access = await requireOperatorAccess();
    expect(access.user).toEqual(verifiedUser);
    expect(verificationCalls).toBe(1);
  });

  test("keeps a verified non-operator outside the cross-tenant surface", async () => {
    verifiedUser = {
      id: 8,
      githubId: 456,
      login: "member",
      name: null,
      email: null,
      avatarUrl: null,
    };
    await expect(requireOperatorAccess()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(verificationCalls).toBe(1);
  });
});
