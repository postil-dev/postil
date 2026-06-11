"use server";

import { revalidatePath } from "next/cache";

import { and, eq } from "drizzle-orm";

import { validateApiBase } from "@/lib/api-base";
import { getSealingKey, seal } from "@/lib/crypto/seal";
import { getDb, schema } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

/** Resolve org by slug and assert the current user is a member. */
async function requireMembership(slug: string): Promise<{ orgId: number }> {
  const user = await getSessionUser();
  if (!user) throw new Error("not signed in");
  const db = getDb();
  const org = (
    await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1)
  )[0];
  if (!org) throw new Error("organization not found");
  const member = await db
    .select({ id: schema.orgMembers.id })
    .from(schema.orgMembers)
    .where(and(eq(schema.orgMembers.orgId, org.id), eq(schema.orgMembers.userId, user.id)))
    .limit(1);
  if (member.length === 0) throw new Error("not a member of this organization");
  return { orgId: org.id };
}

export async function toggleRepository(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const repositoryId = Number(formData.get("repositoryId"));
  const enable = formData.get("enable") === "true";
  const { orgId } = await requireMembership(slug);

  const db = getDb();
  // Constrain the update to repositories that actually belong to this org.
  const repo = (
    await db
      .select({ id: schema.repositories.id })
      .from(schema.repositories)
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(and(eq(schema.repositories.id, repositoryId), eq(schema.installations.orgId, orgId)))
      .limit(1)
  )[0];
  if (!repo) throw new Error("repository not found in this organization");

  await db
    .update(schema.repositories)
    .set({ enabled: enable })
    .where(eq(schema.repositories.id, repo.id));
  revalidatePath(`/orgs/${slug}`);
}

export async function saveOrgSettings(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const { orgId } = await requireMembership(slug);

  const apiBase = String(formData.get("apiBase") ?? "").trim() || null;
  // SSRF guard: the worker hands this URL to the CLI as POSTIL_API_BASE.
  if (apiBase) validateApiBase(apiBase);
  const model = String(formData.get("model") ?? "").trim() || null;
  const modelCascade = String(formData.get("modelCascade") ?? "").trim() || null;
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const removeKey = formData.get("removeKey") === "on";

  const db = getDb();
  const base = { apiBase, model, modelCascade, updatedAt: new Date() };

  // The key is write-only: set when provided, cleared when requested,
  // otherwise left untouched. It is never read back to the form.
  let keyUpdate: { apiKeyCiphertext: Buffer | null } | Record<string, never> = {};
  if (removeKey) {
    keyUpdate = { apiKeyCiphertext: null };
  } else if (apiKey.length > 0) {
    keyUpdate = { apiKeyCiphertext: seal(apiKey, getSealingKey()) };
  }

  await db
    .insert(schema.orgSettings)
    .values({
      orgId,
      ...base,
      apiKeyCiphertext: "apiKeyCiphertext" in keyUpdate ? keyUpdate.apiKeyCiphertext : null,
    })
    .onConflictDoUpdate({
      target: schema.orgSettings.orgId,
      set: { ...base, ...keyUpdate },
    });
  revalidatePath(`/orgs/${slug}`);
}
