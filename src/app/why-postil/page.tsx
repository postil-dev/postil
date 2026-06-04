import { CtaStrip, PageFrame, SectionIntro, proofPoints } from "../site";

export const metadata = {
  title: "Why Postil",
};

export default function WhyPostilPage() {
  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionIntro
            eyebrow="Why Postil"
            title="The risky part is rarely the typo."
            body="Most teams already have formatters, tests, and CI. Postil is for the cases those tools miss: the authorization check moved below the write, the delete lost its tenant filter, the migration works only on an empty database."
          />
        </div>
      </section>
      <section className="py-16">
        <div className="mx-auto grid max-w-7xl gap-3 px-4 sm:px-6 md:grid-cols-2">
          {proofPoints.map(([title, body]) => (
            <article key={title} className="border bg-card p-6">
              <div className="font-mono text-xs uppercase tracking-[0.16em] text-primary">{title}</div>
              <h2 className="mt-4 text-3xl">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
            </article>
          ))}
        </div>
      </section>
      <CtaStrip />
    </PageFrame>
  );
}
