import { notFound } from "next/navigation";

import { db } from "@/db/client";
import { reviews } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata = { title: "Review" };
export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let review: Awaited<ReturnType<typeof loadOne>> = null;
  try {
    review = await loadOne(id);
  } catch {
    return notFound();
  }
  if (!review) return notFound();

  const env = review.result;
  const findings = env?.findings ?? [];

  return (
    <article className="container-page py-16 max-w-3xl">
      <div className="text-sm text-[color:var(--color-charcoal-soft)] mb-2 font-mono">
        {review.repoFullName} · #{review.pullNumber} · {review.headSha.slice(0, 7)}
      </div>
      <h1 className="font-serif text-4xl mb-2">
        {findings.length === 0
          ? "No merge-relevant findings."
          : `${findings.length} finding${findings.length === 1 ? "" : "s"}`}
      </h1>
      {env?.summary && (
        <p className="text-[color:var(--color-charcoal-soft)] leading-relaxed mt-4">
          {env.summary}
        </p>
      )}
      <div className="text-sm text-[color:var(--color-charcoal-soft)] mt-3 font-mono">
        model: {env?.modelUsed ?? "—"} · tokens: {env?.usage?.totalTokens ?? 0}
      </div>

      {findings.length > 0 && (
        <div className="mt-8 space-y-3">
          {findings.map((f, i) => (
            <div key={`${f.path}-${f.line}-${i}`} className="panel p-5">
              <div className="flex justify-between items-baseline mb-2">
                <code className="font-mono text-xs">
                  {f.path}:{f.line}
                </code>
                <div className="flex gap-2">
                  <span className={`chip chip-${f.severity}`}>{f.severity}</span>
                  {f.kind && <span className="chip">{f.kind}</span>}
                </div>
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{f.body}</p>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

async function loadOne(id: string) {
  const [row] = await db.select().from(reviews).where(eq(reviews.id, id)).limit(1);
  return row ?? null;
}
