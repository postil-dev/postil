// Representative evidence fixtures from the Postil review harness. These keep
// the same envelope shape the CLI emits, including token usage, so pricing and
// product copy can use the same concrete review artifact.

export interface EvidenceFinding {
  path: string;
  line: number;
  endLine?: number;
  severity: "info" | "warn" | "error";
  kind: string;
  confidence: number;
  title: string;
  body: string;
}

export interface EvidenceEnvelope {
  summary: string;
  silent: boolean;
  findings: EvidenceFinding[];
  gate: { failOn: string; failing: boolean };
  modelUsed: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface EvidenceCase {
  id: string;
  category: string;
  title: string;
  blurb: string;
  diff: string;
  envelope: EvidenceEnvelope;
}

const AUTHZ_DIFF = `diff --git a/src/admin/users.ts b/src/admin/users.ts
--- a/src/admin/users.ts
+++ b/src/admin/users.ts
@@ -31,8 +31,7 @@ export async function deleteUser(ctx: Context, userId: string) {
-  const user = await db.user.findFirst({ where: { id: userId, orgId: ctx.orgId } });
-  if (!user) throw new NotFound();
-  await db.user.delete({ where: { id: user.id } });
+  await db.user.delete({ where: { id: userId } });
   audit.log(ctx.actorId, "user.deleted", { userId });
 }`;

const REFUND_DIFF = `diff --git a/src/billing/refunds.ts b/src/billing/refunds.ts
--- a/src/billing/refunds.ts
+++ b/src/billing/refunds.ts
@@ -19,7 +19,7 @@ export async function refund(invoiceId: string, requestId: string) {
-  await ledger.refund(invoiceId, { idempotencyKey: requestId });
+  await ledger.refund(invoiceId);
   await invoices.markRefunded(invoiceId);
 }`;

const OFFBYONE_DIFF = `diff --git a/src/api/pagination.ts b/src/api/pagination.ts
--- a/src/api/pagination.ts
+++ b/src/api/pagination.ts
@@ -8,10 +8,12 @@ export interface Page<T> { items: T[]; nextCursor: string | null; }
-  let cursor: string | null = null;
-  do { const p = await fetchPage(cursor); out.push(...p.items); cursor = p.nextCursor; } while (cursor !== null);
-  return out;
+  let cursor: string | null = null;
+  for (let i = 1; i < MAX_PAGES; i++) {
+    const p = await fetchPage(cursor); out.push(...p.items); cursor = p.nextCursor;
+    if (cursor === null) return out;
+  }
+  throw new Error(\`pagination exceeded \${MAX_PAGES} pages\`);`;

const SCHEMA_DIFF = `diff --git a/src/api/orders.ts b/src/api/orders.ts
--- a/src/api/orders.ts
+++ b/src/api/orders.ts
@@ -42,7 +42,6 @@ export function serializeOrder(order: Order): OrderResponse {
   return {
     id: order.id,
-    status: order.status,
     totalCents: order.totalCents,
     items: order.items.map(serializeItem),
   };`;

const RACE_DIFF = `diff --git a/src/queue/enqueue.ts b/src/queue/enqueue.ts
--- a/src/queue/enqueue.ts
+++ b/src/queue/enqueue.ts
@@ -13,7 +13,7 @@ export async function enqueueOnce(job: Job) {
-  await db.insert(jobs).values(job).onConflictDoNothing();
+  if (!(await exists(job.id))) await db.insert(jobs).values(job);
 }`;

const SECRET_DIFF = `diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -18,6 +18,7 @@ jobs:
       - name: Deploy
         run: |
+          echo "$PRODUCTION_DATABASE_URL"
           ./scripts/deploy.sh`;

const CLEAN_DIFF = `diff --git a/src/components/button.tsx b/src/components/button.tsx
--- a/src/components/button.tsx
+++ b/src/components/button.tsx
@@ -4,7 +4,7 @@ export function SaveButton() {
-  return <button className="btn btn-primary">Save</button>;
+  return <button className="btn btn-primary">Save changes</button>;
 }`;

export const EVIDENCE_CASES: EvidenceCase[] = [
  {
    id: "authz",
    category: "Security",
    title: "A cross-tenant authorization bypass",
    blurb:
      "The diff removes the org-scoped lookup and deletes by raw id. No type checker or SQL linter catches the tenant boundary disappearing.",
    diff: AUTHZ_DIFF,
    envelope: {
      summary: "The delete path now bypasses the organization-scoped lookup before mutating user data.",
      silent: false,
      findings: [
        {
          path: "src/admin/users.ts",
          line: 32,
          endLine: 32,
          severity: "error",
          kind: "risk",
          confidence: 0.96,
          title: "User deletion no longer enforces the tenant boundary",
          body:
            "The new code deletes `userId` directly and no longer proves the user belongs to `ctx.orgId`. A caller with access to this route could delete a user from another organization if they know or can guess the id.\n\n**Fix:** Restore the scoped lookup, keep the mutation tied to the scoped record, and preserve the not-found path for ids outside the current org.",
        },
      ],
      gate: { failOn: "error", failing: true },
      modelUsed: "deepseek/deepseek-v4-pro",
      usage: { promptTokens: 1192, completionTokens: 514 },
    },
  },
  {
    id: "refund",
    category: "Payments",
    title: "A replayable refund",
    blurb:
      "A retry-safety option disappears from a payment call. The code still compiles and the happy path still refunds once.",
    diff: REFUND_DIFF,
    envelope: {
      summary: "The refund call no longer carries an idempotency key, making retries unsafe.",
      silent: false,
      findings: [
        {
          path: "src/billing/refunds.ts",
          line: 20,
          severity: "error",
          kind: "risk",
          confidence: 0.94,
          title: "Refund retries can issue duplicate refunds",
          body:
            "Dropping `{ idempotencyKey: requestId }` means a worker retry, webhook replay, or network timeout can execute the refund more than once while still marking the invoice refunded.\n\n**Fix:** Keep the provider idempotency key on the refund request and use the same request id across retries for this invoice.",
        },
      ],
      gate: { failOn: "error", failing: true },
      modelUsed: "deepseek/deepseek-v4-pro",
      usage: { promptTokens: 1088, completionTokens: 443 },
    },
  },
  {
    id: "offbyone",
    category: "Correctness",
    title: "A subtle logic bug",
    blurb:
      "A refactor adds a page cap with one character wrong. This is the kind of bug a tired reviewer waves through because the intent looks reasonable.",
    diff: OFFBYONE_DIFF,
    envelope: {
      summary:
        "The new pagination guard introduces an off-by-one error and a hard limit that may break callers expecting full pagination.",
      silent: false,
      findings: [
        {
          path: "src/api/pagination.ts",
          line: 9,
          endLine: 12,
          severity: "error",
          kind: "risk",
          confidence: 0.95,
          title: "Off-by-one in pagination limit causes premature error",
          body:
            "The loop `for (let i = 1; i < MAX_PAGES; i++)` runs at most `MAX_PAGES - 1` iterations. If the data set has exactly `MAX_PAGES` pages, the loop exits with a non-null cursor and throws even though the limit was not exceeded.\n\n**Fix:** Change the loop condition to `i <= MAX_PAGES` so the allowed number of pages can actually be fetched before throwing.",
        },
      ],
      gate: { failOn: "error", failing: true },
      modelUsed: "deepseek/deepseek-v4-pro",
      usage: { promptTokens: 871, completionTokens: 1361 },
    },
  },
  {
    id: "schema",
    category: "API",
    title: "A response contract regression",
    blurb:
      "A field disappears from a public response shape. The server still builds, but clients that branch on order status now lose the signal.",
    diff: SCHEMA_DIFF,
    envelope: {
      summary: "The order serializer drops `status` from the response contract.",
      silent: false,
      findings: [
        {
          path: "src/api/orders.ts",
          line: 44,
          severity: "warn",
          kind: "risk",
          confidence: 0.9,
          title: "Order status removed from API response",
          body:
            "Removing `status` is a breaking response-shape change for clients that render fulfillment state, retry failed payments, or decide whether an order can still be canceled.\n\n**Fix:** Keep `status` in the response or version the endpoint and migrate clients deliberately.",
        },
      ],
      gate: { failOn: "error", failing: false },
      modelUsed: "deepseek/deepseek-v4-pro",
      usage: { promptTokens: 998, completionTokens: 389 },
    },
  },
  {
    id: "race",
    category: "Concurrency",
    title: "A race hidden inside a readability refactor",
    blurb:
      "A single atomic insert becomes check-then-insert. It reads cleaner and races under duplicate deliveries.",
    diff: RACE_DIFF,
    envelope: {
      summary: "The enqueue path replaces an atomic conflict handler with a racy check-then-insert.",
      silent: false,
      findings: [
        {
          path: "src/queue/enqueue.ts",
          line: 14,
          severity: "error",
          kind: "risk",
          confidence: 0.92,
          title: "Check-then-insert can enqueue duplicate jobs",
          body:
            "Two workers can both observe that the job does not exist and then both insert it. The previous `onConflictDoNothing()` kept the uniqueness check and write in one database operation.\n\n**Fix:** Restore the atomic insert with conflict handling, or move the existence check behind a database constraint and transaction that rejects duplicates.",
        },
      ],
      gate: { failOn: "error", failing: true },
      modelUsed: "deepseek/deepseek-v4-pro",
      usage: { promptTokens: 1024, completionTokens: 511 },
    },
  },
  {
    id: "secret-log",
    category: "CI",
    title: "A secret leak in deployment logs",
    blurb:
      "The workflow still deploys. It also prints the production database URL into CI logs before the deploy script runs.",
    diff: SECRET_DIFF,
    envelope: {
      summary: "The deploy workflow now prints a production secret to job logs.",
      silent: false,
      findings: [
        {
          path: ".github/workflows/deploy.yml",
          line: 20,
          severity: "error",
          kind: "risk",
          confidence: 0.98,
          title: "Production database URL is echoed to CI logs",
          body:
            "Printing `$PRODUCTION_DATABASE_URL` exposes credentials to anyone with access to the workflow logs and to any log export integrations. Masking is not a security boundary for deliberate echoing.\n\n**Fix:** Remove the echo and pass the value only to the deploy process through the existing secret environment.",
        },
      ],
      gate: { failOn: "error", failing: true },
      modelUsed: "deepseek/deepseek-v4-pro",
      usage: { promptTokens: 913, completionTokens: 402 },
    },
  },
  {
    id: "clean-label",
    category: "Clean",
    title: "A clean label change",
    blurb:
      "A button label gets clearer without changing behavior. Postil has nothing gate-worthy to say.",
    diff: CLEAN_DIFF,
    envelope: {
      summary: "",
      silent: true,
      findings: [],
      gate: { failOn: "error", failing: false },
      modelUsed: "deepseek/deepseek-v4-pro",
      usage: { promptTokens: 757, completionTokens: 188 },
    },
  },
];
