import Link from "next/link";

export const metadata = {
  title: "Why Postil",
  description:
    "Most AI reviewers ship noise. Postil ships restraint. Here is what changes when silence is a feature.",
};

export default function WhyPostilPage() {
  return (
    <article className="container-page py-16 max-w-3xl">
      <div className="chip mb-6">Why Postil</div>
      <h1 className="font-serif text-5xl mb-6">Restraint is the feature.</h1>

      <p className="text-lg text-[color:var(--color-charcoal-soft)] mb-8 leading-relaxed">
        Every AI code reviewer in the market today is optimised for one thing: leaving
        comments. Per-seat pricing, "feature richness" demos, and engagement metrics all
        push the same direction — more output per PR. Predictably, the most common
        complaint in every product community is the same word: <em>noise</em>.
      </p>

      <Section title="What we don't do">
        <ul className="space-y-2 list-disc pl-5">
          <li>Style nitpicks already covered by your linter or formatter.</li>
          <li>Sequence diagrams, poems, and "I reviewed this" filler.</li>
          <li>"Consider adding a test" without a concrete bug the test would catch.</li>
          <li>Praise, encouragement, or self-dismissing observations ("minor nit:").</li>
          <li>Re-reviewing the whole PR every time a one-line fixup commit lands.</li>
        </ul>
      </Section>

      <Section title="What we do">
        <ul className="space-y-2 list-disc pl-5">
          <li>
            Stay silent on clean PRs. The required <code>postil/review</code> check
            completes with no comment.
          </li>
          <li>
            Name a concrete merge risk, with a path:line the diff actually touches.
          </li>
          <li>
            Escalate decisions to accountable humans when the answer is not in the diff.
          </li>
          <li>
            Suggest a durable guardrail — a lint rule, a CI check, a policy — when the
            same class of problem keeps recurring.
          </li>
          <li>Fail closed. Bad model output never silently approves.</li>
        </ul>
      </Section>

      <Section title="What we charge for">
        <p className="mb-4 leading-relaxed">
          A flat orchestration fee per developer. Inference is not bundled. Bring your
          own OpenRouter, Anthropic, OpenAI, Azure, Bedrock, or self-hosted endpoint key,
          and your LLM bill stays in your provider dashboard. No hidden markup. No meter
          shock when your team scales up usage.
        </p>
        <Link href="/pricing" className="btn-secondary">
          See pricing
        </Link>
      </Section>

      <Section title="What we open-source">
        <p className="leading-relaxed">
          The review engine — every prompt, every parser, every filter — is in
          {" "}
          <Link href="https://github.com/postil-dev/postil-cli">postil-cli</Link>, a
          single Rust binary under Apache-2.0. The GitHub Action is a thin composite
          wrapper. The backend, website, and GitHub App are also open. You can run the
          exact same engine the hosted product runs, locally or in your own CI, today.
        </p>
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-serif text-2xl mb-3">{title}</h2>
      <div className="text-[color:var(--color-charcoal-soft)]">{children}</div>
    </section>
  );
}
