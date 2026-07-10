import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Postil stores, what it never stores, and how bring-your-own keys are handled.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="prose-postil mx-auto">
        <p className="eyebrow">Privacy</p>
        <h1 className="serif-display mt-3 text-4xl text-charcoal">
          What we store, and what we don&apos;t.
        </h1>

        <h2>Source code is never persisted</h2>
        <p>
          The hosted control plane does not store your code. When a hosted
          review runs, the worker fetches the pull-request diff with a
          short-lived installation token, sends it through either Postil&apos;s
          configured provider path or the BYOK provider path configured for your
          organization, and exits. CLI and self-hosted reviews send diffs
          directly to the endpoint you configure. The diff lives in process
          memory for the duration of the review and is gone with the process.
          There is no code cache, no embedding index, and no repository clone on
          our infrastructure.
        </p>

        <h2>What is stored</h2>
        <ul>
          <li>
            <strong>Review envelopes</strong>: the JSON verdict of each review,
            covering summary, findings (file path, line number, severity, confidence,
            title, body), token counts, model id, and commit SHAs. Findings
            quote at most the few words needed to identify the issue.
          </li>
          <li>
            <strong>Account data</strong>: your GitHub user id, login, name,
            email, and avatar, provided during OAuth sign-in.
          </li>
          <li>
            <strong>Installation metadata</strong>: which repositories the App
            is installed on, by id and name.
          </li>
          <li>
            <strong>Usage events</strong>: prompt and completion token counts
            per review, for dashboards, operations, abuse prevention, and
            internal cost monitoring.
          </li>
          <li>
            <strong>Webhook delivery ids</strong>, kept for deduplication.
          </li>
        </ul>

        <h2>Envelope retention</h2>
        <p>
          Envelopes are retained while your organization has an account, both
          because they power the dashboard and because incremental re-review
          uses the previous envelope as its baseline. Deleting your
          organization deletes its envelopes, usage events, and settings.
          Uninstalling the GitHub App deletes the installation and its
          repository records.
        </p>

        <h2>Bring-your-own API keys</h2>
        <p>
          Organization LLM keys are sealed with AES-256-GCM before they reach
          the database and are decrypted only inside the worker, at the moment
          a review starts. The settings form is write-only: a stored key can
          be replaced or removed, never displayed. Keys are never logged and
          never leave the worker except as the Authorization header to the
          endpoint you configured.
        </p>

        <h2>Tokens and credentials</h2>
        <p>
          GitHub installation tokens are minted on demand, held in memory
          only, and expire within an hour. The GitHub App private key is
          provided via environment configuration and is never written to the
          database or to logs.
        </p>

        <h2>Subprocessors</h2>
        <ul>
          <li>
            <strong>GitHub</strong> (source forge and OAuth identity): webhooks,
            check-runs, review comments, sign-in.
          </li>
          <li>
            <strong>Model providers</strong> receive the diff for the duration
            of a model call. Hosted BYOK reviews route through the Postil worker
            to your configured provider under your own provider relationship.
            Hosted reviews without BYOK settings use Postil&apos;s configured
            OpenRouter-compatible provider path; the default is{" "}
            <strong>OpenRouter</strong>, which forwards the request to a
            downstream model provider. CLI and self-hosted deployments send
            diffs directly to the endpoint you configure. For sensitive code we
            recommend BYOK pointed directly at your chosen provider, or
            self-hosting (below).
          </li>
          <li>
            <strong>Fly.io</strong> (application hosting): runs the web control
            plane and the review worker.
          </li>
          <li>
            <strong>Supabase Postgres</strong> provides managed PostgreSQL
            storage for accounts, installations, and review envelopes.
          </li>
          <li>
            <strong>PostHog</strong> provides privacy-scoped analytics: it
            stores aggregate pageview and request telemetry so we can understand
            traffic sources, documentation usage, and likely bot or automation
            traffic.
          </li>
        </ul>
        <p>
          Hosted Postil uses analytics for product and traffic measurement on
          public marketing, documentation, blog, install, pricing, and
          comparison pages. Browser analytics record pageviews, sanitized
          referrers, and campaign parameters with session replay and
          autocaptured clicks disabled. Server-side request telemetry records
          sanitized path, referrer origin/public path, campaign parameters,
          user agent, and Cloudflare bot metadata when present; it does not
          send IP addresses, arbitrary query strings, or protected dashboard
          paths. The site also sets one first-party session cookie after
          sign-in.
        </p>

        <h2>Where data is processed (residency)</h2>
        <p>
          For the hosted service, application hosting runs on Fly.io in the
          London region (<code>lhr</code>) and the managed database runs in a
          European region, so your account data and review envelopes are
          processed and stored in the UK/EU. PostHog analytics should use EU
          Cloud for the hosted service. Review inference is separate from that
          account-data boundary: hosted reviews without BYOK model settings send
          diffs from the worker to Postil&apos;s configured OpenRouter-compatible
          provider path and downstream model providers, so inference has no
          fixed UK/EU residency guarantee. When your org uses BYOK,
          diffs go to whatever provider and region you configure. A self-hosted
          deployment keeps all data on your own infrastructure, wherever you run
          it. We make no SOC 2 or ISO certification claim.
        </p>

        <h2>Self-hosted</h2>
        <p>
          Self-hosted deployments send nothing to us. No telemetry, no
          license pings, no update checks. Your envelopes stay in your
          Postgres.
        </p>

        <h2>Contact</h2>
        <p>
          Privacy questions: hello@postil.dev. Security reports: see{" "}
          <a href="/.well-known/security.txt">security.txt</a>.
        </p>
      </div>
    </div>
  );
}
