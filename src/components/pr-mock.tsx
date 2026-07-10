import { StatusIcon } from "@/components/status-icon";

const MIGRATION_DIFF_LINES = [
  '+CREATE INDEX "installations_org_idx" ON "installations" USING btree ("org_id");--> statement-breakpoint',
  '+CREATE INDEX "org_members_user_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint',
  '+CREATE UNIQUE INDEX "organizations_github_org_id_idx" ON "organizations" USING btree ("github_org_id");',
];

const FINDING_TITLE = "Add deduplication before unique index migration";
const FINDING_BODY =
  "The new `CREATE UNIQUE INDEX` on `organizations.github_org_id` will fail if the database already contains duplicate non-null values. The PR description explicitly states that concurrent installation webhooks could have created duplicate organization rows for the same GitHub org before this fix. Run `SELECT github_org_id, COUNT(*) FROM organizations WHERE github_org_id IS NOT NULL GROUP BY github_org_id HAVING COUNT(*) > 1;` against the production database; if any rows are returned, merge the duplicates and update referencing foreign keys before this migration is applied.";

/**
 * A hand-built illustration of real data from postil#275 and its exact
 * postil/review check-run. This recreates the product surface; it is not a
 * screenshot of GitHub.
 */
export function PrMock() {
  return (
    <figure className="card overflow-hidden font-sans">
      <div className="flex items-center justify-between border-b border-stone bg-paper px-4 py-2.5">
        <div className="flex items-center gap-2 font-mono text-xs text-charcoal/70">
          <span className="h-2.5 w-2.5 rounded-full bg-stone" />
          <span className="h-2.5 w-2.5 rounded-full bg-stone" />
          <span className="h-2.5 w-2.5 rounded-full bg-stone" />
          <span className="ml-2">github.com/postil-dev/postil · #275</span>
        </div>
        <span className="rounded-full border border-stone px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-charcoal/70">
          illustrative
        </span>
      </div>

      <div className="space-y-5 p-5">
        <div>
          <p className="serif-display text-lg text-charcoal">
            Close TOCTOU races in review completion and org creation
          </p>
          <p className="mt-0.5 font-mono text-xs text-charcoal/70">
            fix/review-watchdog-race-and-org-integrity → main · 10 files, +1,438
            −49
          </p>
        </div>

        <div className="rounded-card border border-stone">
          <p className="border-b border-stone px-4 py-2 text-sm font-medium text-charcoal">
            Some checks were not successful
          </p>
          <ul className="divide-y divide-stone text-sm">
            <li className="flex items-center gap-3 px-4 py-2.5">
              <StatusIcon kind="error" size={16} />
              <span className="font-mono text-charcoal">postil/gate</span>
              <span className="text-rust">Failing</span>
              <span className="ml-auto text-charcoal/70">
                1 gate-level finding (severity error)
              </span>
            </li>
            <li className="flex items-center gap-3 px-4 py-2.5">
              <StatusIcon kind="pass" size={16} />
              <span className="font-mono text-charcoal">postil/review</span>
              <span className="text-gate">Completed</span>
              <span className="ml-auto text-charcoal/70">
                1 error annotation
              </span>
            </li>
          </ul>
        </div>

        <div className="rounded-card border border-stone">
          <div className="flex items-center gap-2 border-b border-stone bg-paper px-4 py-2 font-mono text-xs text-charcoal/70">
            <span>drizzle/0001_org_indexes_and_constraints.sql</span>
            <span className="text-charcoal/70">·</span>
            <span>line 3</span>
          </div>
          <div className="overflow-x-auto bg-charcoal px-4 py-2.5 font-mono text-xs text-ivory/90">
            {MIGRATION_DIFF_LINES.map((line, index) => (
              <div className="whitespace-pre" key={line}>
                <span className="text-ivory/60">{index + 1}</span>
                {"  "}
                <span className="text-[#a9bd9b]">{line}</span>
              </div>
            ))}
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center gap-2">
              <StatusIcon kind="error" size={14} />
              <span className="text-sm font-medium text-charcoal">{FINDING_TITLE}</span>
              <span className="ml-auto font-mono text-[11px] text-charcoal/70">
                confidence 0.85 · kind: risk
              </span>
            </div>
            <p className="mt-2 text-sm text-ink-soft">{FINDING_BODY}</p>
          </div>
        </div>
      </div>

      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-stone px-5 py-3 font-mono text-[11px] text-charcoal/70">
        <span>Illustrative product UI. Not a screenshot.</span>
        <a
          href="https://github.com/postil-dev/postil/runs/84687183194"
          target="_blank"
          rel="noopener noreferrer"
          className="text-rust underline"
        >
          exact check-run
        </a>
      </figcaption>
    </figure>
  );
}
