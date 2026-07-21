import { asc, eq } from "drizzle-orm";

import { OrganizationSwitcherMenu } from "@/components/organization-switcher-menu";
import { getDb, schema } from "@/lib/db";

interface OrganizationOption {
  slug: string;
  name: string;
}

export async function OrganizationSwitcher({
  currentSlug,
  userId,
}: {
  currentSlug: string;
  userId: number;
}) {
  const organizations = await getDb()
    .select({
      slug: schema.organizations.slug,
      name: schema.organizations.name,
    })
    .from(schema.orgMembers)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.orgMembers.orgId),
    )
    .where(eq(schema.orgMembers.userId, userId))
    .orderBy(asc(schema.organizations.name), asc(schema.organizations.slug));

  return (
    <OrganizationSwitcherList
      currentSlug={currentSlug}
      organizations={organizations}
    />
  );
}

export function OrganizationSwitcherList({
  currentSlug,
  organizations,
}: {
  currentSlug: string;
  organizations: OrganizationOption[];
}) {
  if (organizations.length < 2) return null;
  return (
    <OrganizationSwitcherMenu currentSlug={currentSlug} organizations={organizations} />
  );
}
