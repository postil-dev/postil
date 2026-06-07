import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("health route", () => {
  it("reports the health status", async () => {
    await expect(GET().json()).resolves.toEqual({
      ok: true,
      service: "postil",
    });
  });
});
