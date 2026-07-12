import type { Envelope, Finding } from "@/lib/envelope";
import { qualifiesHumanEscalation } from "@/lib/envelope";
import { optionalEnv } from "@/lib/env";
import { githubPrUrl } from "@/lib/github-links";

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const BREVO_TIMEOUT_MS = 10_000;
const CARRIED_MARKER = "[carried from previous review]";
const MAX_SUBJECT_TITLE_CHARS = 120;
const MAX_FINDING_BODY_CHARS = 2_000;
const MAX_EMAIL_BODY_CHARS = 12_000;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface EscalationNotificationInput {
  envelope: Envelope;
  repoFullName: string;
  prNumber: number;
  runUrl: string;
  reviewPublicId: string;
  recipient: string;
  apiKey: string;
  githubWebBase?: string;
  fetchImpl?: Fetch;
}

export interface EscalationNotificationResult {
  sent: boolean;
  findingCount: number;
  recipientCount: number;
}

export function qualifyingHumanEscalations(envelope: Envelope): Finding[] {
  return envelope.findings.filter(
    (finding) =>
      qualifiesHumanEscalation(finding) && !finding.body.startsWith(CARRIED_MARKER),
  );
}

export function configuredGithubWebBase(): string {
  const serverUrl = optionalEnv("GITHUB_SERVER_URL");
  const apiUrl = optionalEnv("GITHUB_API_URL");
  const configured =
    serverUrl ??
    (apiUrl && apiUrl !== "https://api.github.com"
      ? apiUrl.replace(/\/api\/v3\/?$/, "")
      : "https://github.com");
  const url = new URL(configured);
  if (!url.host || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("GITHUB_SERVER_URL must be an absolute HTTP(S) URL");
  }
  return url.toString().replace(/\/$/, "");
}

export async function sendHumanEscalationNotification(
  input: EscalationNotificationInput,
): Promise<EscalationNotificationResult> {
  const findings = qualifyingHumanEscalations(input.envelope);
  const recipient = input.recipient.trim().toLowerCase();
  if (findings.length === 0 || !recipient) {
    return {
      sent: false,
      findingCount: findings.length,
      recipientCount: recipient ? 1 : 0,
    };
  }

  const highestSeverity = findings.some((finding) => finding.severity === "error")
    ? "error"
    : findings.some((finding) => finding.severity === "warn")
      ? "warn"
      : "info";
  const title =
    findings.length === 1
      ? sanitizeSingleLine(findings[0]!.title, MAX_SUBJECT_TITLE_CHARS)
      : `${findings.length} findings`;
  const prUrl = githubPrUrl(
    input.repoFullName,
    input.prNumber,
    input.githubWebBase ?? configuredGithubWebBase(),
  );
  const header = [
    `Postil requires human review for ${sanitizeSingleLine(input.repoFullName, 200)} pull request #${input.prNumber}.`,
    "",
    "The finding text below is model-generated. Verify it against the linked pull request before acting.",
  ].join("\n");
  const findingText = findings
    .flatMap((finding) => [
      `[${finding.severity}] ${sanitizeSingleLine(finding.title, MAX_SUBJECT_TITLE_CHARS)}`,
      sanitizeMultiline(finding.body, MAX_FINDING_BODY_CHARS),
      "",
    ])
    .join("\n");
  const footer = [
    `Pull request: ${prUrl}`,
    `Postil run: ${input.runUrl}`,
  ].join("\n");
  const modelTextBudget = Math.max(
    0,
    MAX_EMAIL_BODY_CHARS - header.length - footer.length - 4,
  );
  // Trusted verification links are never truncated. Only the untrusted,
  // model-generated middle section yields when the message reaches its cap.
  const textContent = `${header}\n\n${findingText.slice(0, modelTextBudget)}\n\n${footer}`;

  const response = await (input.fetchImpl ?? fetch)(BREVO_SEND_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": input.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: {
        name: optionalEnv("POSTIL_ESCALATION_FROM_NAME", "Postil") as string,
        email: optionalEnv(
          "POSTIL_ESCALATION_FROM_EMAIL",
          "reviews@mail.postil.dev",
        ) as string,
      },
      // One API request per configured organization recipient keeps addresses
      // isolated from one another in the delivered message headers.
      to: [{ email: recipient }],
      subject: sanitizeSingleLine(
        `[Postil] ${highestSeverity} human escalation: ${title}`,
        200,
      ),
      textContent,
      // Brevo documents this custom request-body header for retry dedupe. The
      // queue is deliberately at-least-once: if a worker dies after Brevo
      // accepts the email, a rare duplicate is safer than silently losing a
      // genuine escalation after the provider's idempotency window expires.
      headers: { "Idempotency-Key": input.reviewPublicId },
    }),
    signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    let code: unknown;
    try {
      code = (JSON.parse(responseBody) as { code?: unknown }).code;
    } catch {
      code = undefined;
    }
    if (code === "duplicate_parameter") {
      return { sent: true, findingCount: findings.length, recipientCount: 1 };
    }
    const detail = sanitizeSingleLine(responseBody.slice(0, 300), 300);
    throw new Error(`Brevo escalation email failed: ${response.status} ${detail}`);
  }

  return { sent: true, findingCount: findings.length, recipientCount: 1 };
}

function sanitizeSingleLine(value: string, maxChars: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function sanitizeMultiline(value: string, maxChars: number): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxChars);
}
