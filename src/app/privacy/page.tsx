import type { Metadata } from "next";
import { AnchorHeading } from "../site";

export const metadata: Metadata = {
  title: "Privacy",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-20">
      <AnchorHeading id="top" as="h1" className="font-display text-3xl">
        Privacy
      </AnchorHeading>
      <section className="mt-10 space-y-6 text-sm leading-relaxed text-muted-foreground">
        <p>
          Postil uses PostHog (EU-hosted) to understand how visitors use the marketing site and
          whether the setup flow is working. We collect only what is needed to improve the product:
        </p>
        <ul className="grid list-disc gap-2 pl-5">
          <li>
            <strong className="text-foreground">Page views</strong> - which pages are visited and
            how visitors move through the site.
          </li>
          <li>
            <strong className="text-foreground">CTA clicks</strong> - when you click buttons such as
            “Install on GitHub” or “Try CLI”.
          </li>
          <li>
            <strong className="text-foreground">Errors</strong> - if the site crashes, we capture
            the error type and message so we can fix it.
          </li>
        </ul>
        <p>
          We do not collect your code, repository names, or the contents of pull requests through
          this analytics surface. Diff data is processed only by the review worker and is never used
          for analytics or training.
        </p>
        <AnchorHeading
          id="opting-out"
          as="h2"
          className="mt-8 font-display text-xl text-foreground"
        >
          Opting out
        </AnchorHeading>
        <p>
          You can disable PostHog tracking by enabling Do Not Track in your browser. When opted out,
          no events are sent and no cookies are set.
        </p>
        <p>
          If you have questions, contact us via the security details in our{" "}
          <a
            href="/security"
            className="underline decoration-dotted underline-offset-4 hover:text-foreground"
          >
            security page
          </a>
          .
        </p>
      </section>
    </main>
  );
}
