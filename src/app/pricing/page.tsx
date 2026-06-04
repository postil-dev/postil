import { CheckCircle2 } from "lucide-react";
import { TrackedLink } from "@/components/tracked-link";
import { buttonVariants } from "@/components/ui/button";
import { CtaStrip, PageFrame, SectionIntro } from "../site";

export const metadata = {
  title: "Pricing",
};

const plans = [
  {
    name: "Managed beta",
    price: "Free",
    body: "Hosted Postil reviews will be free during the managed beta while public install access opens.",
    bullets: ["Managed app access opening soon", "Managed review worker", "Inline PR findings", "Clean reviews can stay silent"],
  },
  {
    name: "Self-hosted",
    price: "Apache-2.0",
    body: "Run the reviewer in your own CI with your own model provider and repository policy.",
    bullets: ["Open-source reviewer CLI", "GitHub Action support", "Local diff review", "Auditable configuration"],
  },
];

export default function PricingPage() {
  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionIntro
            eyebrow="Pricing"
            title="Free until billing is real."
            body="Hosted access is opening as a free managed beta after final review. Self-hosting remains available under Apache-2.0."
          />
        </div>
      </section>
      <section className="py-16">
        <div className="mx-auto grid max-w-7xl gap-4 px-4 sm:px-6 md:grid-cols-2">
          {plans.map((plan) => (
            <article key={plan.name} className="border bg-card p-6">
              <div className="font-mono text-xs uppercase tracking-[0.16em] text-primary">{plan.name}</div>
              <div className="mt-5 text-4xl">{plan.price}</div>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">{plan.body}</p>
              <ul className="mt-6 space-y-3 text-sm">
                {plan.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-3">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
              <TrackedLink href="/install" cta={`Start ${plan.name}`} className={`${buttonVariants()} mt-7`}>
                Start
              </TrackedLink>
            </article>
          ))}
        </div>
      </section>
      <CtaStrip />
    </PageFrame>
  );
}
