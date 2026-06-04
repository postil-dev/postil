import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { env } from "@/lib/env";
import type { Metadata } from "next";
import { TrackedLink } from "@/components/tracked-link";
import { buttonVariants } from "@/components/ui/button";
import { CtaStrip, PageFrame, SectionIntro } from "../site";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function InstallPage() {
  if (env.GITHUB_APP_INSTALL_URL) redirect(env.GITHUB_APP_INSTALL_URL);

  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionIntro
            eyebrow="Managed beta"
            title="Hosted installs are opening soon."
            body="The managed GitHub App is pending final review before public installation links are enabled. You can still run Postil in CI with the reviewer CLI today."
          />
          <div className="mt-8 flex flex-wrap gap-3">
            <TrackedLink href="https://github.com/postil-dev/postil-reviewer" cta="Try CLI" className={buttonVariants({ size: "lg" })}>
              Try the CLI <ArrowRight className="ml-2 h-4 w-4" />
            </TrackedLink>
            <TrackedLink href="/docs" cta="Read docs" className={buttonVariants({ variant: "outline", size: "lg" })}>
              Read docs
            </TrackedLink>
          </div>
        </div>
      </section>
      <section className="py-16">
        <div className="mx-auto grid max-w-7xl gap-4 px-4 sm:px-6 md:grid-cols-3">
          {[
            ["Hosted", "Public install links will appear here after the managed app is ready for external teams."],
            ["CI", "Run the open reviewer from GitHub Actions while hosted onboarding is pending."],
            ["Quiet by default", "Clean reviews can stay silent; findings focus on concrete merge risk."],
          ].map(([title, body]) => (
            <article key={title} className="border bg-card p-6">
              <h2 className="text-2xl">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
            </article>
          ))}
        </div>
      </section>
      <CtaStrip />
    </PageFrame>
  );
}
