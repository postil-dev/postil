import Link from "next/link";

export const metadata = {
  title: "Pricing",
  description: "Flat orchestration fee. Bring your own inference key. No markup, no meter shock.",
};

export default function PricingPage() {
  return (
    <article className="container-page py-16 max-w-4xl">
      <h1 className="font-serif text-5xl mb-4">Honest, flat, BYO.</h1>
      <p className="text-lg text-[color:var(--color-charcoal-soft)] mb-12 max-w-prose">
        Per-seat tools that bundle inference create unpredictable bills. We charge a flat
        orchestration fee per active developer. You bring your own OpenRouter key and pay
        the model vendor directly.
      </p>

      <div className="grid md:grid-cols-3 gap-4">
        <Plan name="Solo" price="Free" sub="for individuals and OSS">
          <ul className="space-y-1.5">
            <li>Run the CLI locally or in GitHub Actions.</li>
            <li>Unlimited public repos.</li>
            <li>BYO OpenRouter key.</li>
            <li>Community support.</li>
          </ul>
          <Link href="/install" className="btn-secondary mt-6 w-fit">
            Install the CLI
          </Link>
        </Plan>

        <Plan name="Team" price="$10" sub="per active dev / month" highlight>
          <ul className="space-y-1.5">
            <li>Hosted GitHub App. Reviews appear automatically.</li>
            <li>Silence-rate dashboard, finding history, audit log.</li>
            <li>Required-check gate, auto-merge, monorepo path scopes.</li>
            <li>BYO inference key — zero markup.</li>
            <li>Email support.</li>
          </ul>
          <Link href="/install" className="btn-primary mt-6 w-fit">
            Start free beta
          </Link>
        </Plan>

        <Plan name="Self-hosted" price="$0" sub="Apache-2.0, your infra">
          <ul className="space-y-1.5">
            <li>
              <code>docker compose up</code>. Postgres, backend, worker.
            </li>
            <li>GitHub Enterprise Server supported.</li>
            <li>Bring any model: OpenRouter, Anthropic, OpenAI, Azure, Bedrock, Ollama.</li>
            <li>Same engine, same envelope, same doctrine.</li>
            <li>Community support; paid tier available for SLA.</li>
          </ul>
          <Link href="/docs/self-hosted" className="btn-secondary mt-6 w-fit">
            Self-hosted docs
          </Link>
        </Plan>
      </div>

      <section className="mt-16 panel p-8">
        <h2 className="font-serif text-2xl mb-2">What "active dev" means.</h2>
        <p className="text-[color:var(--color-charcoal-soft)] max-w-prose">
          Anyone whose PR Postil reviewed in the billing month. Reviewers who don't push
          code aren't billed. There is no per-PR cap. There is no per-line cap. Your
          model bill is whatever you spend with your model vendor, billed by them.
        </p>
      </section>

      <section className="mt-8 panel-quiet p-8">
        <h2 className="font-serif text-2xl mb-2">Why we don't bundle inference.</h2>
        <p className="text-[color:var(--color-charcoal-soft)] max-w-prose leading-relaxed">
          Bundled inference creates an incentive to use the cheapest model that still
          looks plausible, and to hide that choice from you. If you want Claude Opus on
          your most-critical service and a cheap deepseek model on your docs repo,
          Postil should not have an opinion about which makes us more margin. We charge
          only for orchestration, and the model choice stays yours.
        </p>
      </section>
    </article>
  );
}

function Plan({
  name,
  price,
  sub,
  children,
  highlight,
}: {
  name: string;
  price: string;
  sub: string;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`p-6 flex flex-col gap-3 ${
        highlight ? "panel border-2 border-[color:var(--color-rust)]" : "panel"
      }`}
    >
      <div className="flex items-center justify-between">
        <h3 className="font-serif text-2xl">{name}</h3>
        {highlight && <span className="chip chip-rust">Most teams</span>}
      </div>
      <div>
        <span className="font-serif text-3xl">{price}</span>
        <span className="text-sm text-[color:var(--color-charcoal-soft)] ml-1">
          {sub}
        </span>
      </div>
      <div className="text-sm text-[color:var(--color-charcoal-soft)]">{children}</div>
    </div>
  );
}
