import { CtaStrip, PageFrame, ReviewCard, SectionIntro, statusExamples } from "../site";
import { ReviewExamples } from "@/components/review-examples";
import { StatusLine } from "@/components/status-line";

export const metadata = {
  title: "How It Works",
};

const steps = [
  ["1", "Trigger", "A PR event or @postil mention starts a review run for the current PR head SHA."],
  ["2", "Context", "Postil loads the diff, repository config, and existing human review context."],
  ["3", "Review", "The reviewer returns structured findings. Invalid output fails closed instead of posting vague prose."],
  ["4", "Filter", "Repository config drops ignored paths, caps finding count, and controls clean-review behavior."],
  ["5", "Report", "Findings become inline comments with a compact SVG status line. Clean reviews can stay silent."],
  ["6", "Gate", "The check run records pass, warning, or failure so branch protection can use the result."],
];

const details = [
  ["Mention-aware", "Comment @postil on a PR conversation, review, or inline thread to request a fresh pass."],
  ["Human-context aware", "Existing review comments and outstanding change requests are included as review context."],
  ["Quiet by default", "When no merge-relevant issue exists, the review can complete without adding a PR comment."],
  ["Auditable", "Every finding is tied to a changed file and line, with the intent or risk stated directly."],
];

export default function HowItWorksPage() {
  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
          <SectionIntro
            eyebrow="How it works"
            title="A review run you can audit."
            body="Postil keeps the control surface small: GitHub event in, diff and context reviewed, inline findings out. The status line is intentionally compact."
          />
          <ReviewCard />
        </div>
      </section>
      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-3 px-4 sm:px-6 md:grid-cols-3">
          {steps.map(([number, title, body]) => (
            <article key={title} className="border bg-card p-5">
              <div className="font-mono text-sm text-primary">{number}</div>
              <h2 className="mt-5 text-2xl">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.72fr_1.28fr]">
          <div>
            <h2 className="text-4xl leading-tight">What the reviewer notices</h2>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              These examples auto-rotate and can be selected manually. They show the intended style: short, concrete, and focused on merge risk.
            </p>
          </div>
          <ReviewExamples />
        </div>
      </section>
      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-3 px-4 sm:px-6 md:grid-cols-4">
          {details.map(([title, body]) => (
            <article key={title} className="border bg-card p-5">
              <h2 className="text-2xl">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <h2 className="text-4xl">Status examples</h2>
          <div className="mt-8 grid gap-3 md:grid-cols-4">
            {statusExamples.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.label} className="border bg-card p-5">
                  <Icon className="h-5 w-5 text-accent" />
                  <div className="mt-5 font-mono text-xs uppercase text-muted-foreground">{item.label}</div>
                  <StatusLine label="status:" marks={item.status} className="mt-2 text-lg" />
                </article>
              );
            })}
          </div>
        </div>
      </section>
      <CtaStrip />
    </PageFrame>
  );
}
