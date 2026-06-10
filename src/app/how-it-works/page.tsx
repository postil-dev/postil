import { Code } from "@/components/code";

export const metadata = {
  title: "How it works",
  description: "Architecture: a Rust engine, a thin Action, a quiet backend.",
};

export default function HowItWorksPage() {
  return (
    <article className="container-page py-16 max-w-3xl">
      <h1 className="font-serif text-5xl mb-6">How Postil reviews a PR.</h1>

      <ol className="space-y-8 mt-10">
        <Step n={1} title="GitHub webhook arrives.">
          <p>
            The Postil GitHub App receives the <code>pull_request</code> event. We verify
            the HMAC, dedupe the delivery, and create a <code>postil/review</code>{" "}
            check-run on the PR head SHA. The check appears immediately as{" "}
            <em>in progress</em>.
          </p>
        </Step>
        <Step n={2} title="The job lands in Postgres.">
          <p>
            The backend mints a short-lived GitHub App installation token, encrypts it
            with the review-token secret, and enqueues a <code>review</code> job in the
            Postgres-backed job table. No Trigger.dev. No JS worker. Just{" "}
            <code>SELECT FOR UPDATE SKIP LOCKED</code>.
          </p>
        </Step>
        <Step n={3} title="The worker spawns the CLI.">
          <p>
            A worker pulls the next queued job and runs the CLI binary baked into the
            image:
          </p>
          <Code>{`postil review \\
  --repo owner/name \\
  --pr 123 \\
  --sha <head-sha> \\
  --check-run-id <id> \\
  --output-json /tmp/envelope.json`}</Code>
          <p className="mt-3">
            The exact same binary is what your <code>postil-action</code> CI job runs and
            what you can <code>brew install</code> locally.
          </p>
        </Step>
        <Step n={4} title="The CLI does the review.">
          <p>
            The CLI fetches the unified diff, loads <code>.postil.yaml</code> from the PR
            head SHA, builds a deterministic prompt, calls OpenRouter with the configured
            model cascade, and validates the JSON envelope. On bad output it retries once
            with a JSON-repair pass; if that fails too, it emits a synthetic{" "}
            <code>error</code> finding at{" "}
            <code>.postil/model-output:1</code> so the check fails closed.
          </p>
        </Step>
        <Step n={5} title="Findings get filtered against the diff.">
          <p>
            Each finding must cite a path and line that actually appear in the diff. The
            filter drops phantom findings (or snaps them to the nearest real line when
            the file matches and the line is close). Glob ignores from{" "}
            <code>.postil.yaml</code> and the severity threshold apply here.
          </p>
        </Step>
        <Step n={6} title="The review lands.">
          <p>
            If there are findings, the CLI posts an inline review with a one-line status
            chip (<code>status: ❌⚠️ℹ️</code>). If there are none, it stays silent — the
            check completes <code>success</code> and your PR shows a single green tick.
          </p>
        </Step>
        <Step n={7} title="Auto-merge, if you asked.">
          <p>
            With <code>review.autoMerge: true</code>, the backend waits for{" "}
            <code>postil/review</code> plus every check in your{" "}
            <code>requiredChecks</code> list (or branch protection) to be green, then
            calls the merge endpoint.
          </p>
        </Step>
      </ol>

      <div className="panel-quiet p-6 mt-12 font-mono text-xs leading-relaxed">
        {`GitHub  ──webhook──▶  postil (Next.js)
                            │ create check-run
                            │ enqueue review job (postgres)
                            ▼
                       worker pool
                            │ spawns
                            ▼
                       postil-cli (Rust)
                            │ envelope (json)
                            ├──▶  inline review + check-run
                            └──▶  reviews table + usage_events`}
      </div>
    </article>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[3rem_1fr] gap-4 items-start">
      <div className="font-serif text-3xl text-[color:var(--color-gate)] leading-none mt-1">
        {n}.
      </div>
      <div>
        <h2 className="font-serif text-2xl mb-2">{title}</h2>
        <div className="text-[color:var(--color-charcoal-soft)] leading-relaxed space-y-3">
          {children}
        </div>
      </div>
    </li>
  );
}
