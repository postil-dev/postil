import { notFound } from "next/navigation";

import { db } from "@/db/client";
import { organizations, reviews } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const metadata = { title: "Organization" };
export const dynamic = "force-dynamic";

export default async function OrgPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let org: { id: string; name: string; githubLogin: string } | null = null;
  let recent: Array<{ id: string; pullNumber: number; status: string; requestedAt: Date }> = [];
  try {
    const [row] = await db
      .select({ id: organizations.id, name: organizations.name, githubLogin: organizations.githubLogin })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    org = row ?? null;
    if (org) {
      recent = await db
        .select({
          id: reviews.id,
          pullNumber: reviews.pullNumber,
          status: reviews.status,
          requestedAt: reviews.requestedAt,
        })
        .from(reviews)
        .where(eq(reviews.organizationId, org.id))
        .orderBy(desc(reviews.requestedAt))
        .limit(50);
    }
  } catch {
    return notFound();
  }
  if (!org) return notFound();

  return (
    <article className="container-page py-16 max-w-3xl">
      <div className="text-sm text-[color:var(--color-charcoal-soft)] mb-2">
        github.com/{org.githubLogin}
      </div>
      <h1 className="font-serif text-4xl mb-8">{org.name}</h1>

      <h2 className="font-serif text-xl mb-3">Recent activity</h2>
      <div className="panel">
        {recent.length === 0 ? (
          <div className="p-8 text-center text-[color:var(--color-charcoal-soft)]">
            No reviews yet for this organization.
          </div>
        ) : (
          <ul className="divide-y divide-[color:var(--color-stone)]">
            {recent.map((r) => (
              <li key={r.id} className="px-4 py-3 flex justify-between text-sm">
                <span className="font-mono">#{r.pullNumber}</span>
                <span className="capitalize">{r.status}</span>
                <span className="text-[color:var(--color-charcoal-soft)]">
                  {r.requestedAt.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
