import { describe, expect, it } from "vitest";
import { adminViewerFromSession, configuredAdminEmails } from "./admin-auth";

describe("admin auth", () => {
  it("normalizes configured admin emails", () => {
    expect(Array.from(configuredAdminEmails(" FIRST@example.com,second@example.com ,, "))).toEqual([
      "first@example.com",
      "second@example.com",
    ]);
  });

  it("accepts a session only when the email is configured", () => {
    const session = {
      user: {
        email: "Owner@Example.com ",
        name: "Owner",
      },
    };

    expect(adminViewerFromSession(session, configuredAdminEmails("owner@example.com"))).toEqual({
      email: "owner@example.com",
      name: "Owner",
    });
    expect(adminViewerFromSession(session, configuredAdminEmails("member@example.com"))).toBeNull();
  });

  it("rejects sessions without an email", () => {
    expect(
      adminViewerFromSession({ user: { name: "No Email" } }, configuredAdminEmails("a@b.com")),
    ).toBeNull();
  });
});
