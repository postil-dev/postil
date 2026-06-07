import Link from "next/link";
import { CtaStrip, PageFrame, SectionIntro, StatusLine, type StatusKind } from "../site";

export const metadata = {
  title: "Docs",
};

const workflow = `name: Postil Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: postil-dev/postil-action@v1
        with:
          openrouter-api-key: \${{ secrets.OPENROUTER_API_KEY }}`;

const config = `.postil.yaml

review:
  review:
    onClean: skip
  severityThreshold: warn
  maxFindings: 12
  reviewer:
    focus:
      - authorization-sensitive code
      - billing mutations
      - data deletion paths`;

const local = `$ postil review --diff-file .cache/change.diff
$ postil review --staged
$ postil review --base origin/main`;

const sections = [
  ["Install", "Use the Postil CLI today. The managed GitHub App opens after final review."],
  ["Ask again", "Mention @postil on a PR conversation, review, or inline thread."],
  ["Cut noise", "Use `onClean: skip`, severity thresholds, max findings, and ignored globs."],
  ["Write less", "A finding needs a risk and a line. Otherwise, leave the PR alone."],
];

export default function DocsPage() {
  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionIntro
            eyebrow="Docs"
            title="Install the reviewer where pull requests already happen."
            body="Run Postil from GitHub Actions or locally while the hosted app finishes review. The default is simple: report the risky line, or say nothing."
          />
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-3 px-4 sm:px-6 md:grid-cols-4">
          {sections.map(([title, body]) => (
            <article key={title} className="border bg-card p-5">
              <h2 className="text-2xl">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-2">
          <DocBlock title="GitHub Action" code={workflow} />
          <DocBlock title="Repository config" code={config} />
          <DocBlock title="Local review" code={local} />
          <article className="border bg-card p-6">
            <h2 className="text-3xl">Status line</h2>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Postil uses compact SVG status marks instead of platform emoji, so the result is consistent across GitHub, browser tabs, and docs.
            </p>
            <div className="mt-6 space-y-3 font-mono text-sm">
              <StatusRow label="clean" marks={["pass"]} />
              <StatusRow label="warning" marks={["warn", "warn", "info"]} />
              <StatusRow label="blocking" marks={["error", "warn"]} />
            </div>
          </article>
        </div>
      </section>

      <section className="py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 text-sm leading-7 text-muted-foreground sm:px-6 lg:grid-cols-2">
          <div>
            <h2 className="text-3xl text-foreground">Useful links</h2>
            <p className="mt-4">
              Configuration reference lives in{" "}
              <Link href="https://github.com/postil-dev/postil/blob/main/docs/config.md" className="text-primary hover:underline">
                docs/config.md
              </Link>
              . The CLI lives in{" "}
              <Link href="https://github.com/postil-dev/postil-cli" className="text-primary hover:underline">
                postil-dev/postil-cli
              </Link>
              .
            </p>
          </div>
          <div>
            <h2 className="text-3xl text-foreground">Benchmark direction</h2>
            <p className="mt-4">
              Public evals are coming after human review. The harness uses isolated PR fixtures, real bugs, no upstream fixes, and separate scores for hits, misses, noise, and clean silence.
            </p>
          </div>
        </div>
      </section>
      <CtaStrip />
    </PageFrame>
  );
}

function DocBlock({ title, code }: { title: string; code: string }) {
  return (
    <article className="min-w-0 border bg-card p-6">
      <h2 className="text-3xl">{title}</h2>
      <pre className="code-scrollbar mt-5 max-w-full overflow-x-auto bg-[#1b2329] p-4 font-mono text-xs leading-6 text-[#f7f5f1]">
        {code}
      </pre>
    </article>
  );
}

function StatusRow({ label, marks }: { label: string; marks: StatusKind[] }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 text-muted-foreground">{label}</span>
      <StatusLine label="status:" marks={marks} />
    </div>
  );
}
