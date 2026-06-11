import Link from "next/link";
import { AnchorHeading, CtaStrip, PageFrame, SectionIntro, StatusLine, type StatusKind } from "../site";

export const metadata = {
  title: "Docs",
};

const install = `cargo install --git https://github.com/postil-dev/postil-cli --locked --force`;

const usage = `postil review --repo owner/repo --pr 123 --sha HEAD_SHA`;

const localUsage = `$ postil review --diff-file .cache/change.diff
$ postil review --staged
$ postil review --base origin/main`;

const setup = `export GITHUB_TOKEN=ghp_...
export OPENROUTER_API_KEY=...

export REVIEW_MODEL=moonshotai/kimi-k2.6
# optional model fallback sequence
export REVIEW_MODEL_CASCADE=deepseek/deepseek-r1-0528`;

const exitCodes = `# Command behavior from the CLI runtime
0: command completed
1: command/setup/runtime error`;

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
          api-key: \${{ secrets.OPENROUTER_API_KEY }}
          github-token: \${{ secrets.GITHUB_TOKEN }}`;

const config = `.postil.yaml

githubToken: test-github
openrouterApiKey: test-openrouter
repo: owner/repo
pr: 123
sha: abc123
reviewModel: xiaomi/mimo-v2.5-pro
failOn: warn
review:
  enabled: true
  ignore:
    - "dist/**"
  severityThreshold: warn
  maxFindings: 12
  reviewer:
    tone: neutral
    focus:
      - authorization-sensitive code
      - billing mutations
      - data deletion paths
  review:
    enabled: true
    onClean: skip`;

const sections = [
  {
    id: "install",
    title: "Install",
    body: "Install the CLI from GitHub with Cargo. The hosted GitHub App opens after final review.",
    code: install,
  },
  {
    id: "use",
    title: "Use",
    body: "Run a review against the repository, pull request, and commit SHA you want to check.",
    code: usage,
  },
  {
    id: "setup",
    title: "Setup",
    body: "Export runtime tokens and optional model values before first run.",
    code: setup,
  },
  {
    id: "local-review",
    title: "Local review",
    body: "Use local modes to review staged or diff-only changes before creating a PR.",
    code: localUsage,
  },
  {
    id: "ask-again",
    title: "Ask again",
    body: "Mention @postil on a PR conversation, review, or inline thread.",
  },
  {
    id: "cut-noise",
    title: "Cut noise",
    body: "Use `onClean: skip`, severity thresholds, max findings, and ignored globs.",
  },
  {
    id: "exit-behavior",
    title: "Exit behavior",
    body: "The CLI reports command-level success and failure via exit status; use your CI policy to map that to merge gates.",
  },
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
            id="top"
          />
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-3 px-4 sm:px-6 md:grid-cols-2 xl:grid-cols-4">
          {sections.map(({ id, title, body, code }) => (
            <article key={title} className="border bg-card p-5">
              <AnchorHeading id={id} as="h2" className="text-2xl">
                {title}
              </AnchorHeading>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
              {code ? (
                <pre className="code-scrollbar mt-4 overflow-x-auto bg-[#1b2329] p-4 font-mono text-xs leading-6 text-[#f7f5f1]">
                  {code}
                </pre>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-2">
          <DocBlock id="github-action" title="GitHub Action" code={workflow} />
          <DocBlock id="repository-config" title="Repository config" code={config} />
          <DocBlock id="local-review-block" title="Local review" code={localUsage} />
          <DocBlock id="output-contract" title="Output contract" code={exitCodes} />
          <article className="border bg-card p-6">
            <AnchorHeading id="status-line" as="h2" className="text-3xl">
              Status line
            </AnchorHeading>
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
            <AnchorHeading id="useful-links" as="h2" className="text-3xl text-foreground">
              Useful links
            </AnchorHeading>
            <p className="mt-4">
              Configuration reference lives in{" "}
              <Link href="https://github.com/postil-dev/postil/blob/main/docs/config.md" className="text-primary hover:underline">
                docs/config.md
              </Link>
              . The CLI page lives in{" "}
              <Link href="/cli" className="text-primary hover:underline">
                /cli
              </Link>
              , and the implementation lives in{" "}
              <Link href="https://github.com/postil-dev/postil-cli" className="text-primary hover:underline">
                postil-dev/postil-cli
              </Link>
              .
            </p>
          </div>
          <div>
            <AnchorHeading id="benchmark-direction" as="h2" className="text-3xl text-foreground">
              Benchmark direction
            </AnchorHeading>
            <p className="mt-4">
              Public evals are coming after human review. The{" "}
              <Link href="/benchmarks" className="text-primary hover:underline">
                benchmark page
              </Link>{" "}
              explains the harness, isolated PR fixtures, and the score split between hits, misses, noise, and clean silence.
            </p>
          </div>
        </div>
      </section>
      <CtaStrip />
    </PageFrame>
  );
}

function DocBlock({ id, title, code }: { id: string; title: string; code: string }) {
  return (
    <article className="min-w-0 border bg-card p-6">
      <AnchorHeading id={id} as="h2" className="text-3xl">
        {title}
      </AnchorHeading>
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
