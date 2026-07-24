import { optionalEnv, requireEnv } from "@/lib/env";
import { redactSecrets } from "@/lib/redact";
import {
  sendTransactionalEmail,
  type TransactionalEmailContent,
} from "@/lib/transactional-email";

export interface OperatorNotification {
  recipient: string;
  subject: string;
  content: TransactionalEmailContent;
  idempotencyKey: string;
  incident?: OperatorNotificationIncident;
}

/**
 * Correlates a notification with a monitoring incident so an external
 * alerting service can deduplicate repeats and auto-close the alert when the
 * incident resolves.
 */
export interface OperatorNotificationIncident {
  key: string;
  state: "open" | "resolved";
  critical: boolean;
}

export interface OperatorNotificationResult {
  messageId: string | null;
}

export interface OperatorNotificationTransport {
  send(notification: OperatorNotification): Promise<OperatorNotificationResult>;
}

/**
 * Operator-facing alerts share this transport boundary. Monitoring, billing,
 * and signup code never select a delivery provider or depend on provider
 * response formats directly.
 */
export async function sendOperatorNotification(
  notification: OperatorNotification,
  transport: OperatorNotificationTransport = configuredOperatorNotificationTransport(),
): Promise<OperatorNotificationResult> {
  return transport.send(notification);
}

/** Configured production adapter for operator lifecycle and billing email. */
export function configuredOperatorNotificationTransport(): OperatorNotificationTransport {
  return {
    send(notification) {
      return sendTransactionalEmail({
        ...notification,
        apiKey: requireEnv("BREVO_API_KEY"),
      });
    },
  };
}

const ILERT_EVENTS_URL = "https://api.ilert.com/api/events";
const ILERT_EVENT_TIMEOUT_MS = 10_000;
const ILERT_DETAIL_LIMIT = 4_000;

/**
 * Monitoring alerts are delivered to the external alerting service, never by
 * the platform's own email path: the platform detects, the external system
 * pages. Without a configured integration key the incident is logged for the
 * log pipeline and treated as delivered; paging then relies on the external
 * uptime checks and the GitHub production monitor until the key is set.
 */
export function configuredMonitoringAlertTransport(): OperatorNotificationTransport {
  const integrationKey = optionalEnv("ILERT_INTEGRATION_KEY")?.trim();
  if (!integrationKey) {
    return {
      send(notification) {
        console.error(
          `[monitoring-alert] undeliverable (ILERT_INTEGRATION_KEY unset) ` +
            `state=${notification.incident?.state ?? "open"} ` +
            `key=${notification.incident?.key ?? notification.idempotencyKey} ` +
            `summary=${notification.subject}`,
        );
        return Promise.resolve({ messageId: null });
      },
    };
  }
  return ilertEventTransport(integrationKey);
}

export function ilertEventTransport(
  integrationKey: string,
  fetchImpl: typeof fetch = fetch,
): OperatorNotificationTransport {
  return {
    async send(notification) {
      const incident = notification.incident;
      const resolved = incident?.state === "resolved";
      const response = await fetchImpl(ILERT_EVENTS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(ILERT_EVENT_TIMEOUT_MS),
        body: JSON.stringify({
          integrationKey,
          eventType: resolved ? "RESOLVE" : "ALERT",
          summary: notification.subject,
          details: monitoringAlertDetails(notification.content),
          alertKey: incident?.key ?? notification.idempotencyKey,
          ...(resolved
            ? {}
            : { priority: incident?.critical === false ? "LOW" : "HIGH" }),
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `ilert event delivery failed with HTTP ${response.status}: ${redactSecrets(body).slice(0, 500)}`,
        );
      }
      return { messageId: null };
    },
  };
}

function monitoringAlertDetails(content: TransactionalEmailContent): string {
  const lines = [content.summary];
  for (const detail of content.details ?? []) {
    lines.push(`${detail.label}: ${detail.value}`);
  }
  if (content.action) {
    lines.push(`${content.action.label}: ${content.action.url}`);
  }
  return lines.join("\n").slice(0, ILERT_DETAIL_LIMIT);
}
