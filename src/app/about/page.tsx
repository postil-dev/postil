import Link from "next/link";

export const metadata = {
  title: "About",
  description: "What Postil is, who builds it, and how to get in touch.",
};

export default function AboutPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 p-8">
      <h1 className="font-display text-4xl tracking-tight">About Postil</h1>

      <section className="space-y-4 text-muted-foreground">
        <p>
          Postil is an open-source AI pull-request reviewer. It spins up on every
          new PR, reads the diff in context, and leaves inline comments on the
          things that matter — correctness, security, and scope — while staying
          out of the way on style nits. You can run it as a managed service at
          postil.dev or self-host it under Apache-2.0.
        </p>
        <p>
          The project was built to give serious teams a reviewer that ships with
          the code: fast, opinionated where it counts, and quiet where it
          doesn&apos;t. No training on your code, no retention, and no drive-by
          style gripes.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl">Maintainer</h2>
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
        <h2 className="font-display text-xl">Contact</h2>
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
        <h2 className="font-display text-xl">Source &amp; License</h2>
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
