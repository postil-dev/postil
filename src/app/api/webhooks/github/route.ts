/**
 * GitHub webhook handler. Single entry point for all relevant events.
 *
 * Events handled:
 *   - pull_request (opened, reopened, synchronize, ready_for_review)
 *   - installation (created, deleted, suspended, unsuspended)
 *
 * Idempotency: every delivery is recorded by (source, delivery_id). Duplicate
 * deliveries return 200 immediately with no side effects. Signature verified
 * via HMAC-SHA256 against GITHUB_WEBHOOK_SECRET.
 */

import { randomUUID } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { installations, webhookDeliveries } from "@/db/schema";
import { dispatchReview } from "@/lib/dispatch";
import { verifyGithubSignature } from "@/lib/crypto";
import { env, hasGithubApp } from "@/lib/env";

export const dynamic = "force-dynamic";

type PRPayload = {
  action: string;
  pull_request?: { number: number; head: { sha: string }; draft: boolean };
  repository?: { full_name: string };
  installation?: { id: number };
};

type InstallationPayload = {
  action: string;
  installation: {
    id: number;
    account: { login: string; type: string };
    repository_selection: string;
    suspended_at: string | null;
  };
};

export async function POST(req: NextRequest) {
  if (!hasGithubApp()) {
    return NextResponse.json({ ok: false, reason: "github_app_not_configured" }, { status: 503 });
  }

  const e = env();
  const secret = e.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, reason: "no_webhook_secret" }, { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const verified = await verifyGithubSignature(rawBody, signature, secret);
  if (!verified) {
    return new Response("invalid signature", { status: 401 });
  }

  const event = req.headers.get("x-github-event") ?? "";
  const deliveryId = req.headers.get("x-github-delivery") ?? randomUUID();

  // Dedupe.
  const dedupe = await db
    .insert(webhookDeliveries)
    .values({
      id: randomUUID(),
      source: "github",
      deliveryId,
      event,
      payload: tryParse(rawBody),
    })
    .onConflictDoNothing({ target: [webhookDeliveries.source, webhookDeliveries.deliveryId] })
    .returning({ id: webhookDeliveries.id });

  if (dedupe.length === 0) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  const payload = tryParse(rawBody);
  if (!payload) return NextResponse.json({ ok: true, ignored: "bad_payload" });

  if (event === "pull_request") {
    return handlePullRequest(payload as PRPayload);
  }
  if (event === "installation") {
    return handleInstallation(payload as InstallationPayload);
  }

  return NextResponse.json({ ok: true, ignored: event });
}

async function handlePullRequest(payload: PRPayload) {
  const wanted = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
  if (!wanted.has(payload.action)) return NextResponse.json({ ok: true, ignored: payload.action });
  if (!payload.pull_request || !payload.repository || !payload.installation) {
    return NextResponse.json({ ok: true, ignored: "missing_fields" });
  }
  if (payload.pull_request.draft) {
    return NextResponse.json({ ok: true, ignored: "draft" });
  }

  const result = await dispatchReview({
    repoFullName: payload.repository.full_name,
    pullNumber: payload.pull_request.number,
    headSha: payload.pull_request.head.sha,
    installationId: payload.installation.id,
  });
  return NextResponse.json({ ok: true, ...result });
}

async function handleInstallation(payload: InstallationPayload) {
  if (payload.action === "deleted") {
    return NextResponse.json({ ok: true, deleted: payload.installation.id });
  }
  await db
    .insert(installations)
    .values({
      id: payload.installation.id,
      accountLogin: payload.installation.account.login,
      accountType: payload.installation.account.type,
      repositorySelection: payload.installation.repository_selection,
      suspended: Boolean(payload.installation.suspended_at),
    })
    .onConflictDoUpdate({
      target: installations.id,
      set: {
        accountLogin: payload.installation.account.login,
        repositorySelection: payload.installation.repository_selection,
        suspended: Boolean(payload.installation.suspended_at),
        updatedAt: new Date(),
      },
    });
  return NextResponse.json({ ok: true });
}

function tryParse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
