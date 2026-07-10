import type { Metadata } from "next";
import Link from "next/link";

import { Section } from "@/components/section";
import { StatusIcon } from "@/components/status-icon";

export const metadata: Metadata = {
  title: "Security",
  description:
    "Postil's security posture: least-privilege GitHub permissions, fail-closed gate semantics, AES-256-GCM key sealing, short-lived tokens, and coordinated disclosure.",
  alternates: { canonical: "/security" },
  openGraph: {
    title: "Postil security",
    description:
      "Least-privilege permissions, fail-closed by design, AES-256-GCM key sealing, short-lived tokens, coordinated disclosure.",
    url: "https://postil.dev/security",
    images: ["/opengraph-image"],
  },
};

const PERMISSIONS = [
  { scope: "contents", level: "read", note: "Fetch the PR diff at review time." },
  {
    scope: "pull_requests",
    level: "write",
    note: "Post inline review comments in one batched review.",
  },
  {
    scope: "checks",
    level: "write",
    note: "Create and complete postil/gate and postil/review.",
  },
  { scope: "metadata", level: "read", note: "Resolve repository identity." },
] as const;

export default function SecurityPage() {
  return (
    <div>
      <div className="mx-auto max-w-6xl px-6 pt-16 md:pt-20">
        <p className="eyebrow">Security</p>
        <h1 className="serif-display mt-4 max-w-3xl text-4xl md:text-5xl">
          A reviewer should not be able to compromise the repo it reviews.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-ink-soft">
          Postil&apos;s design assumes the review pipeline is a high-value target.
          The principles below are enforced in code: the App cannot push
          code because it never holds write-to-code credentials, and the gate
          cannot silently pass because failure is the default.
        </p>
      </div>

      <Section
        number="01"
        eyebrow="Least privilege"
        title="Minimal permissions: read your code, write your checks."
      >
        <div className="grid gap-8 md:grid-cols-2">
          <div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-charcoal text-left">
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Permission
                  </th>
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Level
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Why
                  </th>
                </tr>
              </thead>
              <tbody className="text-ink-soft">
                {PERMISSIONS.map((p) => (
                  <tr key={p.scope} className="border-b border-stone">
                    <td className="py-2 pr-4 font-mono text-xs">{p.scope}</td>
                    <td className="py-2 pr-4">{p.level}</td>
                    <td className="py-2">{p.note}</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-2 pr-4 font-mono text-xs">contents: write</td>
                  <td className="py-2 pr-4 font-semibold text-rust">
                    never requested
                  </td>
                  <td className="py-2">A reviewer does not push code.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="text-ink-soft">
            <p>
              In a{" "}
              <a
                href="https://research.kudelskisecurity.com/2025/08/19/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories/"
                className="text-rust underline"
                rel="noopener"
              >
                publicly reported August 2025 disclosure
              </a>
              , security researchers described a remote-code-execution chain in
              a leading reviewer&apos;s pipeline that exposed installation
              credentials carrying <em>write</em> access across a large share of
              customer repositories.
            </p>
            <p className="mt-4">
              The mitigation is architectural: hold the smallest credential set
              that does the job. Even a full compromise
              of a Postil installation token cannot push a commit, open a PR, or
              alter a workflow, because the App never holds that authority.
            </p>
          </div>
        </div>
      </Section>

      <Section
        number="02"
        eyebrow="Fail closed"
        title="The gate never marks an unreviewed head as passing."
      >
        <div className="grid gap-8 md:grid-cols-2">
          <div className="space-y-4 text-ink-soft">
            <p>
              When the model returns invalid or ungrounded output, Postil retries
              one JSON repair, then emits a synthetic{" "}
              <code className="font-mono text-sm">error</code> finding and fails
              the gate. When the worker crashes or a review exceeds its
              ten-minute deadline, a watchdog completes{" "}
              <code className="font-mono text-sm">postil/gate</code> as{" "}
              <strong>failure</strong>, never neutral.
            </p>
            <p>
              The worker owns the check-run ids from the moment the job starts,
              so there is no window in which a crashed review leaves a check
              hanging <code className="font-mono text-sm">in_progress</code> and
              merge-eligible.
            </p>
            <p>
              Repositories can opt into{" "}
              <code className="font-mono text-sm">gate.onError: advisory</code>,
              which fails open on provider outages only; the default remains
              fail-closed.
            </p>
          </div>
          <div className="card p-6">
            <p className="eyebrow">Failure semantics</p>
            <ul className="mt-4 space-y-3 text-sm">
              <li className="flex items-center gap-3">
                <StatusIcon kind="error" />
                <span>
                  <code className="font-mono">postil/gate</code> on operational
                  error: <strong>failure</strong>
                </span>
              </li>
              <li className="flex items-center gap-3">
                <StatusIcon kind="info" />
                <span>
                  <code className="font-mono">postil/review</code> on operational
                  error: neutral, with the error summary
                </span>
              </li>
              <li className="flex items-center gap-3">
                <StatusIcon kind="pass" />
                <span>Clean PR: both green, zero comments</span>
              </li>
            </ul>
          </div>
        </div>
      </Section>

      <Section
        number="03"
        eyebrow="Secrets"
        title="Keys are sealed at rest and write-only in the UI."
      >
        <div className="grid gap-8 md:grid-cols-2">
          <div className="space-y-4 text-ink-soft">
            <p>
              Bring-your-own inference keys are sealed with{" "}
              <strong>AES-256-GCM</strong> before they touch the database and are
              decrypted only inside the worker, at the moment a review starts. The
              settings form is write-only: a stored key can be replaced or
              removed, never read back out. Keys are never logged and never leave
              the worker except as the Authorization header to the endpoint you
              configured.
            </p>
            <p>
              GitHub installation tokens are minted on demand from the App key,
              held in memory only, and expire within an hour. The App private key
              is provided via environment configuration and is never written to
              the database or to logs.
            </p>
          </div>
          <div className="card p-6">
            <p className="eyebrow">Credential lifetimes</p>
            <dl className="mt-4 space-y-3 text-sm text-ink-soft">
              <div className="flex justify-between gap-4">
                <dt>BYOK inference</dt>
                <dd className="text-right font-mono text-xs">
                  AES-256-GCM at rest, write-only
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>GitHub installation token</dt>
                <dd className="text-right font-mono text-xs">
                  in-memory, ≤ 1 hour
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>GitHub App private key</dt>
                <dd className="text-right font-mono text-xs">
                  env only, never persisted
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Session cookie</dt>
                <dd className="text-right font-mono text-xs">
                  set only after sign-in
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Source code</dt>
                <dd className="text-right font-mono text-xs">never persisted</dd>
              </div>
            </dl>
          </div>
        </div>
      </Section>

      <Section
        number="04"
        eyebrow="Data handling"
        title="Only the review envelope persists."
      >
        <div className="max-w-2xl text-ink-soft">
          <p>
            The control plane persists one artifact per review: the envelope, a
            JSON document with the summary, findings, token usage, and gate
            verdict. The diff is fetched at review time, sent to the applicable
            model endpoint, and discarded with the process. Hosted BYOK reviews
            route through the worker to your configured provider, hosted default
            reviews use Postil&apos;s configured provider path, and self-hosted
            deployments send nothing to us: no telemetry, no license pings, no
            update checks. There is no code cache, embedding index, or
            repository clone on our infrastructure.
          </p>
          <p className="mt-4">
            Full detail in the{" "}
            <Link href="/privacy" className="text-rust underline">
              privacy policy
            </Link>{" "}
            and the{" "}
            <Link href="/docs/envelope" className="text-rust underline">
              envelope schema
            </Link>
            .
          </p>
        </div>
      </Section>

      <Section
        number="05"
        eyebrow="Disclosure"
        title="Report a vulnerability."
      >
        <div className="grid gap-8 md:grid-cols-2">
          <div className="text-ink-soft">
            <p>
              We operate coordinated disclosure. Report suspected vulnerabilities
              privately through GitHub Security Advisories; do not open a public
              issue or PR for a security report. We aim to acknowledge a report
              within <strong>5 business days</strong>, keep you updated through
              remediation, and credit reporters who want it.
            </p>
            <p className="mt-4">
              Researchers who report valid issues are listed, with their
              permission, in our{" "}
              <a
                href="https://github.com/postil-dev/postil/security/advisories"
                className="text-rust underline"
                rel="noopener"
              >
                security acknowledgments
              </a>
              . Machine-readable contact is published at{" "}
              <a href="/.well-known/security.txt" className="text-rust underline">
                /.well-known/security.txt
              </a>
              .
            </p>
          </div>
          <div className="card p-6">
            <p className="eyebrow">Where to report</p>
            <ul className="mt-4 space-y-3 text-sm">
              <li>
                <a
                  href="https://github.com/postil-dev/postil/security/advisories/new"
                  className="link-arrow"
                  rel="noopener"
                >
                  Open a private security advisory
                </a>
              </li>
              <li>
                <a href="/.well-known/security.txt" className="link-arrow">
                  security.txt
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/postil-dev/postil/security/policy"
                  className="link-arrow"
                  rel="noopener"
                >
                  Security policy
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/postil-dev/postil/security/advisories"
                  className="link-arrow"
                  rel="noopener"
                >
                  Acknowledgments
                </a>
              </li>
            </ul>
            <p className="mt-4 text-sm text-charcoal/70">
              Target: report acknowledged within 5 business days.
            </p>
          </div>
        </div>
      </Section>

      <Section
        number="06"
        eyebrow="Distribution integrity"
        title="What the install checksum does and does not guarantee."
      >
        <div className="max-w-2xl text-ink-soft">
          <p>
            The one-line installer downloads the prebuilt binary over HTTPS and
            verifies it against a SHA-256 checksum fetched over HTTPS from the
            same GitHub release. The checksum alone protects against a corrupted
            or in-transit-tampered download, not against a compromised release.
            Release artifacts are additionally signed with Sigstore keyless
            signing (cosign) via GitHub OIDC in release CI.
          </p>
          <p className="mt-4">
            Keyless signing means there is no long-lived published key to manage
            or leak: the signature is bound to the certificate identity of the
            release workflow. When <code className="font-mono text-sm">cosign</code>{" "}
            is installed, the installer verifies the signature automatically;
            without it, verification falls back to the checksum. You can also
            build from source with{" "}
            <code className="font-mono text-sm">
              cargo install --git https://github.com/postil-dev/postil-cli --locked
            </code>
            , or cross-check the published SHA-256 on the{" "}
            <a
              href="https://github.com/postil-dev/postil-cli/releases"
              className="text-rust underline"
              rel="noopener"
            >
              releases page
            </a>
            .
          </p>
          <p className="mt-4">
            We do not publish a separate GPG release key today. That is
            intentional: Sigstore keyless signing keeps release identity tied to
            GitHub OIDC and avoids a static private key that would need storage,
            rotation, revocation, and out-of-band trust distribution.
          </p>
        </div>
      </Section>
    </div>
  );
}
