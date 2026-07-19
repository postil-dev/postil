import { sendTransactionalEmail } from "@/lib/email-verification";
import { requireEnv } from "@/lib/env";

export interface OperatorNotification {
  recipient: string;
  subject: string;
  text: string[];
  idempotencyKey: string;
}

export interface OperatorNotificationResult {
  messageId: string | null;
}

export interface OperatorNotificationTransport {
  send(notification: OperatorNotification): Promise<OperatorNotificationResult>;
}

/**
 * Operator-facing alerts share this transport boundary. Monitoring, billing,
 * and signup code never select a mail provider or depend on provider response
 * formats directly.
 */
export async function sendOperatorNotification(
  notification: OperatorNotification,
  transport: OperatorNotificationTransport = configuredOperatorNotificationTransport(),
): Promise<OperatorNotificationResult> {
  return transport.send(notification);
}

/** Configured production adapter for the shared operator-notification boundary. */
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
