import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Changelog",
  description:
    "What's new in Postil: releases, gate and CLI changes, and platform support.",
  alternates: { canonical: "/changelog" },
  openGraph: {
    title: "Postil changelog",
    description: "Releases, gate and CLI changes, and platform support.",
    url: "https://postil.dev/changelog",
  },
};

interface Change {
  label: "Added" | "Changed" | "Fixed" | "Security";
  text: React.ReactNode;
}

interface Release {
  version: string;
  date: string;
  summary: string;
  changes: Change[];
}

const LABEL_STYLE: Record<Change["label"], string> = {
  Added: "text-gate",
  Changed: "text-charcoal/70",
  Fixed: "text-charcoal/70",
  Security: "text-rust",
};

const RELEASES: Release[] = [
  {
    version: "1.0.0",
    date: "June 2026",
    summary:
      "First stable release of the CLI and the gate contract. The envelope schema, exit codes, and check-run semantics are now considered stable.",
    changes: [
      {
        label: "Added",
        text: (
          <>
            Stable <code className="font-mono text-xs">postil review</code> with{" "}
            <code className="font-mono text-xs">--staged</code>,{" "}
            <code className="font-mono text-xs">--base</code>, and{" "}
            <code className="font-mono text-xs">--diff</code> inputs, plus
            JSON envelope output via{" "}
            <code className="font-mono text-xs">--output-json</code>.
          </>
        ),
      },
      {
        label: "Added",
        text: (
          <>
            Two named check-runs on every PR:{" "}
            <code className="font-mono text-xs">postil/gate</code> (blocking) and{" "}
            <code className="font-mono text-xs">postil/review</code> (advisory),
            with documented{" "}
            <Link href="/docs/gate" className="text-rust underline">
              branch-protection setup
            </Link>
            .
          </>
        ),
      },
      {
        label: "Added",
        text: (
          <>
            GitLab support via{" "}
            <code className="font-mono text-xs">--forge gitlab</code>, including
            self-managed instances through{" "}
            <code className="font-mono text-xs">--forge-url</code>.
          </>
        ),
      },
      {
        label: "Added",
        text: (
          <>
            <code className="font-mono text-xs">postil doctor</code> preflight and{" "}
            <code className="font-mono text-xs">postil plan</code> dry-run against
            stored envelopes.
          </>
        ),
      },
      {
        label: "Added",
        text: "Verified one-line install script with published SHA-256 checksums; cargo install and cargo binstall support.",
      },
      {
        label: "Security",
        text: "Least-privilege GitHub App (no contents:write), fail-closed gate on operational errors, AES-256-GCM sealing for bring-your-own inference keys.",
      },
    ],
  },
];

export default function ChangelogPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <p className="eyebrow">Changelog</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">What&apos;s new.</h1>
      <p className="mt-6 text-lg text-ink-soft">
        Notable changes to the CLI, the gate contract, and platform support.
        Stable surfaces follow semantic versioning.
      </p>

      <div className="mt-14 space-y-14">
        {RELEASES.map((release) => (
          <article key={release.version} className="rule pt-8">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h2 className="serif-display text-3xl">v{release.version}</h2>
              <span className="font-mono text-sm text-charcoal/60">
                {release.date}
              </span>
            </div>
            <p className="mt-3 max-w-2xl text-ink-soft">{release.summary}</p>
            <ul className="mt-6 space-y-3 text-[15px]">
              {release.changes.map((c, i) => (
                <li key={i} className="flex gap-3">
                  <span
                    className={`w-20 shrink-0 font-mono text-xs uppercase tracking-wider ${LABEL_STYLE[c.label]}`}
                  >
                    {c.label}
                  </span>
                  <span className="text-ink-soft">{c.text}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <p className="mt-14 font-mono text-xs text-charcoal/60">
        Full release notes and binaries on{" "}
        <a
          href="https://github.com/postil-dev/postil-cli/releases"
          className="text-rust underline"
          rel="noopener"
        >
          GitHub releases
        </a>
        .
      </p>
    </div>
  );
}
