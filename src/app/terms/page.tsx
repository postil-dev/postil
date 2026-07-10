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
        <p className="mt-4 text-sm text-charcoal/50">Terms for hosted Postil.</p>

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
          production-critical workflow; the{" "}
          <code>postil/gate</code> check fails closed by default, so a service
          interruption surfaces as a failing gate rather than a silent pass.
          Repositories can opt into <code>gate.onError: advisory</code>, which
          fails open on provider outages only; the default remains fail-closed.
        </p>

        <h2>Billing and pricing</h2>
        <p>
          Hosted Team pricing is documented on the{" "}
          <Link href="/pricing">pricing page</Link>. Public repositories, the
          CLI, and the self-hosted stack remain free. Contact us for annual
          billing, invoicing, or procurement requirements.
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
            model provider bills against them. Hosted Team remains flat; BYOK
            provider usage is billed by your provider outside Postil.
          </li>
          <li>
            Do not attempt to disrupt, reverse-engineer the hosted control plane,
            probe it for vulnerabilities outside our{" "}
            <Link href="/security">coordinated disclosure</Link> process, or use
            the service to violate the law or a third party&apos;s rights.
          </li>
        </ul>

        <h2>Data and export</h2>
        <p>
          What the service stores and what it never stores is described in the{" "}
          <Link href="/privacy">privacy policy</Link>: source code is never
          persisted; review envelopes and account metadata are. You can request
          an export of your organization&apos;s stored data, and you can delete
          it by deleting your organization or uninstalling the GitHub App. For an
          export, email{" "}
          <a href="mailto:hello@postil.dev">hello@postil.dev</a>.
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
          exclusive jurisdiction of the District Court of Reykjavík
          (Héraðsdómur Reykjavíkur).
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
