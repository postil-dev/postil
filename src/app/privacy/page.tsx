import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What Postil stores, what it never stores, and how bring-your-own keys are handled.",
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

        <h2>Full diffs and repository snapshots are not persisted</h2>
        <p>
          When a GitHub App review runs, the worker fetches the pull-request
          diff with a short-lived installation token. BYOK reviews send it to
          the provider configured for the organization. Hosted reviews send it
          through Postil&apos;s configured provider path. CLI and self-hosted
          reviews send diffs directly to the endpoint you configure. The diff
          lives in process memory for the duration of the review and is gone
          with the process. There is no code cache, no embedding index, and no
          repository clone on our infrastructure.
        </p>

        <h2>What is stored</h2>
        <ul>
          <li>
            <strong>Review envelopes</strong>: the JSON verdict of each review,
            covering summary, findings (file path, line number, severity,
            confidence, title, body), token counts, model id, and commit SHAs.
            Findings can contain relevant code excerpts needed to explain the
            issue.
          </li>
          <li>
            <strong>Account data</strong>: your GitHub user id, login, name,
            email, and avatar, provided during OAuth sign-in.
          </li>
          <li>
            <strong>Installation and settings data</strong>: GitHub installation
            and repository identifiers, names, access state, review
            configuration, and sealed provider credentials configured by the
            organization.
          </li>
          <li>
            <strong>Usage and billing records</strong>: model-call attempt
            records when accounting data is available, including purpose, model,
            token counts, and accounting provenance. The organization&apos;s
            entitlement and verified billing contact are also retained. When
            self-service billing is available, it stores Paddle customer,
            subscription, and transaction identifiers, subscription state,
            billing periods, and per-period active-author counts. Card details
            stay with Paddle.
          </li>
          <li>
            <strong>Webhook delivery ids</strong>, kept for 30 days to
            deduplicate retries and redeliveries. Completed payloads are cleared
            immediately.
          </li>
          <li>
            <strong>Webhook recovery metadata</strong>: GitHub delivery ids,
            event names, response status, and bounded redelivery outcomes, kept
            for 30 days. Recovery scans do not fetch webhook request payloads.
          </li>
        </ul>

        <h2>Retention, export, and deletion</h2>
        <p>
          Envelopes are retained while your organization has an account, both
          because they power the dashboard and because incremental re-review
          uses the previous envelope as its baseline. Uninstalling the GitHub
          App revokes repository access and stops future processing. It does not
          delete review history. A verified organization administrator can
          request an export or deletion of organization data by emailing{" "}
          <a href="mailto:hello@postil.dev">hello@postil.dev</a>. Billing
          records required for accounting, tax, fraud prevention, or disputes
          are retained only for those purposes.
        </p>

        <h2>Bring-your-own API keys</h2>
        <p>
          Organization LLM keys are sealed with AES-256-GCM before they reach
          the database and are decrypted only inside the worker, at the moment a
          review starts. The settings form is write-only: a stored key can be
          replaced or removed, never displayed. Keys are never logged and are
          sent only in the provider authentication headers required by the
          configured API interface. An optional private-gateway credential is
          sent in the additional header configured by the organization.
        </p>

        <h2>Tokens and credentials</h2>
        <p>
          GitHub installation tokens are minted on demand, held in memory only,
          and expire within an hour. The GitHub App private key is provided via
          environment configuration and is never written to the database or to
          logs.
        </p>

        <h2>Subprocessors</h2>
        <ul>
          <li>
            <strong>GitHub</strong> (source forge and OAuth identity): webhooks,
            check-runs, review comments, sign-in.
          </li>
          <li>
            <strong>Model providers</strong> receive the diff for the duration
            of a model call. BYOK reviews route through the Postil worker to the
            provider configured by the organization. Hosted plans use
            Postil&apos;s configured provider path. CLI and self-hosted
            deployments send diffs directly to the endpoint you configure. For
            sensitive code we recommend BYOK pointed directly at your chosen
            provider, or self-hosting (below).
          </li>
          <li>
            <strong>Fly.io</strong> (application hosting): runs the web control
            plane, review worker, and private production monitor.
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
          <li>
            <strong>Paddle</strong> provides checkout, payment methods, tax,
            invoices, and a customer billing portal when self-service billing is
            available.
          </li>
          <li>
            <strong>Brevo</strong> delivers billing-contact verification,
            account, installation, billing, and service-monitor messages. Brevo
            receives the recipient address, sender, subject, HTML and plain-text
            body, the account or operational details shown in the message, and a
            provider idempotency identifier used to prevent duplicate delivery.
            Brevo records delivery events and can measure opens and link clicks.
            Its account-level{" "}
            <a href="https://help.brevo.com/hc/en-us/articles/11643306229906-Can-I-anonymize-the-tracking-of-opens-and-clicks-for-my-emails">
              anonymous tracking setting
            </a>{" "}
            keeps aggregate open and click counts without linking them to a
            contact. Brevo&apos;s{" "}
            <a href="https://help.brevo.com/hc/en-us/articles/360021533839-Manage-your-transactional-logs-and-email-previews">
              transactional log retention
            </a>{" "}
            is configured at the Brevo account level. Brevo retains logs and
            message previews indefinitely by default unless the account owner
            sets a shorter period. Brevo deletes events older than 24 months for
            accounts with more than 10 million events unless an
            extended-retention option applies. Review findings remain in GitHub
            and the authenticated Postil dashboard. Postil embeds no remote
            images, web fonts, or third-party content in these messages.
          </li>
        </ul>
        <p>
          Hosted Postil uses analytics for product and traffic measurement on
          public marketing, documentation, blog, install, pricing, and
          comparison pages. Browser analytics use PostHog&apos;s cookieless mode
          to record pageviews, pageleave engagement, scroll depth, Core Web
          Vitals, sanitized referrers, and campaign parameters. Postil relays
          these requests through its own domain, but PostHog remains the data
          processor. Analytics set no cookies and write no local or session
          storage; daily anonymous aggregation is not linked to an account or
          retained as a durable browser identity. PostHog forms that rotating
          daily identifier from the project, hostname, IP address, and user
          agent, then discards the raw IP address. DNT and Global Privacy
          Control disable browser and request analytics. Session replay, person
          profiles, surveys, heatmaps, and autocaptured clicks are disabled.
          Server-side request telemetry records sanitized path, referrer
          origin/public path, campaign parameters, user agent, and Cloudflare
          bot metadata when present; it does not send IP addresses, arbitrary
          query strings, or protected dashboard paths. Operational monitoring
          sends fixed event names and scrubbed exception stacks with
          project-relative code locations. It excludes request content, source
          code, repository names, prompts, model output, credentials, email
          addresses, and absolute file paths. Authentication sets one
          first-party session cookie after sign-in; analytics do not use it.
        </p>

        <h2>Where data is processed (residency)</h2>
        <p>
          For the hosted service, application hosting runs on Fly.io in the
          London region (<code>lhr</code>) and the managed database runs in a
          European region, so your account data and review envelopes are
          processed and stored in the UK/EU. PostHog analytics should use EU
          Cloud for the hosted service. Review inference is separate from that
          account-data boundary. BYOK diffs go to the provider and region the
          organization configures. Existing hosted plans use Postil&apos;s
          configured provider path. Neither route has a fixed UK/EU residency
          guarantee. A self-hosted deployment keeps all data on your own
          infrastructure, wherever you run it. We make no SOC 2 or ISO
          certification claim.
        </p>

        <h2>Self-hosted</h2>
        <p>
          Self-hosted deployments send nothing to us. No telemetry, no license
          pings, no update checks. Your envelopes stay in your Postgres.
        </p>

        <h2>Contact</h2>
        <p>
          Privacy and verified data requests: hello@postil.dev. Security
          reports: see <a href="/.well-known/security.txt">security.txt</a>.
        </p>
      </div>
    </div>
  );
}
