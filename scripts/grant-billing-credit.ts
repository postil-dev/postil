import { and, asc, eq } from "drizzle-orm";

import {
  calculateBillingCreditBalance,
  formatCurrencyCents,
  parseUsdToCents,
} from "@/lib/billing-credits";
import { closeDb, getDb, schema } from "@/lib/db";

interface GrantCreditOptions {
  org: string;
  confirmOrg: string;
  amount: string;
  reason: string;
  actor: string;
  idempotencyKey: string;
  source: string;
  appliesAt: Date;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.confirmOrg !== options.org) {
    throw new Error("--confirm-org must exactly match --org");
  }

  const amountCents = parseUsdToCents(options.amount);
  const db = getDb();

  try {
    const org = (
      await db
        .select({
          id: schema.organizations.id,
          slug: schema.organizations.slug,
          name: schema.organizations.name,
        })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, options.org))
        .limit(1)
    )[0];
    if (!org) throw new Error(`organization not found: ${options.org}`);

    let inserted = false;
    let grant = (
      await db
        .select({
          id: schema.billingCreditGrants.id,
          amountCents: schema.billingCreditGrants.amountCents,
          reason: schema.billingCreditGrants.reason,
          actor: schema.billingCreditGrants.actor,
          source: schema.billingCreditGrants.source,
          appliesAt: schema.billingCreditGrants.appliesAt,
          idempotencyKey: schema.billingCreditGrants.idempotencyKey,
        })
        .from(schema.billingCreditGrants)
        .where(
          and(
            eq(schema.billingCreditGrants.orgId, org.id),
            eq(schema.billingCreditGrants.idempotencyKey, options.idempotencyKey),
          ),
        )
        .limit(1)
    )[0];

    if (!grant) {
      grant = (
        await db
          .insert(schema.billingCreditGrants)
          .values({
            orgId: org.id,
            amountCents,
            reason: options.reason,
            actor: options.actor,
            source: options.source,
            idempotencyKey: options.idempotencyKey,
            appliesAt: options.appliesAt,
          })
          .onConflictDoNothing()
          .returning({
            id: schema.billingCreditGrants.id,
            amountCents: schema.billingCreditGrants.amountCents,
            reason: schema.billingCreditGrants.reason,
            actor: schema.billingCreditGrants.actor,
            source: schema.billingCreditGrants.source,
            appliesAt: schema.billingCreditGrants.appliesAt,
            idempotencyKey: schema.billingCreditGrants.idempotencyKey,
          })
      )[0];
      inserted = Boolean(grant);
    }

    if (!grant) {
      grant = (
        await db
          .select({
            id: schema.billingCreditGrants.id,
            amountCents: schema.billingCreditGrants.amountCents,
            reason: schema.billingCreditGrants.reason,
            actor: schema.billingCreditGrants.actor,
            source: schema.billingCreditGrants.source,
            appliesAt: schema.billingCreditGrants.appliesAt,
            idempotencyKey: schema.billingCreditGrants.idempotencyKey,
          })
          .from(schema.billingCreditGrants)
          .where(
            and(
              eq(schema.billingCreditGrants.orgId, org.id),
              eq(schema.billingCreditGrants.idempotencyKey, options.idempotencyKey),
            ),
          )
          .limit(1)
      )[0];
    }

    if (!grant) throw new Error("credit grant insert raced but no existing grant was found");
    assertMatchingGrant(grant, options, amountCents);

    const [grants, usageEvents] = await Promise.all([
      db
        .select({
          amountCents: schema.billingCreditGrants.amountCents,
          appliesAt: schema.billingCreditGrants.appliesAt,
        })
        .from(schema.billingCreditGrants)
        .where(eq(schema.billingCreditGrants.orgId, org.id))
        .orderBy(asc(schema.billingCreditGrants.appliesAt), asc(schema.billingCreditGrants.id)),
      db
        .select({
          id: schema.usageEvents.id,
          promptTokens: schema.usageEvents.promptTokens,
          completionTokens: schema.usageEvents.completionTokens,
          modelUsed: schema.usageEvents.modelUsed,
          costCents: schema.usageEvents.costCents,
          createdAt: schema.usageEvents.createdAt,
        })
        .from(schema.usageEvents)
        .where(eq(schema.usageEvents.orgId, org.id))
        .orderBy(asc(schema.usageEvents.createdAt), asc(schema.usageEvents.id)),
    ]);
    const balance = calculateBillingCreditBalance(grants, usageEvents);

    console.log(
      inserted
        ? "Billing credit grant applied."
        : "Billing credit grant already exists; no new row inserted.",
    );
    console.log(`org=${org.slug} name=${org.name}`);
    console.log(`grant_id=${grant.id} idempotency_key=${grant.idempotencyKey}`);
    console.log(
      `grant_amount=${formatCurrencyCents(grant.amountCents)} applies_at=${grant.appliesAt.toISOString()}`,
    );
    console.log(`total_granted=${formatCurrencyCents(balance.totalGrantedCents)}`);
    console.log(`usage_charged=${formatCurrencyCents(balance.usageCostCents)}`);
    console.log(`remaining=${formatCurrencyCents(balance.remainingCents)}`);
    console.log(`charged_usage_events=${balance.chargedUsageEvents}`);
    console.log(`unpriced_usage_events=${balance.unpricedUsageEvents}`);
  } finally {
    await closeDb();
  }
}

function parseArgs(args: string[]): GrantCreditOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (!arg?.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values.set(name, value);
    index += 1;
  }

  const org = requireArg(values, "org");
  const confirmOrg = requireArg(values, "confirm-org");
  const amount = requireArg(values, "amount");
  const reason = requireArg(values, "reason").trim();
  const actor = requireArg(values, "actor").trim();
  const idempotencyKey = requireArg(values, "idempotency-key").trim();
  const source = (values.get("source") ?? "admin_script").trim();
  const appliesAt = new Date(requireArg(values, "applies-at"));

  if (!reason) throw new Error("--reason must be non-empty");
  if (!actor) throw new Error("--actor must be non-empty");
  if (!idempotencyKey) throw new Error("--idempotency-key must be non-empty");
  if (!source) throw new Error("--source must be non-empty");
  if (Number.isNaN(appliesAt.getTime())) throw new Error("--applies-at must be a valid date");

  return { org, confirmOrg, amount, reason, actor, idempotencyKey, source, appliesAt };
}

function assertMatchingGrant(
  grant: {
    amountCents: number;
    reason: string;
    actor: string;
    source: string;
    appliesAt: Date;
  },
  options: GrantCreditOptions,
  amountCents: number,
): void {
  const mismatches: string[] = [];
  if (grant.amountCents !== amountCents) {
    mismatches.push(
      `amount ${formatCurrencyCents(grant.amountCents)} != ${formatCurrencyCents(amountCents)}`,
    );
  }
  if (grant.reason !== options.reason) mismatches.push("reason differs");
  if (grant.actor !== options.actor) mismatches.push("actor differs");
  if (grant.source !== options.source) mismatches.push("source differs");
  if (grant.appliesAt.getTime() !== options.appliesAt.getTime()) {
    mismatches.push(
      `applies_at ${grant.appliesAt.toISOString()} != ${options.appliesAt.toISOString()}`,
    );
  }
  if (mismatches.length > 0) {
    throw new Error(`existing idempotent grant payload mismatch: ${mismatches.join(", ")}`);
  }
}

function requireArg(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function printUsage(): void {
  console.log(`Usage:
  bun run billing:grant-credit -- \\
    --org morgaesis \\
    --confirm-org morgaesis \\
    --amount 200 \\
    --reason "Owner launch credit" \\
    --actor "admin@example" \\
    --idempotency-key morgaesis-2026-07-owner-credit \\
    --applies-at 2026-07-11T00:00:00.000Z

Options:
  --org                 Organization slug to receive the credit.
  --confirm-org         Must exactly match --org.
  --amount              USD amount, for example 200 or 200.00.
  --reason              Audit reason for the credit grant.
  --actor               Operator or process granting the credit.
  --idempotency-key     Stable key that prevents duplicate grants on retries.
  --source              Optional source label, default admin_script.
  --applies-at          Required ISO timestamp for deterministic retries.`);
}

main().catch(async (error) => {
  await closeDb().catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
