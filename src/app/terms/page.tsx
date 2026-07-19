import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms for the hosted Postil service: provided as-is, pricing on the public pricing page, and data export on request.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="prose-postil mx-auto">
        <p className="eyebrow">Terms of Service</p>
        <h1 className="serif-display mt-3 text-4xl text-charcoal">
          Terms of service.
        </h1>
        <p className="mt-4 text-sm text-charcoal/50">
          Terms for hosted Postil.
        </p>

        <div className="mt-6 rounded-card border border-gate bg-gate/5 p-5 text-[15px] text-ink-soft">
          <p>
            <strong>Hosted service terms.</strong> These terms cover the hosted
            GitHub App, dashboard, and worker. Pricing is documented on the
            public pricing page.
          </p>
        </div>

        <h2>What these terms cover</h2>
        <p>
          These terms govern your use of the hosted Postil service at
          postil.dev: the GitHub App, the web dashboard, and the worker that
          runs reviews on our infrastructure. They do not govern the Postil CLI
          or the self-hosted stack, which are distributed under the Apache-2.0
          license; your use of those is governed by that license, not by these
          terms.
        </p>

        <h2>Service provided as-is</h2>
        <p>
          The hosted service is provided on an &quot;as-is&quot; and
          &quot;as-available&quot; basis, without warranties of any kind, to the
          extent permitted by law. It may change, break, or be interrupted
          without notice. Review output is advisory and is not a substitute for
          human judgment; you remain responsible for what you merge.
        </p>

        <h2>No uptime SLA</h2>
        <p>
          There is no uptime or availability commitment. We do not guarantee
          that reviews will run, complete, or complete within any particular
          time. Do not rely on the hosted service as the sole gate on a
          production-critical workflow; the <code>postil/gate</code> check fails
          closed by default, so a service interruption surfaces as a failing
          gate rather than a silent pass. Repositories can opt into{" "}
          <code>gate.onError: advisory</code>, which fails open on provider
          outages only; the default remains fail-closed.
        </p>

        <h2 id="billing-and-fair-use">Billing and fair use</h2>
        <p>
          The organization is the customer. Private plans are billed monthly by
          active private-PR author at the rates on the{" "}
          <Link href="/pricing">pricing page</Link>. New GitHub owners receive
          one 30-day hosted trial without a card. An organization can use BYOK
          during the trial; that provider bills its model usage separately.
        </p>
        <p>
          An active author is a GitHub identity, including a bot or service
          identity, whose private-repository pull request Postil reviews during
          the billing month. An identity counts once per organization, with no
          repository charge. The same identity counts separately for unrelated
          organization customers.
        </p>
        <p>
          When self-service billing is available, Paddle processes payments,
          tax, invoices, payment-method changes, and cancellation. Postil does
          not receive card details. A paid BYOK subscription continues monthly
          until canceled. Each closed period is charged from the distinct
          active-author count recorded for that organization. Provider-confirmed
          past-due, paused, or canceled subscriptions can pause private-repository
          access after any stated grace period.
        </p>
        <p>
          Repository count and review count are not billing units.
          Public-repository App reviews are free when the organization supplies
          its model provider. Automated or coordinated activity intended to
          exhaust shared capacity, evade safeguards, or materially impair the
          service is not fair use and can be rate-limited or suspended.
          Sustained automated volume materially beyond ordinary interactive
          development may also be rate-limited to protect shared capacity.
        </p>
        <p>
          Prohibited activity includes reselling or proxying hosted inference,
          deliberately circumventing safeguards, and load testing without prior
          approval. Security or availability incidents may require immediate
          restriction. Questions or appeals can be sent to{" "}
          <a href="mailto:hello@postil.dev">hello@postil.dev</a>.
        </p>

        <h2>Your responsibilities</h2>
        <ul>
          <li>
            You must have the right to grant Postil access to the repositories
            you install it on, and to let the hosted service process diffs for
            reviews. If you configure a bring-your-own model provider, you must
            also have the right to send those diffs to that provider.
          </li>
          <li>
            You are responsible for API keys you configure and any charges your
            model provider bills against them. BYOK provider usage is billed by
            your provider outside Postil. Configure provider-side budgets and
            alerts, plus hard limits where the provider supports them, because
            Postil cannot enforce spending limits in an external provider
            account.
          </li>
          <li>
            Do not attempt to disrupt, reverse-engineer the hosted control
            plane, probe it for vulnerabilities outside our{" "}
            <Link href="/security">coordinated disclosure</Link> process, or use
            the service to violate the law or a third party&apos;s rights.
          </li>
        </ul>

        <h2>Data and export</h2>
        <p>
          What the service stores and what it never stores is described in the{" "}
          <Link href="/privacy">privacy policy</Link>: full diffs, repository
          snapshots, and clones are not persisted; review, operational, account,
          installation, usage, and billing records are, and review output can
          contain relevant code excerpts. A verified organization administrator
          can request an export or deletion by emailing{" "}
          <a href="mailto:hello@postil.dev">hello@postil.dev</a>. Uninstalling
          the GitHub App revokes repository access and stops future processing,
          but does not delete review history.
        </p>

        <h2>Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, Postil is not liable for any
          indirect, incidental, or consequential damages arising from your use
          of the service, including any merge decision made with or without a
          Postil review. Our aggregate liability is limited to the amounts paid
          for the hosted service in the 12 months before the claim, or USD $100
          if no amounts were paid.
        </p>

        <h2>Suspension and changes</h2>
        <p>
          We may suspend or discontinue the service, in whole or in part, at any
          time. We may update these terms; material changes will be reflected on
          this page, and continued use after a change means you accept the
          updated terms.
        </p>

        <h2>Governing law</h2>
        <p>
          These terms are governed by the laws of Iceland, without regard to
          conflict-of-law rules. Any dispute arising from them is subject to the
          exclusive jurisdiction of the District Court of Reykjavík (Héraðsdómur
          Reykjavíkur).
        </p>

        <h2>Contact</h2>
        <p>
          Questions about these terms:{" "}
          <a href="mailto:hello@postil.dev">hello@postil.dev</a>. Security
          reports: see <a href="/.well-known/security.txt">security.txt</a>.
        </p>
      </div>
    </div>
  );
}
