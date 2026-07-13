/**
 * Local demo seed: one org, one user, repositories, and a spread of
 * reviews with realistic envelopes so the dashboard has something to show.
 *
 *   DATABASE_URL=... bun run seed
 *
 * If POSTIL_SESSION_SECRET is set, a signed session cookie value is printed
 * so you can browse /reports and /orgs/acme without going through OAuth:
 * set it as the `postil_session` cookie.
 */
import { randomBytes } from "node:crypto";

import { calculateUsageCostMicrosForModel } from "@/lib/billing-credits";
import { closeDb, getDb, schema } from "@/lib/db";
import type { Envelope, Finding } from "@/lib/envelope";
import { signSessionToken } from "@/lib/session-token";

function assertLocalSeedTarget(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed: refusing to run with NODE_ENV=production");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("seed: DATABASE_URL is required and must target a local development database");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("seed: DATABASE_URL is invalid; refusing to open a database connection");
  }

  const hostname = parsed.hostname.toLowerCase();
  const socketHost = parsed.searchParams.get("host");
  const localHost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".internal");
  const localSocket = hostname === "" && socketHost?.startsWith("/") === true;

  if (!localHost && !localSocket) {
    throw new Error(
      "seed: refusing non-local DATABASE_URL; use localhost, 127.0.0.1, a .internal host, or a local Unix socket",
    );
  }
}

assertLocalSeedTarget();

function buckets(findings: Finding[]): [number, number, number, number, number] {
  const out: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const f of findings) {
    const i = Math.min(Math.floor(f.confidence / 0.2), 4);
    out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}

function envelope(
  findings: Finding[],
  opts: { failing?: boolean; resolved?: Finding[]; sinceSha?: string | null } = {},
): Envelope {
  const counts = {
    info: 0,
    warn: 0,
    error: 0,
    suppressed: Math.floor(Math.random() * 4),
    ungrounded: 0,
  };
  for (const f of findings) counts[f.severity] += 1;
  const silent = findings.length === 0;
  return {
    version: 1,
    summary: silent
      ? ""
      : `${findings.length} merge-relevant finding(s); the most severe is ${findings[0]?.severity ?? "info"}.`,
    silent,
    findings,
    resolved: opts.resolved ?? [],
    counts,
    confidenceBuckets: buckets(findings),
    gate: { failOn: "error", failing: opts.failing ?? counts.error > 0, blockOnKinds: [] },
    modelUsed: "deepseek/deepseek-v4-pro",
    usage: {
      promptTokens: 2000 + Math.floor(Math.random() * 6000),
      completionTokens: 150 + Math.floor(Math.random() * 700),
    },
    durationMs: 5000 + Math.floor(Math.random() * 55000),
    baseSha: randomBytes(20).toString("hex"),
    headSha: randomBytes(20).toString("hex"),
    sinceSha: opts.sinceSha ?? null,
  };
}

const FINDING_POOL: Finding[] = [
  {
    path: "src/billing/invoice.ts",
    line: 84,
    endLine: 88,
    severity: "error",
    kind: "risk",
    confidence: 0.91,
    title: "Refund path skips idempotency key",
    body: "A retried webhook double-credits the customer.",
  },
  {
    path: "src/api/export.ts",
    line: 31,
    severity: "warn",
    kind: "risk",
    confidence: 0.78,
    title: "Unbounded query feeds the CSV stream",
    body: "The new endpoint has no pagination or row cap.",
  },
  {
    path: "migrations/0042_orders.sql",
    line: 12,
    severity: "warn",
    kind: "humanEscalation",
    confidence: 0.7,
    title: "Destructive column drop on a hot table",
    body: "Dropping `orders.legacy_status` is irreversible; confirm the read path is gone.",
  },
  {
    path: "src/auth/middleware.ts",
    line: 57,
    severity: "info",
    kind: "guardrail",
    confidence: 0.66,
    title: "Repeated review feedback: missing rate limit on auth endpoint",
    body: "Third occurrence this month; consider a durable guardrail rule.",
  },
  {
    path: "src/lib/retry.ts",
    line: 23,
    severity: "info",
    kind: "uncertainty",
    confidence: 0.45,
    title: "Jitter calculation may not match the comment",
    body: "The comment says full jitter; the code implements equal jitter.",
  },
];

async function main(): Promise<void> {
  const db = getDb();

  const [user] = await db
    .insert(schema.users)
    .values({
      githubId: 9999001,
      login: "demo-dev",
      name: "Demo Developer",
      email: "demo@example.invalid",
      avatarUrl: null,
    })
    .onConflictDoUpdate({ target: schema.users.githubId, set: { login: "demo-dev" } })
    .returning();
  if (!user) throw new Error("seed: user insert failed");

  const [org] = await db
    .insert(schema.organizations)
    .values({ slug: "acme", name: "Acme Robotics", githubOrgId: 9999100, plan: "beta" })
    .onConflictDoUpdate({ target: schema.organizations.slug, set: { name: "Acme Robotics" } })
    .returning();
  if (!org) throw new Error("seed: org insert failed");

  await db
    .insert(schema.orgMembers)
    .values({ orgId: org.id, userId: user.id, role: "admin" })
    .onConflictDoNothing();

  const [installation] = await db
    .insert(schema.installations)
    .values({
      githubInstallationId: 555001,
      orgId: org.id,
      accountLogin: "acme",
      accountType: "Organization",
    })
    .onConflictDoUpdate({
      target: schema.installations.githubInstallationId,
      set: { orgId: org.id },
    })
    .returning();
  if (!installation) throw new Error("seed: installation insert failed");

  const repoNames = ["acme/control-tower", "acme/firmware", "acme/website"];
  const repoIds: number[] = [];
  for (let i = 0; i < repoNames.length; i++) {
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        installationId: installation.id,
        githubRepoId: 777000 + i,
        fullName: repoNames[i] ?? "acme/unknown",
        private: i !== 2,
        enabled: i !== 1,
      })
      .onConflictDoUpdate({
        target: schema.repositories.githubRepoId,
        set: { installationId: installation.id },
      })
      .returning();
    if (repo) repoIds.push(repo.id);
  }

  // ~70% silent reviews, a few findings-bearing, one failed, one running.
  let pr = 100;
  for (let i = 0; i < 24; i++) {
    const repositoryId = repoIds[i % repoIds.length];
    if (repositoryId === undefined) continue;
    pr += 1 + (i % 3);
    const queuedAt = new Date(Date.now() - (24 - i) * 6 * 60 * 60 * 1000);
    const startedAt = new Date(queuedAt.getTime() + 4_000);

    if (i === 22) {
      await db.insert(schema.reviews).values({
        repositoryId,
        prNumber: pr,
        headSha: randomBytes(20).toString("hex"),
        baseSha: randomBytes(20).toString("hex"),
        status: "failed",
        errorMessage: "postil CLI exited with code 2: model endpoint returned HTTP 529",
        queuedAt,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 38_000),
      });
      continue;
    }
    if (i === 23) {
      await db.insert(schema.reviews).values({
        repositoryId,
        prNumber: pr,
        headSha: randomBytes(20).toString("hex"),
        baseSha: randomBytes(20).toString("hex"),
        status: "running",
        queuedAt,
        startedAt: new Date(),
      });
      continue;
    }

    const noisy = i % 10 === 3 || i % 10 === 7 || i % 10 === 9;
    const findings = noisy
      ? FINDING_POOL.slice(0, 1 + (i % 3)).map((f) => ({ ...f }))
      : [];
    const env = envelope(findings, {
      resolved: i % 10 === 7 ? [FINDING_POOL[4] as Finding] : [],
      sinceSha: i % 10 === 7 ? randomBytes(20).toString("hex") : null,
    });
    const finishedAt = new Date(startedAt.getTime() + 30_000 + (i % 5) * 17_000);

    const [review] = await db
      .insert(schema.reviews)
      .values({
        repositoryId,
        prNumber: pr,
        headSha: env.headSha,
        baseSha: env.baseSha,
        sinceSha: env.sinceSha,
        status: "completed",
        envelope: env,
        silent: env.silent,
        gateFailing: env.gate.failing,
        advisoryCheckRunId: 31000 + i,
        gateCheckRunId: 32000 + i,
        queuedAt,
        startedAt,
        finishedAt,
      })
      .returning();

    if (review) {
      await db.insert(schema.usageEvents).values({
        orgId: org.id,
        repositoryId,
        reviewId: review.id,
        promptTokens: env.usage.promptTokens,
        completionTokens: env.usage.completionTokens,
        modelUsed: env.modelUsed,
        costMicros: calculateUsageCostMicrosForModel(
          env.modelUsed,
          env.usage.promptTokens,
          env.usage.completionTokens,
        ),
        billingScope: "analytics",
      });
    }
  }

  console.log(`Seeded org "acme" with ${repoNames.length} repositories and 24 reviews.`);

  const secret = process.env.POSTIL_SESSION_SECRET;
  if (secret) {
    const sessionId = randomBytes(32).toString("base64url");
    await db.insert(schema.sessions).values({
      id: sessionId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const cookie = await signSessionToken(sessionId, secret);
    console.log(`Demo session cookie (7 days):\n  postil_session=${cookie}`);
  } else {
    console.log("Set POSTIL_SESSION_SECRET to also mint a demo session cookie.");
  }
}

main()
  .then(() => closeDb())
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
