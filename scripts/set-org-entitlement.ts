import { eq } from "drizzle-orm";

import { closeDb, getDb, schema } from "@/lib/db";
import { centsToMicros } from "@/lib/billing-credits";
import { HOSTED_REVIEW_RESERVATION_MICROS } from "@/lib/hosted-usage-reservations";

export interface EntitlementOptions {
  org: string;
  confirmOrg: string | null;
  mode: "hosted" | "byok";
  status: "active" | "trialing" | "past_due" | "suspended";
  trialEndsAt: Date | null;
  pastDueGraceEndsAt: Date | null;
  periodStartsAt: Date | null;
  periodEndsAt: Date | null;
  includedUsageCents: number;
  overageHardCapCents: number | null;
  promotionalEligible: boolean;
  promotionalEndsAt: Date | null;
  actor: string;
  dryRun: boolean;
  yes: boolean;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseEntitlementArgs(args);
  assertMutationAuthorized(options);
  const db = getDb();
  try {
    const org = (
      await db
        .select({ id: schema.organizations.id, slug: schema.organizations.slug })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, options.org))
        .limit(1)
    )[0];
    if (!org) throw new Error(`organization not found: ${options.org}`);
    const values = {
      orgId: org.id,
      subscriptionMode: options.mode,
      status: options.status,
      trialEndsAt: options.trialEndsAt,
      pastDueGraceEndsAt: options.pastDueGraceEndsAt,
      periodStartsAt: options.periodStartsAt,
      periodEndsAt: options.periodEndsAt,
      includedUsageCents: options.includedUsageCents,
      overageHardCapCents: options.overageHardCapCents,
      includedUsageMicros: centsToMicros(options.includedUsageCents),
      overageHardCapMicros:
        options.overageHardCapCents === null
          ? null
          : centsToMicros(options.overageHardCapCents),
      promotionalEligible: options.promotionalEligible,
      promotionalEndsAt: options.promotionalEndsAt,
      updatedBy: options.actor,
      updatedAt: new Date(),
    };
    if (options.dryRun) {
      console.log(
        `dry-run org=${org.slug} mode=${options.mode} status=${options.status} promotion=${options.promotionalEligible} included_cents=${options.includedUsageCents} overage_cap_cents=${options.overageHardCapCents ?? "none"}`,
      );
      return;
    }
    await db
      .insert(schema.organizationEntitlements)
      .values(values)
      .onConflictDoUpdate({
        target: schema.organizationEntitlements.orgId,
        set: values,
      });
    console.log(
      `applied org=${org.slug} mode=${options.mode} status=${options.status} promotion=${options.promotionalEligible}`,
    );
  } finally {
    await closeDb();
  }
}

export function assertMutationAuthorized(options: EntitlementOptions): void {
  if (!options.dryRun && (!options.yes || options.confirmOrg !== options.org)) {
    throw new Error(
      `refusing to mutate ${options.org}: pass --yes and --confirm-org ${options.org}, or use --dry-run`,
    );
  }
}

export function parseEntitlementArgs(args: string[]): EntitlementOptions {
  if (args.length === 0) {
    printUsage();
    throw new Error("no entitlement options supplied");
  }
  const values = new Map<string, string>();
  let dryRun = false;
  let yes = false;
  let promotionalEligible = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      throw new HelpRequested();
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--promotional-eligible") {
      promotionalEligible = true;
      continue;
    }
    if (arg === "--no-promotional-eligible") {
      promotionalEligible = false;
      continue;
    }
    if (!arg?.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg.slice(2), value);
    index += 1;
  }
  const org = required(values, "org");
  const mode = required(values, "mode");
  if (mode !== "hosted" && mode !== "byok") {
    throw new Error("--mode must be hosted or byok");
  }
  const status = required(values, "status");
  if (
    status !== "active" &&
    status !== "trialing" &&
    status !== "past_due" &&
    status !== "suspended"
  ) {
    throw new Error("--status must be active, trialing, past_due, or suspended");
  }
  if (values.has("billing-contact-email") || values.has("billing-contact-verified-at")) {
    throw new Error("billing contacts must be changed and verified through the organization billing page");
  }
  const trialEndsAt = optionalDate(values, "trial-ends-at");
  if (status === "trialing" && !trialEndsAt) {
    throw new Error("--status trialing requires --trial-ends-at");
  }
  const periodStartsAt = optionalDate(values, "period-starts-at");
  const periodEndsAt = optionalDate(values, "period-ends-at");
  if (Boolean(periodStartsAt) !== Boolean(periodEndsAt)) {
    throw new Error("--period-starts-at and --period-ends-at must be supplied together");
  }
  if (periodStartsAt && periodEndsAt && periodStartsAt >= periodEndsAt) {
    throw new Error("--period-starts-at must be before --period-ends-at");
  }
  const includedUsageCents = nonnegativeInteger(
    values.get("included-usage-cents") ?? "0",
    "--included-usage-cents",
  );
  if (
    mode === "hosted" &&
    (status === "active" || status === "trialing" || promotionalEligible) &&
    centsToMicros(includedUsageCents) < HOSTED_REVIEW_RESERVATION_MICROS
  ) {
    throw new Error(
      `hosted active, trialing, or promotional access requires --included-usage-cents of at least ${HOSTED_REVIEW_RESERVATION_MICROS / 10_000}`,
    );
  }
  return {
    org,
    confirmOrg: optional(values, "confirm-org"),
    mode,
    status,
    trialEndsAt,
    pastDueGraceEndsAt: optionalDate(values, "past-due-grace-ends-at"),
    periodStartsAt,
    periodEndsAt,
    includedUsageCents,
    overageHardCapCents: values.has("overage-hard-cap-cents")
      ? nonnegativeInteger(values.get("overage-hard-cap-cents")!, "--overage-hard-cap-cents")
      : mode === "hosted"
        ? 0
        : null,
    promotionalEligible,
    promotionalEndsAt: optionalDate(values, "promotional-ends-at"),
    actor: required(values, "actor").trim(),
    dryRun,
    yes,
  };
}

class HelpRequested extends Error {}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function optional(values: Map<string, string>, name: string): string | null {
  return values.get(name)?.trim() || null;
}

function optionalDate(values: Map<string, string>, name: string): Date | null {
  const value = optional(values, name);
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--${name} must be an ISO timestamp`);
  return date;
}

function nonnegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a nonnegative integer number of cents`);
  }
  return parsed;
}

function printUsage(): void {
  console.log(`Usage:
  bun run billing:set-entitlement -- --org acme --mode hosted --status active --included-usage-cents 600 --actor ops@example --dry-run
  bun run billing:set-entitlement -- --org acme --confirm-org acme --mode byok --status active --actor ops@example --yes

Applies the complete organization entitlement state idempotently. This command never accepts payment or provider secrets.

Required:
  --org SLUG                    Organization slug.
  --mode hosted|byok            Product subscription mode; BYOK keys alone grant nothing.
  --status active|trialing|past_due|suspended
  --actor IDENTIFIER            Operator audit identity.

Safety:
  --dry-run                     Resolve and print the intended state without mutation.
  --yes                         Confirm mutation; also requires matching --confirm-org.
  --confirm-org SLUG            Must exactly match --org for mutation.

Optional state:
  --trial-ends-at ISO           Exclusive trial expiry.
  --past-due-grace-ends-at ISO  Exclusive grace expiry.
  --period-starts-at ISO        Usage period lower bound.
  --period-ends-at ISO          Usage period upper bound.
  --included-usage-cents N      Included usage. At least 100 cents is required for hosted active, trialing, or promotional access.
  --overage-hard-cap-cents N    Maximum overage; hosted defaults to 0, BYOK omission means no provider-spend cap.
  --promotional-eligible        Enable operator-managed promotion.
  --no-promotional-eligible     Disable operator-managed promotion.
  --promotional-ends-at ISO     Exclusive promotion expiry.`);
}

if (import.meta.main) {
  main().catch(async (error) => {
    await closeDb().catch(() => undefined);
    if (error instanceof HelpRequested) return;
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
