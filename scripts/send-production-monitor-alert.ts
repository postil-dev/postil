import {
  normalizeVerificationEmail,
  sendTransactionalEmail,
} from "@/lib/email-verification";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProductionMonitorAlertEnvironment {
  BREVO_API_KEY?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_RUN_ATTEMPT?: string;
  GITHUB_RUN_ID?: string;
  GITHUB_SERVER_URL?: string;
  GITHUB_SHA?: string;
  POSTIL_MONITOR_ALERT_KIND?: string;
  POSTIL_OPERATOR_ALERT_EMAIL?: string;
}

/** Send a provider-idempotent operator email when production monitoring fails or is tested. */
export async function sendProductionMonitorAlert(
  environment: ProductionMonitorAlertEnvironment,
  fetchImpl?: Fetch,
): Promise<void> {
  const recipient = normalizeVerificationEmail(
    environment.POSTIL_OPERATOR_ALERT_EMAIL ?? "",
    "POSTIL_OPERATOR_ALERT_EMAIL must be a valid email address.",
  );
  if (!recipient) throw new Error("POSTIL_OPERATOR_ALERT_EMAIL is required");
  const apiKey = required(environment.BREVO_API_KEY, "BREVO_API_KEY");
  const repository = exact(
    environment.GITHUB_REPOSITORY,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "GITHUB_REPOSITORY",
  );
  const runId = exact(environment.GITHUB_RUN_ID, /^[1-9][0-9]{0,19}$/, "GITHUB_RUN_ID");
  const attempt = exact(
    environment.GITHUB_RUN_ATTEMPT,
    /^[1-9][0-9]{0,5}$/,
    "GITHUB_RUN_ATTEMPT",
  );
  const sha = exact(environment.GITHUB_SHA, /^[0-9a-f]{40}$/, "GITHUB_SHA");
  const server = new URL(required(environment.GITHUB_SERVER_URL, "GITHUB_SERVER_URL"));
  if (
    server.protocol !== "https:" ||
    server.username ||
    server.password ||
    server.pathname !== "/"
  ) {
    throw new Error("GITHUB_SERVER_URL must be an HTTPS origin");
  }
  const kind = environment.POSTIL_MONITOR_ALERT_KIND;
  if (kind !== "failure" && kind !== "test") {
    throw new Error("POSTIL_MONITOR_ALERT_KIND must be failure or test");
  }
  const runUrl = new URL(`/${repository}/actions/runs/${runId}`, server).toString();
  const failure = kind === "failure";

  await sendTransactionalEmail({
    recipient,
    subject: failure ? "Postil production monitor failed" : "Postil production alert test",
    text: failure
      ? [
          "Postil's production checks failed.",
          "",
          `Commit: ${sha.slice(0, 12)}`,
          `Run: ${runUrl}`,
        ]
      : [
          "Postil's production-monitor email path is working.",
          "",
          `Run: ${runUrl}`,
        ],
    idempotencyKey: `production-monitor-${kind}-${runId}-${attempt}`,
    apiKey,
    fetchImpl,
  });
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function exact(value: string | undefined, pattern: RegExp, name: string): string {
  const normalized = required(value, name);
  if (!pattern.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

if (import.meta.main) {
  await sendProductionMonitorAlert({
    BREVO_API_KEY: process.env.BREVO_API_KEY,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
    GITHUB_SHA: process.env.GITHUB_SHA,
    POSTIL_MONITOR_ALERT_KIND: process.env.POSTIL_MONITOR_ALERT_KIND,
    POSTIL_OPERATOR_ALERT_EMAIL: process.env.POSTIL_OPERATOR_ALERT_EMAIL,
  });
}
