import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { buttonVariants } from "@/components/ui/button";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Install",
  description: "Run the Postil CLI with your own model key.",
  alternates: { canonical: "/install" },
};

async function installGitHubApp() {
  "use server";
  redirect(`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`);
}

export default function InstallPage() {
  const slug = env.GITHUB_APP_SLUG;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 p-8">
      <div className="space-y-4">
        <p className="font-mono text-xs tracking-widest text-primary uppercase">
          Local-first setup
        </p>
        <h1 className="font-display text-4xl tracking-tight">
          Run Postil with your own model key.
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          The current CLI reviews GitHub pull requests from local shells, CI, or hosted workers. It
          uses your GitHub token and OpenRouter key, then emits merge-relevant findings and a
          check-run result.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="font-display text-xl">Install the CLI</h2>
        <pre className="overflow-x-auto border border-border bg-card p-4 font-mono text-sm">
          cargo install --git https://github.com/postil-dev/postil-reviewer --locked --force
        </pre>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl">Review a pull request</h2>
        <pre className="overflow-x-auto border border-border bg-card p-4 font-mono text-sm">
          postil review --repo owner/repo --pr 123 --sha HEAD_SHA
        </pre>
        <p className="text-sm text-muted-foreground">
          Required runtime credentials are read from{" "}
          <span className="font-mono text-foreground">GITHUB_TOKEN</span> and{" "}
          <span className="font-mono text-foreground">OPENROUTER_API_KEY</span>. Configure models
          with <span className="font-mono text-foreground">REVIEW_MODEL</span> or{" "}
          <span className="font-mono text-foreground">REVIEW_MODEL_CASCADE</span>.
        </p>
      </section>

      <div className="flex flex-wrap gap-3">
        <a
          href="https://github.com/postil-dev/postil-reviewer"
          className={buttonVariants({ variant: "outline" })}
        >
          CLI source
        </a>
        {slug ? (
          <form action={installGitHubApp}>
            <button type="submit" className={buttonVariants()}>
              GitHub App preview
            </button>
          </form>
        ) : null}
      </div>
    </main>
  );
}
