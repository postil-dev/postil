import Link from "next/link";

import { asc, eq } from "drizzle-orm";

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
  const current = organizations.find((organization) => organization.slug === currentSlug);

  return (
    <details className="group relative">
      <summary
        aria-label={`Switch GitHub account. Current account: ${current?.name ?? currentSlug}`}
        className="btn-secondary cursor-pointer list-none text-xs"
      >
        {current?.name ?? "Switch account"}
        <svg
          aria-hidden="true"
          className="ml-2 inline h-3 w-3 transition-transform group-open:rotate-180 motion-reduce:transition-none"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m2.5 4 3.5 3.5L9.5 4" />
        </svg>
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-64 rounded-card border border-stone bg-cream p-2 shadow-lg">
        <div className="max-h-72 overflow-y-auto">
          {organizations.map((organization) => (
            <Link
              key={organization.slug}
              href={`/orgs/${encodeURIComponent(organization.slug)}`}
              aria-current={organization.slug === currentSlug ? "page" : undefined}
              className="block rounded px-3 py-2 text-sm hover:bg-white/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gate aria-[current=page]:font-medium aria-[current=page]:text-rust"
            >
              {organization.name}
            </Link>
          ))}
        </div>
        <Link
          href="/reports"
          className="mt-1 block border-t border-stone px-3 py-2 text-xs text-ink-soft hover:text-rust focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gate"
        >
          All accounts
        </Link>
      </div>
    </details>
  );
}
