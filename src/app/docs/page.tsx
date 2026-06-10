import Link from "next/link";

import { Code } from "@/components/code";

export const metadata = { title: "Docs" };

export default function DocsIndexPage() {
  return (
    <article className="container-page py-16 max-w-3xl">
      <h1 className="font-serif text-5xl mb-4">Docs</h1>
      <p className="text-lg text-[color:var(--color-charcoal-soft)] mb-10 max-w-prose">
        Pick a path. Everything here ships in the open repos under Apache-2.0.
      </p>

      <div className="grid md:grid-cols-2 gap-4 mb-12">
        <DocCard href="/docs/config" title=".postil.yaml">
          Per-repo policy: ignore globs, severity threshold, reviewer focus, auto-merge.
        </DocCard>
        <DocCard href="/docs/self-hosted" title="Self-hosted">
          Docker Compose, GitHub Enterprise Server, BYO model providers.
        </DocCard>
        <DocCard href="/docs/envelope" title="Review envelope">
          The JSON contract between the CLI and every consumer.
        </DocCard>
        <DocCard href="/why-postil" title="Doctrine">
          What we don't do, what we do, what we charge for.
        </DocCard>
      </div>

      <h2 className="font-serif text-3xl mb-3">Quickstart</h2>
      <Code>{`# 1. Install the CLI
cargo install --git https://github.com/postil-dev/postil-cli --locked

# 2. Configure secrets
export GITHUB_TOKEN=ghp_...
export OPENROUTER_API_KEY=sk-or-...

# 3. Review locally before pushing
postil review --staged

# 4. Or review a remote PR
postil review --repo owner/name --pr 123 --sha <head-sha>`}</Code>

      <h2 className="font-serif text-3xl mt-12 mb-3">Exit codes</h2>
      <div className="panel-quiet p-4 font-mono text-sm">
        <div><strong>0</strong> · clean, or all findings below <code>--fail-on</code></div>
        <div><strong>1</strong> · at least one finding at or above <code>--fail-on</code></div>
        <div><strong>2</strong> · configuration error</div>
      </div>

      <p className="mt-10 text-[color:var(--color-charcoal-soft)]">
        Looking for the source? See{" "}
        <Link href="https://github.com/postil-dev/postil-cli">postil-cli</Link>.
      </p>
    </article>
  );
}

function DocCard({ href, title, children }: { href: string; title: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="panel p-5 block no-underline hover:border-[color:var(--color-gate)]">
      <div className="font-serif text-xl font-medium mb-1">{title}</div>
      <p className="text-sm text-[color:var(--color-charcoal-soft)]">{children}</p>
    </Link>
  );
}
