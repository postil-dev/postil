import { CtaStrip, PageFrame, ReviewCard, SectionIntro, statusExamples } from "../site";
import { StatusLine } from "@/components/status-line";

export const metadata = {
  title: "How It Works",
};

const steps = [
  ["1", "Triggered", "A PR update or @postil mention starts a run on the current head SHA."],
  ["2", "Loaded", "Postil reads the diff, config, and open review threads."],
  ["3", "Checked", "The reviewer returns structured findings, not a prose blob."],
  ["4", "Filtered", "Ignored paths, severity thresholds, and max findings apply before posting."],
  ["5", "Posted", "Real findings become inline comments. Clean reviews can stay quiet."],
  ["6", "Recorded", "The check run records the result for branch protection."],
];

const details = [
  ["Ask again", "Comment @postil in a PR, review, or inline thread for another pass."],
  ["Keeps context", "Open review threads and change requests go into the prompt."],
  ["Can stay quiet", "No finding means no synthetic recap."],
  ["Line-backed", "Each finding points to the changed file and line it depends on."],
];

export default function HowItWorksPage() {
  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
          <SectionIntro
            eyebrow="How it works"
            title="A review run you can audit."
            body="One event in, one diff reviewed, one check run out. If there is nothing worth saying, the PR does not get a bot recap."
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
              The examples rotate, but each one is the kind of issue a reviewer would actually block on.
            </p>
          </div>
          <ReviewCard />
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
