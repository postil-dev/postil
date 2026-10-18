import type {
  FindingFeedbackDigestAlertPayload,
  OperatorAlertJobPayload,
} from "@/lib/operator-alerts";
import type { TransactionalEmailContent } from "@/lib/transactional-email";

const FINDING_FEEDBACK_DETAIL_LABEL_MAX_LENGTH = 120;

export function findingFeedbackAggregateLabel(
  aggregate: FindingFeedbackDigestAlertPayload["aggregates"][number],
): string {
  const label = [
    aggregate.source,
    aggregate.suggestedReasonTag ?? aggregate.reactionContent ?? "unclassified",
    aggregate.model ?? "unknown-model",
    aggregate.kind ?? "unknown-kind",
    aggregate.severity ?? "unknown-severity",
  ].join(" · ");
  return label.length <= FINDING_FEEDBACK_DETAIL_LABEL_MAX_LENGTH
    ? label
    : `${label.slice(0, FINDING_FEEDBACK_DETAIL_LABEL_MAX_LENGTH - 1)}…`;
}

export function operatorAlertEmailContent(
  payload: OperatorAlertJobPayload,
  dashboardUrl: string | null,
): { subject: string; content: TransactionalEmailContent } {
  const organization = payload.accountLogin ?? undefined;
  const common = payload.githubOwnerId
    ? [{ label: "GitHub owner ID", value: String(payload.githubOwnerId) }]
    : [];
  const action = dashboardUrl
    ? { label: "Open organization", url: dashboardUrl }
    : undefined;
  const reason =
    "This address is configured to receive Postil operator alerts.";
  if (payload.event === "trial_started") {
    return {
      subject: `New Postil trial: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin} started a 30-day Postil trial.`,
        category: "Trial",
        title: "A trial has started",
        summary: "The 30-day access window is active for this GitHub owner.",
        organization,
        reason,
        details: [
          ...common,
          { label: "Account type", value: payload.accountType },
          {
            label: "Installation ID",
            value: String(payload.githubInstallationId),
          },
          { label: "Trial ends", value: formatUtcDate(payload.trialEndsAt) },
        ],
        action,
        note: "No action is required. Eligible pull requests are reviewed automatically.",
        intent: "success",
      },
    };
  }
  if (payload.event === "trial_expired") {
    return {
      subject: `Postil trial ended: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin}'s Postil trial has ended.`,
        category: "Trial",
        title: "The trial has ended",
        summary:
          "Private-repository reviews are paused because this organization has no active plan.",
        organization,
        reason,
        details: [
          ...common,
          { label: "Trial ended", value: formatUtcDate(payload.trialEndsAt) },
        ],
        action,
        note: "Review the organization before contacting its owner or changing access.",
        intent: "warning",
      },
    };
  }
  if (payload.event === "subscription_started") {
    return {
      subject: `Postil subscription active: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin} activated a Postil subscription.`,
        category: "Billing",
        title: "Subscription active",
        summary: "Self-service billing is active for this organization.",
        organization,
        reason,
        details: [
          ...common,
          {
            label: "Provider subscription",
            value: payload.providerSubscriptionId,
          },
          ...(payload.periodEndsAt
            ? [
                {
                  label: "Period ends",
                  value: formatUtcDate(payload.periodEndsAt),
                },
              ]
            : []),
        ],
        action,
        intent: "success",
      },
    };
  }
  if (payload.event === "subscription_past_due") {
    return {
      subject: `Postil payment past due: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin}'s Postil payment is past due.`,
        category: "Billing",
        title: "Payment needs attention",
        summary: "The provider reports this subscription as past due.",
        organization,
        reason,
        details: [
          ...common,
          {
            label: "Provider subscription",
            value: payload.providerSubscriptionId,
          },
        ],
        action,
        note: "Check the provider record before taking action.",
        intent: "critical",
      },
    };
  }
  if (payload.event === "subscription_canceled") {
    return {
      subject: `Postil subscription ended: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin}'s Postil subscription has ended.`,
        category: "Billing",
        title: "Subscription ended",
        summary: "The provider reports this subscription as canceled.",
        organization,
        reason,
        details: [
          ...common,
          {
            label: "Provider subscription",
            value: payload.providerSubscriptionId,
          },
        ],
        action,
        note: "Review access and the provider record for this organization.",
        intent: "warning",
      },
    };
  }
  if (payload.event === "subscription_paused") {
    return {
      subject: `Postil subscription paused: ${payload.accountLogin}`,
      content: {
        preheader: `${payload.accountLogin}'s Postil subscription is paused.`,
        category: "Billing",
        title: "Subscription paused",
        summary: "The provider reports this subscription as paused.",
        organization,
        reason,
        details: [
          ...common,
          {
            label: "Provider subscription",
            value: payload.providerSubscriptionId,
          },
        ],
        action,
        note: "Review access and the provider record for this organization.",
        intent: "warning",
      },
    };
  }
  if (payload.event === "billing_anomaly") {
    return {
      subject: payload.accountLogin
        ? `Postil billing needs attention: ${payload.accountLogin}`
        : "Postil billing needs attention",
      content: {
        preheader: "A Postil billing operation needs attention.",
        category: "Incident",
        title: "Billing needs attention",
        summary:
          "A self-service billing operation did not reach a known good state.",
        organization,
        reason,
        details: [
          ...common,
          { label: "Category", value: payload.category },
          { label: "Provider reference", value: payload.providerObjectId },
        ],
        action,
        note: "Inspect the provider event and the corresponding Postil billing state.",
        intent: "critical",
      },
    };
  }
  if (payload.event === "finding_feedback_digest") {
    return {
      subject: `Postil finding feedback digest: ${payload.periodStart.slice(0, 10)}`,
      content: {
        preheader: "Weekly aggregate of published finding feedback.",
        category: "Feedback",
        title: "Finding feedback digest",
        summary: "Published finding feedback grouped by structured review dimensions.",
        reason,
        details: payload.aggregates.map((aggregate) => ({
          label: findingFeedbackAggregateLabel(aggregate),
          value: String(aggregate.count),
        })),
        note: payload.aggregatesTruncated
          ? `Period ${formatUtcDate(payload.periodStart)} through ${formatUtcDate(payload.periodEnd)}. Additional aggregate groups are omitted from this digest.`
          : `Period ${formatUtcDate(payload.periodStart)} through ${formatUtcDate(payload.periodEnd)}.`,
        intent: "success",
      },
    };
  }
  if (payload.event !== "installation_removed") {
    throw new Error("operator alert job payload is malformed");
  }
  return {
    subject: `Postil App removed: ${payload.accountLogin}`,
    content: {
      preheader: `${payload.accountLogin} removed the Postil GitHub App.`,
      category: "Access",
      title: "GitHub App removed",
      summary:
        "Postil no longer receives GitHub events from this installation.",
      organization,
      reason,
      details: [
        ...common,
        { label: "Account type", value: payload.accountType },
        {
          label: "Installation ID",
          value: String(payload.githubInstallationId),
        },
      ],
      action,
      note: "Confirm whether the removal was expected before contacting the owner.",
      intent: "notice",
    },
  };
}

function formatUtcDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}
