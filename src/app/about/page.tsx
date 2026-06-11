import Link from "next/link";

import type { Metadata } from "next";
import { AnchorHeading } from "../site";

export const metadata: Metadata = {
  title: "About",
  description: "Postil's product doctrine and project contact details.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 p-8">
      <AnchorHeading id="top" as="h1" className="font-display text-4xl tracking-tight">
        About Postil
      </AnchorHeading>

      <section className="space-y-4 text-muted-foreground">
        <p>
          Postil is a local-first, low-noise review gate for agent-speed development. It reviews
          GitHub pull request diffs, looks for merge-relevant risk, and stays silent when it has
          nothing useful to add.
        </p>
        <p>
          The project exists for teams that want humans, AI coding tools, and autonomous agents to
          move quickly without letting unchecked changes merge. Postil should catch
          context-dependent regressions, security issues, intent mismatches, and risky changes
          before they become production decisions.
        </p>
        <p>
          Humans still own consequential decisions. When a change touches architecture, security
          posture, data, billing, migrations, infrastructure, or major behavior, Postil should
          request accountable human review instead of pretending to make that judgment itself.
        </p>
      </section>

      <section className="space-y-3">
        <AnchorHeading id="maintainer" as="h2" className="font-display text-xl">
          Maintainer
        </AnchorHeading>
        <p className="text-muted-foreground">
          Postil is maintained by{" "}
          <Link
            href="https://github.com/postil-dev"
            className="text-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
          >
            postil-dev
          </Link>{" "}
          on GitHub.
        </p>
      </section>

      <section className="space-y-3">
        <AnchorHeading id="contact" as="h2" className="font-display text-xl">
          Contact
        </AnchorHeading>
        <p className="text-muted-foreground">
          Security issues:{" "}
          <Link
            href="https://github.com/postil-dev/postil/security/advisories/new"
            className="text-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
          >
            GitHub Security Advisories
          </Link>
          <br />
          General inquiries: <span className="text-foreground">hello@postil.dev</span>
        </p>
      </section>

      <section className="space-y-3">
        <AnchorHeading id="source-license" as="h2" className="font-display text-xl">
          Source &amp; License
        </AnchorHeading>
        <p className="text-muted-foreground">
          Source code is available at{" "}
          <Link
            href="https://github.com/postil-dev/postil"
            className="text-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
          >
            github.com/postil-dev/postil
          </Link>
          . Licensed under the{" "}
          <Link
            href="https://github.com/postil-dev/postil/blob/main/LICENSE"
            className="text-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
          >
            Apache-2.0
          </Link>{" "}
          license.
        </p>
      </section>
    </main>
  );
}
