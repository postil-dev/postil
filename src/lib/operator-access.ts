import { notFound } from "next/navigation";

import { getDb } from "@/lib/db";
import {
  requireVerifiedPageSessionUser,
  type SessionUser,
} from "@/lib/session";

function operatorGithubIds(): Set<number> {
  const raw = process.env.POSTIL_OPERATOR_GITHUB_IDS ?? "";
  const ids = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const value = Number(trimmed);
    if (Number.isSafeInteger(value) && value > 0) ids.add(value);
  }
  return ids;
}

export function isOperatorUser(user: Pick<SessionUser, "githubId">): boolean {
  return operatorGithubIds().has(user.githubId);
}

/**
 * Require a signed-in Postil operator. The allowlist is intentionally separate
 * from org membership: being an admin or member of one customer organization
 * must never grant access to cross-tenant review data.
 */
export async function requireOperatorAccess() {
  const user = await requireVerifiedPageSessionUser();
  if (!isOperatorUser(user)) notFound();
  return { db: getDb(), user };
}
