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
    images: ["/opengraph-image"],
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
    version: "0.8.13-0.8.16",
    date: "August 13, 2026",
    summary:
      "Review findings are adjudicated against candidate-bound direct evidence and a complete repository receipt before publication, while large changes remain bounded without silently skipping required source.",
    changes: [
      {
        label: "Fixed",
        text: "Repetitive source is encoded losslessly within the review budget, reconstructed only for exact citations, and cannot impersonate the evidence transport format.",
      },
      {
        label: "Changed",
        text: "Absence, removal, conditional, and delegated-verification claims use the same complete-corpus adjudication regardless of generated kind; refuted and unresolved delegated checks are not published.",
      },
      {
        label: "Fixed",
        text: "Repository-wide claims are bound to immutable search receipts, and time-sensitive claims use the trusted UTC request date instead of model memory.",
      },
      {
        label: "Fixed",
        text: "Inline code in GitHub review findings preserves comparison operators while surrounding prose remains HTML-safe.",
      },
    ],
  },
  {
    version: "0.8.9–0.8.12",
    date: "August 12, 2026",
    summary:
      "Large pull-request descriptions no longer consume review context that is never sent to the model, and bounded retries retain their complete evidence.",
    changes: [
      {
        label: "Fixed",
        text: "Long pull-request descriptions are budgeted from the bounded text rendered into the review request, so dependency updates with extensive release notes reach review instead of failing before model contact.",
      },
      {
        label: "Fixed",
        text: "Retry and correction requests preserve their route, phase, evidence coordinates, and bounded prior response, including quoted Git paths and Unicode source text.",
      },
      {
        label: "Fixed",
        text: "Provider-contract and timeout-fallback tests use isolated process state and structured attempt records, keeping release checks deterministic under parallel and slower runners.",
      },
    ],
  },
  {
    version: "0.8.7–0.8.8",
    date: "August 9, 2026",
    summary:
      "Ignored paths do not consume bounded-review coverage, and uncertainty resolution can continue from exact diff evidence when repository lookup is unavailable.",
    changes: [
      {
        label: "Changed",
        text: "Files matched by ignore rules are excluded before grounding, batching, and coverage planning. Generated-looking source remains reviewable unless a repository explicitly ignores it.",
      },
      {
        label: "Fixed",
        text: "When repository file lookup fails, uncertainty resolution uses exact evidence already present in the reviewed diff. Any uncertainty that remains unresolved is reported as a warning rather than an operational failure.",
      },
    ],
  },
  {
    version: "0.8.5–0.8.6",
    date: "July 30, 2026",
    summary:
      "A finding's citation is checked against the code its prose names, and the CLI can review without your own model credential.",
    changes: [
      {
        label: "Fixed",
        text: "A finding whose prose names a construct the diff places on a different line is no longer published. Citing the wrong line makes a claim the reader cannot check against the code in front of them.",
      },
      {
        label: "Fixed",
        text: "A content-policy claim can no longer state more confidence than the finding it argues from, and is withdrawn when that finding was itself withdrawn as mis-anchored.",
      },
      {
        label: "Changed",
        text: "One observation about several files is published once, naming every location it affects, instead of once per file.",
      },
      {
        label: "Changed",
        text: "An uncertainty finding whose body only asks you to confirm something no longer carries a blocking severity. Findings that report what the review checked are unaffected.",
      },
      {
        label: "Fixed",
        text: "A second review of an unchanged commit no longer repeats inline comments the previous review already left on the pull request.",
      },
      {
        label: "Added",
        text: "postil login authorizes the CLI against Postil through a browser, so reviews run without your own model provider credential.",
      },
    ],
  },
  {
    version: "0.8.1–0.8.4",
    date: "July 24–28, 2026",
    summary:
      "Reviews can resolve uncertainty against repository files and publish each GitHub finding on one configured surface.",
    changes: [
      {
        label: "Added",
        text: "review.findingPresentation selects batched review comments by default or advisory check annotations on GitHub, so the same finding is not rendered twice.",
      },
      {
        label: "Fixed",
        text: "A review that cannot produce a verdict fails postil/review instead of appearing skipped; postil/gate still follows the configured outage policy.",
      },
      {
        label: "Changed",
        text: "Finding bodies over six hundred bytes are rewritten to state the defect, evidence, and fix in at most three sentences; reviews.conciseFindings: false opts out.",
      },
      {
        label: "Changed",
        text: "Builtin content-policy rules for stale text and house style state functional tests with illustrative examples, so the policy stays accurate as model vocabularies shift, and repo-appended rules can scope themselves to specific paths.",
      },
      {
        label: "Added",
        text: "A bounded post-scoring pass fetches the repository files an uncertainty finding names and resolves it with byte-verbatim evidence instead of asking the developer to inspect them; reviews.uncertaintyResolution: false opts out.",
      },
    ],
  },
  {
    version: "0.7.0–0.7.9",
    date: "July 19–21, 2026",
    summary:
      "Self-service trials and bounded hosted reviews use release-scoped activation checks and durable retry accounting.",
    changes: [
      {
        label: "Added",
        text: "New installations receive a 30-day private-repository trial without a payment card.",
      },
      {
        label: "Changed",
        text: "Hosted activation checks the pinned model and provider route, token usage, and provider cost accounting.",
      },
      {
        label: "Fixed",
        text: "Failed hosted reviews reconcile reserved provider spend after model execution begins.",
      },
      {
        label: "Fixed",
        text: "Hosted runs report an operational failure unless GitHub receives their terminal review checks.",
      },
      {
        label: "Fixed",
        text: "Bounded reviews recover incomplete model output and validate every selected source batch before returning results.",
      },
      {
        label: "Fixed",
        text: "Prior findings remain active until a current review rechecks their evidence across bounded batches and renamed files.",
      },
      {
        label: "Fixed",
        text: "Reasoning-heavy synthesis retries once with a larger bounded output budget and stops when that retry is exhausted.",
      },
      {
        label: "Security",
        text: "Hosted large-review retries bind provider calls and billing to an authenticated durable plan and immutable retry identity.",
      },
    ],
  },
  {
    version: "0.6.0–0.6.3",
    date: "July 13–14, 2026",
    summary:
      "Review delivery has time and output bounds, hosted reviews handle large changes in bounded batches, and GitHub reviews fetch every changed-file page.",
    changes: [
      {
        label: "Changed",
        text: "Hosted reviews process large changes in bounded batches; local reviews can opt in with postil review --bounded.",
      },
      {
        label: "Fixed",
        text: "GitHub reviews fetch every changed-file page and recover when a model spends its response on reasoning without returning review content.",
      },
      {
        label: "Fixed",
        text: "Provider recovery and review publication have explicit limits, so a completed review cannot turn into an unbounded retry or oversized comment.",
      },
    ],
  },
  {
    version: "0.5.0",
    date: "July 13, 2026",
    summary:
      "Bring-your-own-key setups can call Anthropic-compatible APIs directly.",
    changes: [
      {
        label: "Added",
        text: "Native Anthropic request and authentication support alongside the OpenAI-compatible API format.",
      },
    ],
  },
  {
    version: "0.4.1–0.4.6",
    date: "July 11–12, 2026",
    summary:
      "Scoring, model fallback, and blocking rules became configurable and time-bounded.",
    changes: [
      {
        label: "Added",
        text: "An independent scorer records its assessment separately from the review model, and gate policy can block selected finding kinds.",
      },
      {
        label: "Changed",
        text: "Model cascades live in configuration and report progress while a review is running.",
      },
      {
        label: "Fixed",
        text: "Timeouts retry before advancing the cascade; gate replay, GitHub links, and review-comment formatting stay consistent.",
      },
    ],
  },
  {
    version: "0.2.0–0.2.1",
    date: "July 10, 2026",
    summary:
      "Content-policy checks, accurate run states, and reliable re-runs became defaults.",
    changes: [
      {
        label: "Changed",
        text: "Content-policy review is enabled by default, with plain gate output and truthful queued, running, completed, and failed states.",
      },
      {
        label: "Fixed",
        text: "Re-runs can resolve carried findings, annotations use the changed side of the diff, and transient forge failures retain the completed review.",
      },
      {
        label: "Changed",
        text: "Parallel source fetches and bounded model output reduce review latency without shortening the review prompt.",
      },
    ],
  },
  {
    version: "0.1.1–0.1.2",
    date: "June 13–July 2, 2026",
    summary:
      "Multi-forge replies, benchmark coverage, content-policy checks, and security hardening extend the first CLI releases.",
    changes: [
      {
        label: "Added",
        text: "Interactive replies work across GitHub, GitLab, Bitbucket, and Azure DevOps, with end-to-end coverage for each forge.",
      },
      {
        label: "Added",
        text: "The benchmark harness runs in CI and supports bounded live-model comparisons with detection, severity, concurrency, and retry measurements.",
      },
      {
        label: "Security",
        text: "Cargo audit runs in CI, known dependency advisories are closed, model output is stripped of terminal control sequences, and diff plus check-run output is capped.",
      },
      {
        label: "Fixed",
        text: "Ambiguous incremental baselines fail closed, disabled review stays disabled, and PR-description findings must cite the relevant text.",
      },
    ],
  },
  {
    version: "0.1.0",
    date: "June 13, 2026",
    summary:
      "First tagged release of the CLI and the gate contract. Signed multi-arch binaries are published on GitHub releases; you can also install via the one-line script, build from source, or pin the GitHub Action to a commit SHA.",
    changes: [
      {
        label: "Added",
        text: (
          <>
            <code className="font-mono text-xs">postil review</code> with{" "}
            <code className="font-mono text-xs">--staged</code>,{" "}
            <code className="font-mono text-xs">--base</code>, and{" "}
            <code className="font-mono text-xs">--diff-file</code> inputs, plus
            JSON envelope output via{" "}
            <code className="font-mono text-xs">--output-json</code> and SARIF
            2.1.0 output via <code className="font-mono text-xs">--sarif</code>.
          </>
        ),
      },
      {
        label: "Added",
        text: (
          <>
            Two named check-runs on every non-draft PR in enabled repositories:{" "}
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
            Forge support beyond GitHub via{" "}
            <code className="font-mono text-xs">--forge gitlab</code>,{" "}
            <code className="font-mono text-xs">bitbucket</code>, and{" "}
            <code className="font-mono text-xs">azure</code>, each covering its
            self-managed/server variant through a base-URL environment variable
            (<code className="font-mono text-xs">GITLAB_API_URL</code> and
            friends). Bitbucket and Azure DevOps are best effort: shipped,
            tested, and refined as platform-specific edge cases surface.
          </>
        ),
      },
      {
        label: "Added",
        text: (
          <>
            Incremental re-review (
            <code className="font-mono text-xs">--since-sha</code> +{" "}
            <code className="font-mono text-xs">--baseline</code>) with
            resolved/carried finding reconciliation.
          </>
        ),
      },
      {
        label: "Added",
        text: (
          <>
            <code className="font-mono text-xs">postil respond</code>: the
            interactive <code className="font-mono text-xs">@postil</code> bot
            engine for PR and issue mentions. The CLI command covers GitHub,
            GitLab, Bitbucket, and Azure DevOps via{" "}
            <code className="font-mono text-xs">--forge</code>; the hosted
            GitHub App is GitHub only. Review-and-answer only, never opens
            PRs.
          </>
        ),
      },
      {
        label: "Added",
        text: (
          <>
            <code className="font-mono text-xs">postil doctor</code> preflight,{" "}
            <code className="font-mono text-xs">postil plan</code> dry-run
            against stored envelopes, and{" "}
            <code className="font-mono text-xs">postil hook install</code> for a
            pre-push review hook.
          </>
        ),
      },
      {
        label: "Added",
        text: (
          <>
            Repo guardrails: rules in{" "}
            <code className="font-mono text-xs">.postil/guardrails.md</code> are
            injected into the prompt; violations surface as{" "}
            <code className="font-mono text-xs">guardrail</code> findings that
            quote the rule.
          </>
        ),
      },
      {
        label: "Added",
        text: "One-line install script with SHA-256 checksum verification and Sigstore keyless signature verification when cosign is present; build from source with cargo install --git.",
      },
      {
        label: "Security",
        text: "Least-privilege GitHub App (no contents:write), fail-closed gate on operational errors (repos can opt into gate.onError: advisory), AES-256-GCM sealing for bring-your-own inference keys, Sigstore keyless signing of release artifacts in CI.",
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
              <span className="font-mono text-sm text-charcoal/70">
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

      <p className="mt-14 font-mono text-xs text-charcoal/70">
        Signed binaries and source archives are published on{" "}
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
