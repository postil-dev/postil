import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service (beta)",
  description:
    "The beta terms for the hosted Postil service: provided as-is, no uptime SLA during beta, advance notice before any billing, and data export on request.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="prose-postil mx-auto">
        <p className="eyebrow">Terms of Service</p>
        <h1 className="serif-display mt-3 text-4xl text-charcoal">
          Beta terms of service.
        </h1>
        <p className="mt-4 text-sm text-charcoal/50">Last updated June 2026.</p>

        <div className="mt-6 rounded-card border border-gate bg-gate/5 p-5 text-[15px] text-ink-soft">
          <p>
            <strong>These are beta terms.</strong> The hosted Postil service is
            in beta and free to use during the beta. These terms cover that beta
            period. They will be replaced by general terms before the service
            leaves beta, and we will tell you before that happens.
          </p>
        </div>

        <h2>What these terms cover</h2>
        <p>
          These terms govern your use of the hosted Postil service at
          postil.dev — the GitHub App, the web dashboard, and the worker that
          runs reviews on our infrastructure. They do not govern the Postil CLI
          or the self-hosted stack, which are distributed under the Apache-2.0
          license; your use of those is governed by that license, not by these
          terms.
        </p>

        <h2>Beta service, provided as-is</h2>
        <p>
          The hosted service is provided on an &quot;as-is&quot; and
          &quot;as-available&quot; basis, without warranties of any kind, to the
          extent permitted by law. During the beta it may change, break, or be
          interrupted without notice. Review output is advisory and is not a
          substitute for human judgment; you remain responsible for what you
          merge.
        </p>

        <h2>No uptime SLA during beta</h2>
        <p>
          There is no uptime or availability commitment during the beta. We do
          not guarantee that reviews will run, complete, or complete within any
          particular time. Do not rely on the hosted service as the sole gate on
          a production-critical workflow during the beta; the{" "}
          <code>postil/gate</code> check fails closed by default, so a service
          interruption surfaces as a failing gate rather than a silent pass.
          Repositories can opt into <code>gate.onError: advisory</code>, which
          fails open on provider outages only; the default remains fail-closed.
        </p>

        <h2>Billing and pricing</h2>
        <p>
          The hosted service is free during the beta and no payment is collected.
          If we introduce billing, we will give you at least{" "}
          <strong>30 days&apos; notice</strong> before any charge applies, and
          you may stop using the service before billing begins at no cost. The
          intended post-beta price is documented on the{" "}
          <Link href="/pricing">pricing page</Link>; the CLI and self-hosted
          stack remain free.
        </p>

        <h2>Your responsibilities</h2>
        <ul>
          <li>
            You must have the right to grant Postil access to the repositories
            you install it on, and to send their diffs to the model provider you
            configure.
          </li>
          <li>
            You are responsible for the API keys you configure and any charges
            your model provider bills against them. Inference runs on your own
            key at your provider&apos;s rates.
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
          of the beta service, including any merge decision made with or without
          a Postil review. Because the beta is provided free of charge, our
          aggregate liability is limited accordingly.
        </p>

        <h2>Suspension and changes</h2>
        <p>
          We may suspend or discontinue the beta service, in whole or in part, at
          any time. We may update these beta terms; material changes will be
          noted by updating the date above, and continued use after a change
          means you accept the updated terms.
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
