import { describe, expect, test } from "bun:test";

import { handleReviewPollResponse } from "@/app/orgs/[slug]/reviews-table";

describe("review table polling", () => {
  test.each([401, 404])(
    "reloads without rescheduling after terminal %i responses",
    async (status) => {
      let reloads = 0;
      const scheduledDelays: number[] = [];

      await handleReviewPollResponse(new Response(null, { status }), {
        replaceReviews: () => {
          throw new Error("terminal responses must not replace review rows");
        },
        reload: () => {
          reloads += 1;
        },
        schedule: (delayMs) => {
          scheduledDelays.push(delayMs);
        },
        stopped: () => false,
      });

      expect(reloads).toBe(1);
      expect(scheduledDelays).toEqual([]);
    },
  );
});
