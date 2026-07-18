import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  sendProductionMonitorAlert,
  type ProductionMonitorAlertEnvironment,
} from "@/../scripts/send-production-monitor-alert";

const baseEnvironment: ProductionMonitorAlertEnvironment = {
  BREVO_API_KEY: "brevo-test-key",
  GITHUB_REPOSITORY: "postil-dev/postil",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "29654572437",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_SHA: "c5bb3ebbff986e2c93184daa38551ec26d4b06ee",
  POSTIL_MONITOR_ALERT_KIND: "failure",
  POSTIL_OPERATOR_ALERT_EMAIL: "hello@postil.dev",
};

describe("production monitor email", () => {
  test("runs only for monitor failure or an explicit test dispatch", () => {
    const workflow = readFileSync(".github/workflows/production-monitor.yml", "utf8");
    expect(workflow).toContain(
      "needs.smoke.result == 'failure' || inputs.test_email == true",
    );
    expect(workflow).toContain("vars.POSTIL_OPERATOR_ALERT_EMAIL");
    expect(workflow).toContain("secret-path: /postil");
  });

  test("sends a bounded idempotent failure alert without production output", async () => {
    let request: RequestInit | undefined;
    await sendProductionMonitorAlert(baseEnvironment, async (_input, init) => {
      request = init;
      return Response.json({ messageId: "monitor-message-1" });
    });

    const body = JSON.parse(String(request?.body)) as {
      subject: string;
      textContent: string;
      headers: Record<string, string>;
    };
    expect(body.subject).toBe("Postil production monitor failed");
    expect(body.textContent).toContain("Commit: c5bb3ebbff98");
    expect(body.textContent).toContain(
      "Run: https://github.com/postil-dev/postil/actions/runs/29654572437",
    );
    expect(body.textContent).not.toMatch(/metrics|repository content|secret|token/i);
    expect(body.headers).toEqual({
      "Idempotency-Key": "production-monitor-failure-29654572437-1",
    });
  });

  test("supports an explicit test email and rejects malformed workflow context", async () => {
    let subject = "";
    await sendProductionMonitorAlert(
      { ...baseEnvironment, POSTIL_MONITOR_ALERT_KIND: "test" },
      async (_input, init) => {
        subject = (JSON.parse(String(init?.body)) as { subject: string }).subject;
        return Response.json({ messageId: "monitor-message-2" });
      },
    );
    expect(subject).toBe("Postil production alert test");

    await expect(
      sendProductionMonitorAlert(
        { ...baseEnvironment, GITHUB_RUN_ID: "../../credentials" },
        async () => Response.json({ messageId: "should-not-send" }),
      ),
    ).rejects.toThrow("GITHUB_RUN_ID is invalid");
  });
});
