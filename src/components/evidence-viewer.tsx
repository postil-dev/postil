"use client";

import { useEffect, useMemo, useState } from "react";

import type { EvidenceCase, EvidenceFinding } from "@/data/evidence";

/** Minimal inline-markdown: **bold** and `code`. Input is trusted (our own envelopes). */
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return <strong key={i}>{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith("`") && p.endsWith("`")) {
      return (
        <code key={i} className="ev-code">
          {p.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

function FindingBody({ body }: { body: string }) {
  return (
    <>
      {body.split(/\n\n+/).map((para, i) => (
        <p key={i} className="ev-finding-para">
          {renderInline(para)}
        </p>
      ))}
    </>
  );
}

function checkSummaryMessages(summary: string): string[] {
  return summary
    .split(/\n\n+/)
    .map((part) => part.replace(/<img\b[^>]*>\s*/g, "").trim())
    .filter(
      (part) => part && !part.startsWith("- ") && !part.startsWith("Model:"),
    );
}

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="ev-diff" aria-label="reviewed diff" tabIndex={0}>
      <code>
        {diff.split("\n").map((line, i) => {
          let cls = "ev-line";
          if (
            line.startsWith("+++") ||
            line.startsWith("---") ||
            line.startsWith("diff ")
          )
            cls = "ev-line ev-meta";
          else if (line.startsWith("@@")) cls = "ev-line ev-hunk";
          else if (line.startsWith("+")) cls = "ev-line ev-add";
          else if (line.startsWith("-")) cls = "ev-line ev-del";
          return (
            <span key={i} className={cls}>
              {line || " "}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

const SEV_LABEL: Record<EvidenceFinding["severity"], string> = {
  error: "error",
  warn: "warning",
  info: "info",
};

function Finding({ f }: { f: EvidenceFinding }) {
  return (
    <div className={`ev-finding ev-sev-${f.severity}`}>
      <div className="ev-finding-head">
        <span
          className="ev-badge"
          aria-label={`severity: ${SEV_LABEL[f.severity]}`}
        >
          {f.severity}
        </span>
        <span className="ev-loc">
          {f.path}:{f.line}
        </span>
        {f.confidence !== undefined ? (
          <span className="ev-conf">
            {Math.round(f.confidence * 100)}% confidence
          </span>
        ) : null}
      </div>
      <h3 className="ev-finding-title">{f.title}</h3>
      <FindingBody body={f.body} />
    </div>
  );
}

/**
 * Entrance animation wrapper. Pure CSS (motion-safe keyframes), so content is
 * always visible without JavaScript and ends visible even if a paint races
 * scroll position. Never gates visibility on an IntersectionObserver.
 */
function Reveal({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  return (
    <div
      className="ev-reveal"
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

interface BreadcrumbLinks {
  repo: string;
  prFilesAtCommit: string;
  reviewComment?: string;
}

/**
 * Extract repo and PR number from a GitHub pull request URL.
 */
function parseGitHubPullRequestUrl(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid GitHub pull request URL`);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    parts.length !== 4 ||
    parts[2] !== "pull" ||
    !/^\d+$/.test(parts[3]!)
  ) {
    throw new Error(`${label} must be a GitHub pull request URL`);
  }

  return {
    owner: parts[0]!,
    repo: parts[1]!,
    prNumber: parts[3]!,
  };
}

/**
 * Construct breadcrumb links to the repository, PR files at the specific commit,
 * and the visible review comment when the evidence includes one.
 */
export function extractBreadcrumbs(
  sourceUrl: string,
  commitSha: string,
  reviewUrl?: string,
): BreadcrumbLinks {
  const source = parseGitHubPullRequestUrl(sourceUrl, "sourceUrl");
  let reviewComment: string | undefined;

  if (reviewUrl) {
    const review = parseGitHubPullRequestUrl(reviewUrl, "reviewUrl");
    if (
      review.owner !== source.owner ||
      review.repo !== source.repo ||
      review.prNumber !== source.prNumber
    ) {
      throw new Error("reviewUrl must point to the same GitHub pull request");
    }
    reviewComment = new URL(reviewUrl).href;
  }

  return {
    repo: `https://github.com/${source.owner}/${source.repo}`,
    prFilesAtCommit: `https://github.com/${source.owner}/${source.repo}/pull/${source.prNumber}/files?sha=${commitSha}`,
    ...(reviewComment ? { reviewComment } : {}),
  };
}

export function EvidenceViewer({ cases }: { cases: EvidenceCase[] }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const selectHashCase = () => {
      const id = window.location.hash.slice(1);
      const index = cases.findIndex((c) => c.id === id);
      if (index !== -1) setActive(index);
    };

    selectHashCase();
    window.addEventListener("hashchange", selectHashCase);
    return () => window.removeEventListener("hashchange", selectHashCase);
  }, [cases]);

  const current = cases[active] ?? cases[0]!;
  const env = current.envelope;
  const tokens = env.usage
    ? env.usage.promptTokens + env.usage.completionTokens
    : null;
  const totals = useMemo(() => {
    return {
      catches: cases.filter((c) => c.envelope.findings.length > 0).length,
      clean: cases.filter((c) => c.envelope.silent).length,
      failing: cases.filter((c) => c.envelope.gate.failing).length,
    };
  }, [cases]);
  const summaryMessages = checkSummaryMessages(env.summary);
  const diffLabel = current.diffIsExcerpt
    ? "Excerpt of the reviewed commit diff"
    : "The complete reviewed commit diff";

  const breadcrumbs = extractBreadcrumbs(
    current.sourceUrl,
    current.commitSha,
    current.reviewUrl,
  );

  return (
    <div className="ev-root">
      <style>{EV_CSS}</style>
      <div className="ev-shell">
        <header className="ev-header">
          <Reveal>
            <p className="ev-eyebrow">See it run</p>
            <h1 className="ev-h1">Evidence across the bugs reviewers miss.</h1>
            <p className="ev-lede">
              Real review output from Postil&apos;s own repositories. Every card
              links to the public pull request it came from.
            </p>
          </Reveal>
        </header>

        <div className="ev-meta-note">
          <span>
            {totals.catches} real catches, {totals.clean} real silent review
          </span>
          <span>model: {cases[0]?.envelope.modelUsed}</span>
          <span>default low-noise config</span>
        </div>

        <Reveal>
          <div className="ev-tabs" role="tablist" aria-label="Evidence types">
            {cases.map((c, idx) => (
              <button
                key={c.id}
                id={`tab-${c.id}`}
                type="button"
                role="tab"
                aria-selected={idx === active}
                aria-controls="evidence-panel"
                className={idx === active ? "ev-tab ev-tab-active" : "ev-tab"}
                onClick={() => {
                  setActive(idx);
                  window.history.replaceState(null, "", `#${c.id}`);
                }}
              >
                <span>{c.category}</span>
                <small>
                  {c.envelope.gate.failing
                    ? "blocks"
                    : c.envelope.silent
                      ? "silent"
                      : "advises"}
                </small>
              </button>
            ))}
          </div>
        </Reveal>

        <Reveal key={current.id} delay={60}>
          <section
            className="ev-case"
            id="evidence-panel"
            role="tabpanel"
            aria-labelledby={`tab-${current.id}`}
          >
            <div className="ev-case-head">
              <div>
                <p className="ev-case-category">{current.category}</p>
                <h2 className="ev-case-title">{current.title}</h2>
              </div>
              <span
                className={`ev-verdict ${env.gate.failing ? "ev-fail" : "ev-pass"}`}
              >
                {env.gate.failing ? "gate failing" : "gate passing"}
              </span>
            </div>
            <p className="ev-blurb">{current.blurb}</p>
            <div className="ev-links">
              <a
                className="ev-source ev-source-primary"
                href={breadcrumbs.repo}
                target="_blank"
                rel="noopener noreferrer"
              >
                repository
              </a>
              <a
                className="ev-source"
                href={breadcrumbs.prFilesAtCommit}
                target="_blank"
                rel="noopener noreferrer"
              >
                pull request at commit
              </a>
              {breadcrumbs.reviewComment ? (
                <a
                  className="ev-source"
                  href={breadcrumbs.reviewComment}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  review comment
                </a>
              ) : null}
            </div>

            <div className="ev-grid">
              <div className="ev-col">
                <p className="ev-col-label">{diffLabel}</p>
                <DiffBlock diff={current.diff} />
              </div>
              <div className="ev-col">
                <p className="ev-col-label">What Postil did</p>
                {env.silent ? (
                  <div className="ev-silent">
                    <span className="ev-silent-check">✓</span>
                    <p className="ev-silent-title">{env.checkRunTitle}</p>
                    {summaryMessages.map((message) => (
                      <p className="ev-silent-sub" key={message}>
                        {renderInline(message)}
                      </p>
                    ))}
                  </div>
                ) : (
                  <>
                    {summaryMessages.map((message) => (
                      <p className="ev-summary" key={message}>
                        {renderInline(message)}
                      </p>
                    ))}
                    {env.findings.map((f, i) => (
                      <Finding key={i} f={f} />
                    ))}
                  </>
                )}
              </div>
            </div>

            <div className="ev-stats">
              <span>
                {env.findings.length} finding
                {env.findings.length === 1 ? "" : "s"}
              </span>
              {env.usage && tokens !== null ? (
                <>
                  <span>{tokens.toLocaleString()} tokens</span>
                  <span>
                    {env.usage.promptTokens.toLocaleString()} prompt +{" "}
                    {env.usage.completionTokens.toLocaleString()} completion
                  </span>
                </>
              ) : (
                <span>token usage not exposed by the check-run API</span>
              )}
              <span>gate failOn: {env.gate.failOn}</span>
            </div>
          </section>
        </Reveal>

        <Reveal>
          <footer className="ev-foot">
            <p>
              All {cases.length} cases link to public pull requests in
              Postil&apos;s repositories. {totals.failing} gate checks failed,
              and the remaining reviews advised or passed silently.
            </p>
            <a className="ev-cta" href="/install">
              Try it on your own diff
            </a>
          </footer>
        </Reveal>
      </div>
    </div>
  );
}

const EV_CSS = `
.ev-root {
  --bg: #f7f5f1; --panel: #ffffff; --panel-2: #efece6; --ink: #1b2329;
  --ink-soft: #5b6770; --line: #e3ded8; --green: #586a4f; --rust: #b8431f;
  --red: #b23c37; --add-bg: rgba(100,116,92,0.12); --add-ink: #3f5a36;
  --del-bg: rgba(192,69,63,0.10); --del-ink: #9c3b36; --hunk: #6a5e9c;
  background: var(--bg); color: var(--ink);
  font-family: var(--font-inter, system-ui, sans-serif);
}
.ev-shell { max-width: 64rem; margin: 0 auto; padding: 4rem 1.5rem 6rem; }
.ev-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 2rem; }
.ev-eyebrow { text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.72rem;
  font-weight: 600; color: var(--green); margin: 0 0 0.75rem; }
.ev-h1 { font-family: var(--font-source-serif, Georgia, serif); font-size: clamp(2rem, 5vw, 3rem);
  line-height: 1.05; margin: 0; color: var(--ink); }
.ev-lede { margin: 1.25rem 0 0; max-width: 44rem; color: var(--ink-soft); font-size: 1.05rem; line-height: 1.6; }
.ev-meta-note { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; margin: 2rem 0 1rem;
  font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.78rem; color: var(--ink-soft); }
.ev-tabs { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: 0.5rem; margin: 1.5rem 0; }
.ev-tab { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 0.75rem;
  text-align: left; color: var(--ink); cursor: pointer; min-height: 4rem; }
.ev-tab:hover { border-color: var(--green); }
.ev-tab-active { border-color: var(--green); background: var(--add-bg); }
.ev-tab span { display: block; font-weight: 600; }
.ev-tab small { display: block; margin-top: 0.2rem; color: var(--ink-soft); font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.68rem; }
.ev-case { border: 1px solid var(--line); background: var(--panel); border-radius: 8px;
  padding: 1.75rem; margin-top: 1.75rem; }
.ev-case-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.ev-case-category { margin: 0 0 0.3rem; color: var(--green); font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.72rem; text-transform: uppercase; }
.ev-case-title { font-family: var(--font-source-serif, Georgia, serif); font-size: 1.5rem; margin: 0; color: var(--ink); }
.ev-verdict { font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.78rem;
  padding: 0.25rem 0.6rem; border-radius: 999px; white-space: nowrap; }
.ev-fail { color: var(--red); background: var(--del-bg); }
.ev-pass { color: var(--green); background: var(--add-bg); }
.ev-blurb { color: var(--ink-soft); margin: 0.75rem 0 1.25rem; line-height: 1.6; max-width: 50rem; }
.ev-links { display: flex; flex-wrap: wrap; gap: 0.45rem 1rem; margin: -0.5rem 0 1.25rem; }
.ev-source { display: inline-block; color: var(--ink-soft); font-family: var(--font-ibm-plex-mono, monospace);
  font-size: 0.78rem; text-decoration: none; border-bottom: 1px solid transparent; }
.ev-source:hover { border-bottom-color: var(--green); }
.ev-source-primary { color: var(--green); font-weight: 600; }
.ev-grid { display: grid; grid-template-columns: 1fr; gap: 1.25rem; }
@media (min-width: 1024px) { .ev-grid { grid-template-columns: minmax(0, 1fr) 380px; } }
.ev-col { min-width: 0; }
.ev-col-label { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem;
  font-weight: 600; color: var(--ink-soft); margin: 0 0 0.5rem; }
.ev-diff { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
  padding: 0.85rem 0; overflow-x: auto; overflow-y: auto; max-width: 100%; max-height: 26rem; margin: 0; }
.ev-diff code { display: block; width: max-content; min-width: 100%;
  font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.78rem; line-height: 1.5; }
/* width: max-content lets each line's box (and its add/del background) grow to
   its own text width instead of clipping at the pre's viewport width. Without
   it, a block-level line with white-space: pre paints text past its box edge
   but the box itself — and any background on it — stops at the container
   width, so scrolling right reveals unhighlighted, seemingly "blank" bands
   instead of the rest of the line. */
.ev-line { display: block; width: max-content; min-width: 100%; padding: 0 0.9rem; white-space: pre; }
.ev-add { background: var(--add-bg); color: var(--add-ink); }
.ev-del { background: var(--del-bg); color: var(--del-ink); }
.ev-meta { color: #4a555d; }
.ev-hunk { color: var(--hunk); }
.ev-summary { color: var(--ink); font-size: 0.95rem; line-height: 1.55; margin: 0 0 1rem;
  padding-left: 0.75rem; border-left: 2px solid var(--green); }
.ev-finding { border: 1px solid var(--line); border-radius: 8px; padding: 0.9rem 1rem; margin-bottom: 0.75rem; }
.ev-sev-error { border-left: 3px solid var(--red); }
.ev-sev-warn { border-left: 3px solid var(--rust); }
.ev-sev-info { border-left: 3px solid var(--green); }
.ev-finding-head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
.ev-badge { font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.68rem; text-transform: uppercase;
  letter-spacing: 0.06em; padding: 0.12rem 0.5rem; border-radius: 5px; background: var(--del-bg); color: var(--red); }
.ev-sev-warn .ev-badge { background: rgba(194,74,42,0.12); color: var(--rust); }
.ev-sev-info .ev-badge { background: var(--add-bg); color: var(--green); }
.ev-loc { font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.76rem; color: var(--ink-soft); }
.ev-conf { margin-left: auto; font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.72rem; color: var(--ink-soft); }
.ev-finding-title { font-size: 1rem; margin: 0 0 0.5rem; color: var(--ink); }
.ev-finding-para { font-size: 0.9rem; line-height: 1.6; color: var(--ink-soft); margin: 0 0 0.6rem; }
.ev-code { font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.82em;
  background: var(--panel-2); padding: 0.05rem 0.3rem; border-radius: 4px; color: var(--ink); }
.ev-silent { text-align: center; padding: 1.75rem 1rem; background: var(--add-bg); border-radius: 8px; }
.ev-silent-check { display: inline-block; font-size: 1.75rem; color: var(--green); }
.ev-silent-title { font-weight: 600; margin: 0.5rem 0 0.4rem; color: var(--ink); }
.ev-silent-sub { color: var(--ink-soft); font-size: 0.9rem; line-height: 1.6; margin: 0.4rem auto 0; max-width: 30rem; }
.ev-stats { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; margin-top: 1.1rem; padding-top: 0.9rem;
  border-top: 1px solid var(--line); font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.74rem; color: var(--ink-soft); }
.ev-foot { margin-top: 2.5rem; text-align: center; }
.ev-foot p { color: var(--ink-soft); max-width: 40rem; margin: 0 auto 1.25rem; line-height: 1.6; }
.ev-cta { display: inline-block; color: var(--ink); border: 1px solid var(--green); background: var(--add-bg);
  padding: 0.6rem 1.25rem; border-radius: 999px; text-decoration: none; font-size: 0.9rem; }
.ev-cta:hover { background: var(--green); color: var(--bg); }
/* Entrance animation is a motion-safe enhancement: content is visible by
   default and ends visible even without JavaScript. */
.ev-reveal { opacity: 1; }
@media (prefers-reduced-motion: no-preference) {
  .ev-reveal { animation: ev-fade-in 0.6s ease backwards; }
}
@keyframes ev-fade-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: none; }
}
`;
