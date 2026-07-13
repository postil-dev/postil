import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseRespondUsageReceipt,
  readRespondUsageReceipt,
} from "@/lib/respond-usage-receipt";

const VALID = {
  version: 1,
  operation: "respond",
  promptTokens: 30,
  completionTokens: 5,
  usageAccountingComplete: true,
  models: [
    { model: "z-ai/glm-5.2", promptTokens: 10, completionTokens: 2 },
    { model: "moonshotai/kimi-k2.7-code", promptTokens: 20, completionTokens: 3 },
  ],
};

describe("respond usage receipt", () => {
  test("prices every model entry and verifies aggregate tokens", () => {
    const parsed = parseRespondUsageReceipt(JSON.stringify(VALID));
    expect(parsed).toMatchObject({
      promptTokens: 30,
      completionTokens: 5,
      modelUsed: "z-ai/glm-5.2, moonshotai/kimi-k2.7-code",
      usageAccountingComplete: true,
    });
    expect(typeof parsed.actualMicros).toBe("number");
    expect(parsed.actualMicros!).toBeGreaterThan(0);
  });

  test("treats a missing completeness signal as incomplete compatibility data", () => {
    const legacy = structuredClone(VALID) as Partial<typeof VALID>;
    delete legacy.usageAccountingComplete;
    expect(parseRespondUsageReceipt(JSON.stringify(legacy)).usageAccountingComplete).toBe(false);
  });

  test("fails closed on unknown fields, mismatched totals, and unknown pricing", () => {
    expect(() =>
      parseRespondUsageReceipt(JSON.stringify({ ...VALID, apiKey: "must-not-be-accepted" })),
    ).toThrow("unexpected fields");
    expect(() =>
      parseRespondUsageReceipt(JSON.stringify({ ...VALID, promptTokens: 31 })),
    ).toThrow("aggregate tokens");
    const unknown = structuredClone(VALID);
    unknown.models[0]!.model = "unknown/private-model";
    expect(parseRespondUsageReceipt(JSON.stringify(unknown)).actualMicros).toBeNull();
  });

  test("requires a private regular file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "postil-respond-receipt-"));
    const path = join(dir, "usage.json");
    try {
      await writeFile(path, JSON.stringify(VALID), { mode: 0o600 });
      expect(await readRespondUsageReceipt(path)).toMatchObject({ promptTokens: 30 });
      await chmod(path, 0o644);
      await expect(readRespondUsageReceipt(path)).rejects.toThrow("permissions");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
