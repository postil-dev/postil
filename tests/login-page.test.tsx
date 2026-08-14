import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let sessionUser: { id: number; login: string } | null;
const redirectCalls: string[] = [];

class RedirectSignal extends Error {}

mock.module("@/lib/session", () => ({
  getSessionUser: async () => sessionUser,
}));

mock.module("next/navigation", () => ({
  redirect: (destination: string) => {
    redirectCalls.push(destination);
    throw new RedirectSignal(destination);
  },
}));

const { default: LoginPage } = await import("@/app/login/page");

beforeEach(() => {
  sessionUser = null;
  redirectCalls.length = 0;
});

describe("login page session contract", () => {
  test("renders one anonymous sign-in action for a signed-out request", async () => {
    const page = await LoginPage({
      searchParams: Promise.resolve({ next: "/orgs/example-org/settings?tab=billing" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Sign in to Postil");
    expect(markup).toContain(
      'href="/api/auth/login?next=%2Forgs%2Fexample-org%2Fsettings%3Ftab%3Dbilling"',
    );
    expect(markup).not.toContain("Dashboard");
  });

  test("redirects an authenticated request to a safe protected return target", async () => {
    sessionUser = { id: 7, login: "octocat" };
    const returnTo =
      "/orgs/example-org/runs/11111111-2222-4333-8444-555555555555";

    await expect(
      LoginPage({ searchParams: Promise.resolve({ next: returnTo }) }),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirectCalls).toEqual([returnTo]);
  });

  test("ignores an unsafe return target for both page links and authenticated redirects", async () => {
    const page = await LoginPage({
      searchParams: Promise.resolve({ next: "https://evil.example/account" }),
    });
    expect(renderToStaticMarkup(page)).toContain('href="/api/auth/login"');

    sessionUser = { id: 7, login: "octocat" };
    await expect(
      LoginPage({ searchParams: Promise.resolve({ next: "//evil.example" }) }),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirectCalls).toEqual(["/reports"]);
  });
});
