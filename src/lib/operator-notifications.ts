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

export interface NotificationDelivery {
  transport: "ilert" | "email" | "unknown";
  fallbackUsed: boolean;
  primaryOutcome: "accepted" | "http_rejected" | "timeout" | "network_error" | "unknown";
  primaryHttpStatus: number | null;
}

class NotificationTransportError extends Error {
  constructor(message: string, readonly outcome: NotificationDelivery["primaryOutcome"],
    readonly httpStatus: number | null = null) {
    super(message);
  }
}

export interface OperatorNotificationResult {
  messageId: string | null;
  delivery?: NotificationDelivery;
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
 * Monitoring alerts are delivered to the external alerting service: the
 * platform detects, the external system pages. When that service rejects an
 * event, the operator email path carries the same notification so a broken
 * or lapsed alerting account cannot silence production paging; the outbox
 * records bounded transport provenance on successful delivery. Missing primary
 * configuration fails closed so the durable outbox retains the incident and retries after
 * configuration is restored.
 */
export function configuredMonitoringAlertTransport(): OperatorNotificationTransport {
  const integrationKey = optionalEnv("ILERT_INTEGRATION_KEY")?.trim();
  if (!integrationKey) {
    return {
      send() {
        return Promise.reject(
          new Error(
            "ILERT_INTEGRATION_KEY is required for monitoring alert delivery",
          ),
        );
      },
    };
  }
  const primary = ilertEventTransport(integrationKey);
  if (!optionalEnv("BREVO_API_KEY")?.trim()) return primary;
  const email = configuredOperatorNotificationTransport();
  return withFallbackTransport(primary, {
    async send(notification) {
      const result = await email.send(notification);
      return { ...result, delivery: {
        transport: "email", fallbackUsed: false,
        primaryOutcome: "accepted", primaryHttpStatus: null,
      } };
    },
  });
}

/**
 * Sends through the primary transport and, when it throws, through the
 * fallback. A fallback success counts as delivery so the outbox does not
 * re-page; both failures surface together so neither is masked.
 */
export function withFallbackTransport(
  primary: OperatorNotificationTransport,
  fallback: OperatorNotificationTransport,
  onFallback: (primaryError: unknown) => void = (primaryError) => {
    console.error(
      `[notifications] primary alert delivery failed; using fallback: ${redactSecrets(primaryError)}`,
    );
  },
): OperatorNotificationTransport {
  return {
    async send(notification) {
      try {
        return await primary.send(notification);
      } catch (primaryError) {
        onFallback(primaryError);
        try {
          const result = await fallback.send(notification);
          return { ...result, delivery: {
            transport: result.delivery?.transport ?? "unknown",
            fallbackUsed: true,
            primaryOutcome: primaryError instanceof NotificationTransportError ? primaryError.outcome : "unknown",
            primaryHttpStatus: primaryError instanceof NotificationTransportError ? primaryError.httpStatus : null,
          } };
        } catch (fallbackError) {
          throw new Error(
            `primary alert delivery failed (${redactSecrets(primaryError)}); fallback delivery failed (${redactSecrets(fallbackError)})`,
          );
        }
      }
    },
  };
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
      }).catch((error: unknown) => {
        const outcome = error instanceof Error && error.name === "TimeoutError" ? "timeout"
          : error instanceof TypeError ? "network_error" : "unknown";
        throw new NotificationTransportError(String(error), outcome);
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new NotificationTransportError(
          `ilert event delivery failed with HTTP ${response.status}: ${redactSecrets(body).slice(0, 500)}`,
          "http_rejected", response.status,
        );
      }
      return { messageId: null, delivery: {
        transport: "ilert", fallbackUsed: false,
        primaryOutcome: "accepted", primaryHttpStatus: response.status,
      } };
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
