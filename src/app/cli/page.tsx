import { ArrowRight, CheckCircle2, TerminalSquare } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { TrackedLink } from "@/components/tracked-link";
import { buttonVariants } from "@/components/ui/button";
import { AnchorHeading, CtaStrip, PageFrame, SectionIntro } from "../site";

export const metadata = {
  title: "CLI",
};

const install = `cargo install --git https://github.com/postil-dev/postil-cli --locked --force`;

const usage = `postil review --repo owner/repo --pr 123 --sha HEAD_SHA`;

const localUsage = `postil review --diff-file .cache/change.diff
postil review --staged
postil review --base origin/main`;

const jsonOutput = `postil review --output-json .cache/postil-review.json`;

const setup = `# Run-time token and model settings
export GITHUB_TOKEN=...
export OPENROUTER_API_KEY=...

# Optional: pin model and cascade path
export REVIEW_MODEL=moonshotai/kimi-k2.6
export REVIEW_MODEL_CASCADE=moonshotai/kimi-k2.6:think`;

const expectations = [
  "Clean PRs can stay quiet instead of generating a filler recap.",
  "Findings should point at the changed file and line that carry the risk.",
  "Repository policy can live in `.postil.yaml`, `.coderabbit.yaml`, or `.kodo.yaml`.",
  "Exit code is 0 when the command succeeds, and non-zero when setup or execution fails.",
];

export default function CliPage() {
  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionIntro
            eyebrow="CLI"
            title="Run Postil in your own CI before the hosted app opens."
            body="The Rust reviewer lives in postil-dev/postil-cli. Install it, point it at a pull request, and expect merge-relevant findings or silence."
            id="top"
          />
          <div className="mt-8 flex flex-wrap gap-3">
            <TrackedLink
              href="https://github.com/postil-dev/postil-cli"
              cta="Read repo"
              className={buttonVariants({ size: "lg" })}
            >
              Read the repo <ArrowRight className="ml-2 h-4 w-4" />
            </TrackedLink>
            <TrackedLink href="/docs" cta="Open docs" className={buttonVariants({ variant: "outline", size: "lg" })}>
              Open docs
            </TrackedLink>
          </div>
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-4 px-4 sm:px-6 md:grid-cols-3">
            <InfoCard
              id="install"
              icon={<TerminalSquare className="h-5 w-5 text-accent" />}
              title="Install"
              body="Use Cargo to install the CLI from GitHub."
              code={install}
            />
            <InfoCard
              id="setup"
              icon={<ArrowRight className="h-5 w-5 text-accent" />}
              title="Setup"
              body="Export tokens first, then set model overrides if your environment uses a different path."
              code={setup}
            />
            <InfoCard
              id="use"
              icon={<ArrowRight className="h-5 w-5 text-accent" />}
              title="Use"
              body="Run a review against the repo, pull request, and commit SHA you want to check."
              code={usage}
            />
            <InfoCard
              id="local-review"
              icon={<ArrowRight className="h-5 w-5 text-accent" />}
              title="Local review"
              body="Use local modes when you want to review a patch or staged files before creating a PR."
              code={localUsage}
            />
            <InfoCard
              id="json-output"
              icon={<TerminalSquare className="h-5 w-5 text-accent" />}
              title="JSON output"
              body="Write the structured review envelope when a workflow needs machine-readable results."
              code={jsonOutput}
            />
            <InfoCard
              id="output-and-safety"
              icon={<CheckCircle2 className="h-5 w-5 text-accent" />}
              title="Output and safety"
              body="CLI output is either quiet or line-backed findings. Review your CI policy for how findings map to merges."
              list={expectations}
            />
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <AnchorHeading id="what-you-should-see" as="h2" className="text-4xl leading-tight">
              What you should see
            </AnchorHeading>
            <p className="mt-4 text-sm leading-7 text-muted-foreground">
              The CLI is for teams that want review in CI or local pre-merge checks without inventing a new review ritual.
            </p>
          </div>
          <div className="border bg-card p-6">
            <ul className="space-y-4 text-sm leading-7">
              {expectations.map((item) => (
                <li key={item} className="flex gap-3">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 text-sm leading-7 text-muted-foreground sm:px-6 lg:grid-cols-2">
          <div>
            <AnchorHeading id="useful-links" as="h2" className="text-3xl text-foreground">
              Useful links
            </AnchorHeading>
            <p className="mt-4">
              The implementation lives in{" "}
              <Link href="https://github.com/postil-dev/postil-cli" className="text-primary hover:underline">
                postil-dev/postil-cli
              </Link>
              . Repository policy and config examples live in{" "}
              <Link href="https://github.com/postil-dev/postil/blob/main/docs/config.md" className="text-primary hover:underline">
                docs/config.md
              </Link>
              .
            </p>
          </div>
          <div>
            <AnchorHeading id="behavior-boundary" as="h2" className="text-3xl text-foreground">
              Behavior boundary
            </AnchorHeading>
            <p className="mt-4">
              Public site copy should describe how to run the CLI and what its output means. It should not promise hidden benchmarking claims or detailed execution internals.
            </p>
          </div>
        </div>
      </section>

      <CtaStrip />
    </PageFrame>
  );
}

function InfoCard({
  id,
  icon,
  title,
  body,
  code,
  list,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  body: string;
  code?: string;
  list?: string[];
}) {
  return (
    <article className="border bg-card p-6">
      <div className="flex items-center gap-3">
        {icon}
        <AnchorHeading id={id} as="h2" className="font-mono text-xs uppercase tracking-[0.16em] text-primary">
          {title}
        </AnchorHeading>
      </div>
      <p className="mt-4 text-sm leading-6 text-muted-foreground">{body}</p>
      {code ? (
        <pre className="code-scrollbar mt-5 overflow-x-auto bg-[#1b2329] p-4 font-mono text-xs leading-6 text-[#f7f5f1]">{code}</pre>
      ) : null}
      {list ? (
        <ul className="mt-5 space-y-3 text-sm leading-6">
          {list.map((item) => (
            <li key={item} className="flex gap-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
