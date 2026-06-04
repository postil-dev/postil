"use client";

import { useEffect, useState } from "react";
import { DiffPreview } from "@/components/diff-preview";
import { StatusLine } from "@/components/status-line";
import { StatusMark, type StatusKind } from "@/components/status-mark";

const ROTATION_MS = 4200;

type Example = {
  id: string;
  label: string;
  title: string;
  file: string;
  severity: StatusKind;
  status: StatusKind[];
  body: string;
  before: string;
  after: string;
};

const examples: Example[] = [
  {
    id: "billing",
    label: "Billing",
    title: "Plan mutation moved before authorization.",
    file: "src/billing/plan.ts:84",
    severity: "error",
    status: ["error"],
    body: "The write now happens before the permission check, so an unauthorized caller can change a plan and still receive an authorization error. Put the authorization gate before the mutation.",
    before: "await billing.updatePlan(org.id, plan)\nif (!canManageBilling(actor, org)) throw new Error('denied')",
    after: "if (!canManageBilling(actor, org)) throw new Error('denied')\nawait billing.updatePlan(org.id, plan)",
  },
  {
    id: "security",
    label: "Security",
    title: "Webhook signature is checked after parsing.",
    file: "src/api/webhooks.ts:31",
    severity: "error",
    status: ["error", "warn"],
    body: "Parsing untrusted JSON before signature verification lets malformed payloads spend CPU and reach error paths. Verify the raw body first, then parse.",
    before: "const payload = JSON.parse(body)\nverifySignature(body, signature)",
    after: "verifySignature(body, signature)\nconst payload = JSON.parse(body)",
  },
  {
    id: "ui",
    label: "UI",
    title: "The empty state now hides the primary action.",
    file: "src/app/projects/page.tsx:118",
    severity: "warn",
    status: ["warn"],
    body: "When the project list is empty, the branch returns before rendering the create button. New users lose the only obvious next action.",
    before: "if (!projects.length) return <EmptyState />",
    after: "if (!projects.length) return <EmptyState action={<CreateProject />} />",
  },
  {
    id: "race",
    label: "Race",
    title: "Two workers can claim the same queued job.",
    file: "src/jobs/queue.ts:52",
    severity: "error",
    status: ["error"],
    body: "The read and update are separate operations. Two workers can read the same pending row before either writes the claim. Use an atomic update or row lock.",
    before: "const job = await nextPendingJob()\nawait markRunning(job.id)",
    after: "const job = await claimNextPendingJob({ lock: true })",
  },
  {
    id: "migration",
    label: "Migration",
    title: "New non-null column has no backfill.",
    file: "drizzle/0042_accounts.sql:6",
    severity: "warn",
    status: ["warn", "info"],
    body: "Existing rows will fail the migration because `billing_email` is added as non-null without a default or staged backfill.",
    before: "ALTER TABLE accounts ADD COLUMN billing_email text NOT NULL;",
    after: "ALTER TABLE accounts ADD COLUMN billing_email text;\nUPDATE accounts SET billing_email = owner_email;\nALTER TABLE accounts ALTER COLUMN billing_email SET NOT NULL;",
  },
  {
    id: "cache",
    label: "Cache",
    title: "Permission changes do not invalidate the cache.",
    file: "src/auth/roles.ts:143",
    severity: "warn",
    status: ["warn"],
    body: "Role updates write to storage but leave the cached permission set alive, so revoked access can continue until TTL expiry.",
    before: "await roles.update(userId, nextRole)",
    after: "await roles.update(userId, nextRole)\nawait permissionCache.invalidate(userId)",
  },
  {
    id: "ci",
    label: "CI",
    title: "The release workflow runs on pull_request_target.",
    file: ".github/workflows/release.yml:3",
    severity: "error",
    status: ["error", "info"],
    body: "This workflow has publish credentials and now runs in a context that can be triggered by forked PRs. Keep release jobs on trusted push or manual dispatch events.",
    before: "on: pull_request_target",
    after: "on:\n  push:\n    branches: [main]\n  workflow_dispatch:",
  },
  {
    id: "deletion",
    label: "Deletion",
    title: "Bulk delete no longer scopes by organization.",
    file: "src/data/delete.ts:77",
    severity: "error",
    status: ["error"],
    body: "The organization predicate was removed from a destructive query. A user deleting one workspace can delete matching records in other organizations.",
    before: "where(eq(items.id, itemId))",
    after: "where(and(eq(items.id, itemId), eq(items.organizationId, orgId)))",
  },
  {
    id: "dependency",
    label: "Dependency",
    title: "Runtime dependency is loaded from user input.",
    file: "src/plugins/load.ts:19",
    severity: "warn",
    status: ["warn"],
    body: "The loader now imports a package name from request data. Restrict this to a server-owned allowlist before it reaches dynamic import.",
    before: "const plugin = await import(requestedPlugin)",
    after: "const plugin = await import(allowedPlugins[requestedPlugin])",
  },
  {
    id: "a11y",
    label: "A11y",
    title: "Dialog close control lost its accessible name.",
    file: "src/components/dialog.tsx:44",
    severity: "info",
    status: ["info"],
    body: "The icon-only close button no longer exposes a label. Screen reader users will hear an unnamed button in every modal.",
    before: "<button><XIcon /></button>",
    after: "<button aria-label=\"Close dialog\"><XIcon /></button>",
  },
];

export function ReviewExamples() {
  const [active, setActive] = useState(0);
  const [isAutoPlaying, setIsAutoPlaying] = useState(true);

  useEffect(() => {
    if (!isAutoPlaying) return;
    const timer = window.setInterval(() => {
      setActive((current) => (current + 1) % examples.length);
    }, ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [isAutoPlaying]);

  const example = examples[active] ?? examples[0];

  return (
    <div className="min-w-0 border bg-card">
      <div className="border-b p-2">
        <div className="flex gap-1 overflow-x-auto">
          {examples.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setActive(index);
                setIsAutoPlaying(false);
              }}
              className={[
                "relative shrink-0 border px-3 py-2 text-sm transition after:absolute after:inset-x-2 after:bottom-1 after:h-px after:origin-left after:bg-accent after:content-['']",
                index === active
                  ? "border-accent bg-highlight text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                index === active && isAutoPlaying ? "after:animate-[review-example-progress_4200ms_linear_forwards]" : "",
                index === active && !isAutoPlaying ? "after:scale-x-100" : "",
                index !== active ? "after:scale-x-0" : "",
              ].join(" ")}
              aria-current={index === active ? "true" : undefined}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <article className="grid min-w-0 gap-px bg-border lg:grid-cols-[0.9fr_1.1fr]">
        <div className="min-w-0 bg-card p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="font-mono text-xs text-muted-foreground">{example.file}</div>
            <StatusMark kind={example.severity} />
          </div>
          <h3 className="mt-4 text-3xl leading-tight">{example.title}</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{example.body}</p>
          <StatusLine label="status:" marks={example.status} className="mt-5 text-sm text-muted-foreground" />
        </div>
        <div className="min-w-0 bg-[#1b2329] p-5 font-mono text-xs leading-6 text-[#f7f5f1]">
          <div className="mb-3 text-[#c8cdd2]">Patch shape</div>
          <DiffPreview removed={example.before} added={example.after} />
        </div>
      </article>
      <style>{`
        @keyframes review-example-progress {
          from {
            transform: scaleX(0);
          }
          to {
            transform: scaleX(1);
          }
        }
      `}</style>
    </div>
  );
}
