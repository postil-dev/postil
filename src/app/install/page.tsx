import Link from "next/link";

import { Code } from "@/components/code";
import { env } from "@/lib/env";

export const metadata = {
  title: "Install",
  description: "Three ways to run Postil: hosted GitHub App, GitHub Action, or local CLI.",
};

export default function InstallPage() {
  const installUrl = safeEnv("GITHUB_APP_INSTALL_URL");

  return (
    <article className="container-page py-16 max-w-3xl">
      <h1 className="font-serif text-5xl mb-6">Install Postil.</h1>
      <p className="text-lg text-[color:var(--color-charcoal-soft)] mb-12 max-w-prose">
        Three paths, same engine. Pick whichever matches how your team ships.
      </p>

      <Path n={1} title="Hosted GitHub App" subtitle="Beta is open and free.">
        <p>
          Click install, pick the repos, and the next PR opens with a{" "}
          <code>postil/review</code> check. Nothing else to configure.
        </p>
        {installUrl ? (
          <Link href={installUrl} className="btn-primary mt-4 w-fit">
            Install on GitHub
          </Link>
        ) : (
          <div className="panel-quiet p-4 mt-4 text-sm">
            Hosted beta is rolling out — leave your email below and we'll send the
            install link the moment your org is whitelisted.
          </div>
        )}
      </Path>

      <Path n={2} title="GitHub Action" subtitle="Your CI, your secrets, your model.">
        <p>Add a job to <code>.github/workflows/postil.yml</code>:</p>
        <Code>{`name: Postil Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
  checks: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: postil-dev/postil-action@v1
        with:
          api-key: \${{ secrets.OPENROUTER_API_KEY }}`}</Code>
        <p>
          Mark <code>postil/review</code> as a required status check in branch protection
          to make it a real merge gate.
        </p>
      </Path>

      <Path n={3} title="Local CLI" subtitle="Review before you push.">
        <Code>{`# macOS / Linux
brew install postil-dev/tap/postil

# or any platform with cargo
cargo install --git https://github.com/postil-dev/postil-cli --locked

# review the staged diff
export OPENROUTER_API_KEY=sk-or-...
postil review --staged`}</Code>
      </Path>

      <section className="mt-16 panel p-6">
        <h2 className="font-serif text-2xl mb-2">Self-hosted?</h2>
        <p className="text-[color:var(--color-charcoal-soft)] mb-4">
          Same image, same engine. Postgres, the Next.js backend, a worker, and a
          baked-in CLI. <code>docker compose up</code> on day one.
        </p>
        <Link href="/docs/self-hosted" className="btn-secondary">
          Self-hosted docs
        </Link>
      </section>
    </article>
  );
}

function Path({
  n,
  title,
  subtitle,
  children,
}: {
  n: number;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10 panel p-6">
      <div className="flex items-baseline gap-3 mb-2">
        <span className="font-serif text-2xl text-[color:var(--color-gate)]">{n}.</span>
        <h2 className="font-serif text-2xl">{title}</h2>
      </div>
      <p className="text-sm text-[color:var(--color-charcoal-soft)] mb-4">{subtitle}</p>
      <div className="space-y-3 text-[color:var(--color-charcoal-soft)] leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function safeEnv(_key: "GITHUB_APP_INSTALL_URL"): string | undefined {
  try {
    return env().GITHUB_APP_INSTALL_URL;
  } catch {
    return undefined;
  }
}
