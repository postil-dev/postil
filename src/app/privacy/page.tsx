export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <article className="container-page py-16 max-w-3xl">
      <h1 className="font-serif text-5xl mb-6">Privacy</h1>

      <p className="text-lg text-[color:var(--color-charcoal-soft)] mb-8 leading-relaxed">
        Postil reads the unified diff of a pull request and any repo-root config files
        it needs to apply your policy (<code>.postil.yaml</code>,{" "}
        <code>.coderabbit.yaml</code>, <code>.kodo.yaml</code>). That context is sent to
        the model provider <em>you</em> configure. The website and hosted worker do not
        contain review logic — review prompts and model calls live only in the CLI.
      </p>

      <Section title="What model providers see">
        Whatever model you point Postil at receives the diff and the system prompt. If
        you bring your own key (the only supported mode), the inference relationship is
        between you and the provider; we never proxy or store the prompt text.
      </Section>

      <Section title="What we store">
        Per-review metadata: repo full name, PR number, head SHA, status, the parsed
        envelope (summary, severities, paths, line numbers), token-usage counters, and
        the model used. We do not store the diff. We do not store full file contents. We
        do not store secrets — installation tokens are encrypted in flight and not
        persisted.
      </Section>

      <Section title="Telemetry">
        Anonymous usage events for product analytics go to PostHog EU. No code content,
        no PR titles, no user identifiers beyond an opaque org id. You can disable
        analytics by setting <code>POSTHOG_API_KEY</code> to empty in your self-hosted
        deployment.
      </Section>

      <Section title="Repository access">
        The GitHub App requests the minimum permissions required: read on contents,
        read/write on pull-requests (for inline comments), read/write on checks (for the
        check-run), and the <code>pull_request</code> webhook event.
      </Section>

      <Section title="Self-hosted">
        Self-hosted Postil never calls out to <code>postil.dev</code>. The CLI talks to
        GitHub and to the model provider you choose. That is it.
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-serif text-2xl mb-2">{title}</h2>
      <p className="text-[color:var(--color-charcoal-soft)] leading-relaxed">
        {children}
      </p>
    </section>
  );
}
