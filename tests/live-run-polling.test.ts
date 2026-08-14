import { describe, expect, test } from "bun:test";

import { handleLiveRunPollResponse } from "@/app/orgs/[slug]/runs/[publicId]/live-run";

describe("live run polling", () => {
  test.each([401, 404])(
    "clears protected state and reloads without rescheduling after terminal %i responses",
    async (status) => {
      const events: string[] = [];

      await handleLiveRunPollResponse(new Response(null, { status }), {
        clearRun: () => events.push("clear"),
        applyResponse: () => events.push("apply"),
        reload: () => events.push("reload"),
        schedule: () => events.push("schedule"),
        stopped: () => false,
      });

      expect(events).toEqual(["clear", "reload"]);
    },
  );

  test("preserves bounded retry behavior for transient responses", async () => {
    const events: string[] = [];
    const scheduledDelays: number[] = [];

    await handleLiveRunPollResponse(
      new Response(null, {
        status: 503,
        headers: { "retry-after": "30" },
      }),
      {
        clearRun: () => events.push("clear"),
        applyResponse: () => events.push("apply"),
        reload: () => events.push("reload"),
        schedule: (delayMs) => scheduledDelays.push(delayMs),
        stopped: () => false,
      },
    );

    expect(events).toEqual([]);
    expect(scheduledDelays).toEqual([30_000]);
  });
});
