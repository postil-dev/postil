"use client";

import { useEffect, useRef, useState } from "react";

import type { EvidenceCase, EvidenceFinding } from "@/data/evidence";

type Theme = "light" | "dark";

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

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="ev-diff" aria-label="reviewed diff">
      <code>
        {diff.split("\n").map((line, i) => {
          let cls = "ev-line";
          if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff "))
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
        <span className="ev-badge" aria-label={`severity: ${SEV_LABEL[f.severity]}`}>
          {f.severity}
        </span>
        <span className="ev-loc">
          {f.path}:{f.line}
        </span>
        <span className="ev-conf">{Math.round(f.confidence * 100)}% confidence</span>
      </div>
      <h4 className="ev-finding-title">{f.title}</h4>
      <FindingBody body={f.body} />
    </div>
  );
}

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`ev-reveal${shown ? " ev-in" : ""}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

export function EvidenceViewer({ cases }: { cases: EvidenceCase[] }) {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const stored = (typeof localStorage !== "undefined" && localStorage.getItem("ev-theme")) as
      | Theme
      | null;
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
    } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      setTheme("dark");
    }
  }, []);

  function toggle() {
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      try {
        localStorage.setItem("ev-theme", next);
      } catch {
        // ignore (private mode)
      }
      return next;
    });
  }

  return (
    <div className="ev-root" data-theme={theme}>
      <style>{EV_CSS}</style>
      <div className="ev-shell">
        <header className="ev-header">
          <Reveal>
            <p className="ev-eyebrow">Evidence</p>
            <h1 className="ev-h1">We say less. What we say is right.</h1>
            <p className="ev-lede">
              Real output from the Postil CLI at commit 560704e on the default model,
              run against three representative diffs. Nothing here is mocked: the findings, token
              counts, and the silence are the verbatim machine output. A broader public
              benchmark over open-source pull requests is coming; this is the honest
              starting point.
            </p>
          </Reveal>
          <button
            type="button"
            className="ev-toggle"
            onClick={toggle}
            aria-pressed={theme === "dark"}
            aria-label={`switch to ${theme === "light" ? "dark" : "light"} mode`}
          >
            {theme === "light" ? "◑ Dark" : "◐ Light"}
          </button>
        </header>

        <div className="ev-meta-note">
          <span>model: deepseek/deepseek-v4-pro</span>
          <span>captured June 2026</span>
          <span>default low-noise config</span>
        </div>

        {cases.map((c, idx) => {
          const env = c.envelope;
          const tokens = env.usage.promptTokens + env.usage.completionTokens;
          return (
            <Reveal key={c.id} delay={idx === 0 ? 0 : 60}>
              <section className="ev-case">
                <div className="ev-case-head">
                  <h2 className="ev-case-title">{c.title}</h2>
                  <span className={`ev-verdict ${env.gate.failing ? "ev-fail" : "ev-pass"}`}>
                    {env.gate.failing ? "● gate failing" : "✓ gate passing"}
                  </span>
                </div>
                <p className="ev-blurb">{c.blurb}</p>

                <div className="ev-grid">
                  <div className="ev-col">
                    <p className="ev-col-label">The diff under review</p>
                    <DiffBlock diff={c.diff} />
                  </div>
                  <div className="ev-col">
                    <p className="ev-col-label">What Postil did</p>
                    {env.silent ? (
                      <div className="ev-silent">
                        <span className="ev-silent-check">✓</span>
                        <p className="ev-silent-title">Silent. Postil posted nothing.</p>
                        <p className="ev-silent-sub">
                          It reviewed the change and found nothing that affects the merge
                          decision. No comment, no noise — the check just goes green. That
                          restraint is the product.
                        </p>
                      </div>
                    ) : (
                      <>
                        {env.summary ? <p className="ev-summary">{env.summary}</p> : null}
                        {env.findings.map((f, i) => (
                          <Finding key={i} f={f} />
                        ))}
                      </>
                    )}
                  </div>
                </div>

                <div className="ev-stats">
                  <span>
                    {env.findings.length} finding{env.findings.length === 1 ? "" : "s"}
                  </span>
                  <span>{tokens.toLocaleString()} tokens</span>
                  <span>gate failOn: {env.gate.failOn}</span>
                </div>
              </section>
            </Reveal>
          );
        })}

        <Reveal>
          <footer className="ev-foot">
            <p>
              This is the bar we hold ourselves to: catch the regression, catch the subtle
              bug, and stay quiet on everything else. When the public benchmark lands, the
              raw envelopes will live here too.
            </p>
            <a className="ev-cta" href="/install">
              Try it on your own diff →
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
  --ink-soft: #5b6770; --line: #e3ded8; --green: #64745c; --rust: #c24a2a;
  --red: #c0453f; --add-bg: rgba(100,116,92,0.12); --add-ink: #3f5a36;
  --del-bg: rgba(192,69,63,0.10); --del-ink: #9c3b36; --hunk: #8a7fb0;
  background: var(--bg); color: var(--ink);
  font-family: var(--font-inter, system-ui, sans-serif);
}
.ev-root[data-theme="dark"] {
  --bg: #12171b; --panel: #1b2329; --panel-2: #222c33; --ink: #f3f1ec;
  --ink-soft: #9aa6ae; --line: #2b353c; --green: #8fa585; --rust: #e0673f;
  --red: #e6837d; --add-bg: rgba(143,165,133,0.14); --add-ink: #a9c39c;
  --del-bg: rgba(230,131,125,0.12); --del-ink: #e6837d; --hunk: #b3a9d6;
}
.ev-shell { max-width: 64rem; margin: 0 auto; padding: 4rem 1.5rem 6rem; }
.ev-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 2rem; }
.ev-eyebrow { text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.72rem;
  font-weight: 600; color: var(--green); margin: 0 0 0.75rem; }
.ev-h1 { font-family: var(--font-source-serif, Georgia, serif); font-size: clamp(2rem, 5vw, 3rem);
  line-height: 1.05; margin: 0; color: var(--ink); }
.ev-lede { margin: 1.25rem 0 0; max-width: 44rem; color: var(--ink-soft); font-size: 1.05rem; line-height: 1.6; }
.ev-toggle { flex: none; border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  border-radius: 999px; padding: 0.5rem 1rem; font-size: 0.85rem; cursor: pointer; transition: background 0.2s, border-color 0.2s; }
.ev-toggle:hover { border-color: var(--green); }
.ev-toggle:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
.ev-meta-note { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; margin: 2rem 0 1rem;
  font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.78rem; color: var(--ink-soft); }
.ev-case { border: 1px solid var(--line); background: var(--panel); border-radius: 14px;
  padding: 1.75rem; margin-top: 1.75rem; }
.ev-case-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.ev-case-title { font-family: var(--font-source-serif, Georgia, serif); font-size: 1.5rem; margin: 0; color: var(--ink); }
.ev-verdict { font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.78rem;
  padding: 0.25rem 0.6rem; border-radius: 999px; white-space: nowrap; }
.ev-fail { color: var(--red); background: var(--del-bg); }
.ev-pass { color: var(--green); background: var(--add-bg); }
.ev-blurb { color: var(--ink-soft); margin: 0.75rem 0 1.25rem; line-height: 1.6; max-width: 50rem; }
.ev-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
@media (max-width: 760px) { .ev-grid { grid-template-columns: 1fr; } }
.ev-col-label { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem;
  font-weight: 600; color: var(--ink-soft); margin: 0 0 0.5rem; }
.ev-diff { background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px;
  padding: 0.85rem 0; overflow-x: auto; margin: 0; }
.ev-diff code { display: block; font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.78rem; line-height: 1.5; }
.ev-line { display: block; padding: 0 0.9rem; white-space: pre; }
.ev-add { background: var(--add-bg); color: var(--add-ink); }
.ev-del { background: var(--del-bg); color: var(--del-ink); }
.ev-meta { color: var(--ink-soft); opacity: 0.7; }
.ev-hunk { color: var(--hunk); }
.ev-summary { color: var(--ink); font-size: 0.95rem; line-height: 1.55; margin: 0 0 1rem;
  padding-left: 0.75rem; border-left: 2px solid var(--green); }
.ev-finding { border: 1px solid var(--line); border-radius: 10px; padding: 0.9rem 1rem; margin-bottom: 0.75rem; }
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
.ev-silent { text-align: center; padding: 1.75rem 1rem; background: var(--add-bg); border-radius: 10px; }
.ev-silent-check { display: inline-block; font-size: 1.75rem; color: var(--green); }
.ev-silent-title { font-weight: 600; margin: 0.5rem 0 0.4rem; color: var(--ink); }
.ev-silent-sub { color: var(--ink-soft); font-size: 0.9rem; line-height: 1.6; margin: 0 auto; max-width: 30rem; }
.ev-stats { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; margin-top: 1.1rem; padding-top: 0.9rem;
  border-top: 1px solid var(--line); font-family: var(--font-ibm-plex-mono, monospace); font-size: 0.74rem; color: var(--ink-soft); }
.ev-foot { margin-top: 2.5rem; text-align: center; }
.ev-foot p { color: var(--ink-soft); max-width: 40rem; margin: 0 auto 1.25rem; line-height: 1.6; }
.ev-cta { display: inline-block; color: var(--ink); border: 1px solid var(--green); background: var(--add-bg);
  padding: 0.6rem 1.25rem; border-radius: 999px; text-decoration: none; font-size: 0.9rem; }
.ev-cta:hover { background: var(--green); color: var(--bg); }
.ev-reveal { opacity: 0; transform: translateY(12px); transition: opacity 0.6s ease, transform 0.6s ease; }
.ev-reveal.ev-in { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) { .ev-reveal { opacity: 1; transform: none; transition: none; } }
`;
