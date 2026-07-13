# Postil Architecture

## Source Of Truth

- Database schema: `src/lib/db/schema.ts` and generated migrations under `drizzle/`.
- Queue semantics: `src/lib/queue.ts`; it depends on PostgreSQL row locks and `FOR UPDATE SKIP LOCKED`.
- Job execution: `src/worker/runner.ts` owns claimed-job execution shared by the long-running worker and webhook-triggered web drains.
- Hosted runtime configuration: `fly.toml` plus secrets injected by Infisical/Fly.
- Public privacy posture: `src/app/privacy/page.tsx`.
- Dataset privacy policy: the 126-PR silence-rate measurement dataset is private; only aggregate methodology and summary figures are public.
- Self-hosting and operating guidance: `src/app/docs/self-hosted/page.tsx`.

## Evaluation Data Policy

The 126-PR evaluation dataset is private. It is the silence-rate measurement
dataset and includes raw PR selection details, run logs, review envelopes, and
local measurement work product behind the public silence-rate aggregate. Public
pages may show aggregate counts, rates, confidence buckets, methodology, and
public evidence cases, but they do not publish the raw dataset, raw envelopes,
run logs, or a download path for local measurement artifacts.
Do not add scripts, routes, workflow steps, static files, or release assets
that export the dataset, its raw envelopes, or its run logs.

Public examples are separate from the private dataset. The `/evidence` page is
fed by `src/data/evidence/index.ts`, which contains curated cases from public
Postil repositories with links back to the public pull requests. That file is
the only public example-data surface and must not import, summarize, or expose
private evaluation records. Checked-in model-benchmark artifacts such as
`src/data/bench-results.json` are separate public fixtures/results and are not
part of the private 126-PR dataset.

Dataset artifacts live outside tracked source or under ignored local paths. The
repository has no workflow, route, script, or documentation path that packages
or publishes the private dataset.

## Database

Postil is PostgreSQL-native. The hosted control plane runs on Supabase Free Postgres through the Supabase connection pooler and uses enums, `jsonb`, `bytea`, identity columns, and row-lock queue claims. Cloudflare D1, Turso/libSQL, and other SQLite-style services are not drop-in replacements; adopting them requires a schema and queue rewrite.

The free-tier operating profile keeps Postgres idle-capable by avoiding permanent hot polling. Webhook intake enqueues work and can trigger a bounded web-process drain. The worker remains a fallback with configurable idle backoff.

The watchdog shares that free-tier profile: its interval is configurable so the fallback worker does not keep a scale-to-zero database warm by checking for stuck jobs every minute during idle periods.

Every queue consumer supplies its explicit supported job kinds to the claim query.
The bounded web drain and long-running worker share the handler capability list
from the queue runner; adding a handler and adding its capability are one change.
Release job kinds are also staged in PostgreSQL with an infinite `run_after` until
the deploy workflow confirms that every managed web and worker Machine is running
one image. Activation and inserts share a transaction advisory lock, so no job can
become claimable between the fleet check and capability activation.

`humanEscalation` is a GitHub-native, kind-blocking maintainer decision. The PR review
contains the grounded finding and directs the author to encode the intended behavior
in code, tests, configuration, or the pull request before pushing again. The
`postil/gate` check prevents merge until a new review resolves it. An organization
admin can record a rationale for an irreducible product decision through a secondary,
commit-scoped dashboard override. Overrides atomically enqueue a gate-state sync. Sync jobs
serialize per review, recompute the latest decision, and idempotently publish it to
the GitHub check. Severity-blocking findings require a code or configuration change
and cannot be cleared by an override.

Billing credits are append-only rows in `billing_credit_grants`, granted through `scripts/grant-billing-credit.ts` with a per-org idempotency key. `src/lib/billing-credits.ts` prices `private_hosted` usage events from the checked-in model catalog in millionths of one US dollar and computes the remaining credit balance shown on `/orgs/[slug]/billing`. Public and BYOK events remain `analytics` telemetry and never consume hosted allowance. Historical rows default to analytics because their original visibility and provider mode are not durable. The legacy whole-cent columns remain only for rolling-deploy compatibility.

Organization administrators manage the billing contact on the billing page.
New addresses remain pending until a single-use, 24-hour token is consumed;
replacements leave the existing verified address active until the new address is
verified. Link GET requests only render confirmation; a same-origin POST consumes
the token. Verification tokens are bound to the organization, purpose, and
normalized address, stored as a digest plus sealed delivery material, and sent
through durable, provider-idempotent jobs. Resends rotate the token after a
cooldown. The post-deploy release activation queues verification for every migrated
unverified contact without exposing addresses or tokens in output. Operator entitlement
updates preserve the dashboard-managed billing contact.

Private-repository product access is organization-scoped and fail-closed.
`organization_entitlements` records hosted or BYOK subscription mode, lifecycle
state, trial and past-due grace boundaries, operator promotions, verified billing
contacts, and the current-period included usage plus overage hard cap.
`src/lib/private-repository-entitlement.ts` is the single decision point used by
webhook intake and workers. The webhook stores delivery and repository metadata,
then skips review/respond queue, check, and conversational comment side effects
when a private repository is ineligible. Approval commands remain available
because they update stored control state without code fetch or inference.
Workers repeat the gate before token minting, code/config fetch, check creation,
CLI spawn, or inference. Hosted subscriptions default to zero overage; only BYOK
may omit the provider-spend cap. Public repositories bypass entitlement lookup.
Before hosted private-repository inference, the worker locks the organization
entitlement row and reserves the checked-in conservative maximum for one review
or conversational response.
Committed precise usage plus every unexpired reservation must fit within the
allowance and hard cap. Completion records one event per model attempt and
reconciles their summed provider-priced usage with the hold in one transaction.
A legacy envelope without per-model usage is priced only when its aggregate names
one catalog model; ambiguous aggregates consume the full reservation. Failure
before inference releases the hold, and abandoned holds expire after 15 minutes.
The reservation maximum is part of a hosted model
promotion: it must continue to bound the checked-in prompt, generation, fallback,
and scorer roster. Hosted responses receive a worker-owned receipt path inside
their private work directory. The CLI writes and syncs a versioned `0600` receipt
before exposing a successful answer, with aggregate and per-model token usage.
The worker runs replies without CLI-side posting, validates and prices every model
entry, then commits usage, reservation reconciliation, answer body, and delivery
state before posting to GitHub. A database lease serializes delivery. A durable
delivery job retries independently of model execution, and worker startup repairs
pending deliveries created without one. Delivery jobs retain capped-backoff retry
capacity across extended GitHub outages. A hidden comment marker lets retries
discover a comment after an ambiguous POST rather than duplicating it. Missing,
malformed, or unpriceable usage after CLI start
consumes the full reservation; only failures before CLI start release it. BYOK
spend remains provider-direct and never creates a Postil reservation or receipt.
Both review envelopes and respond receipts carry `usageAccountingComplete`.
Missing or false completeness consumes at least the full reservation while known
per-model token and price rows remain available as analytics; an unattributed
adjustment event makes committed billing equal the conservative charge.
Provider credentials do not grant product access. Operators apply the
complete entitlement state idempotently through
`scripts/set-org-entitlement.ts`; the billing page reports the stored state and
lets organization administrators set the hosted overage hard cap. BYOK billing
copy directs administrators to provider-side budgets because Postil cannot
enforce external charges. The page does not represent a payment checkout. Review rows snapshot the pull request
author GitHub ID and login supplied by the reviewable pull-request webhook.
Billing counts distinct GitHub author IDs on private pull requests within the
entitlement period; bot and service identities count by the same ID rule.

## Dashboard

The signed-in product surface is three pages, all server-rendered and
noindexed:

- `/reports` is the account home: one card per organization the user belongs
  to (silence rate, 30-day review volume, gate failures) and the most recent
  reviews across all of them.
- `/orgs/[slug]` is the organization dashboard: silence rate, confidence
  distribution, engine telemetry, recent reviews, repository review coverage
  toggles, hosted review configuration, sealed BYOK provider settings, and the
  member list with roles. Hosted inference uses operator-managed provider and
  model settings. BYOK supports OpenAI-compatible and Anthropic interfaces, a
  model cascade, and one constrained additional authentication header. Banners
  surface suspended installations and enabled
  repositories that have never completed their first review.
- `/orgs/[slug]/runs/[publicId]` renders one review from its stored envelope:
  summary, findings (severity, kind, confidence, sha-pinned GitHub file
  links), resolved findings, retained policy-suppressed findings in collapsed
  detail, suppressed/ungrounded counts, gate verdict,
  model, token usage, timing, and kind-blocking override state.

Authorization is uniform: every page and server action re-derives access from
the session. An `org_members` row grants read access; the `admin` role gates
writes (settings save, repository toggle). Rows and aggregates are always
scoped through `installations.org_id`, so an id belonging to another
organization returns 404 rather than leaking. Membership and roles mirror
GitHub: login reconciles them (`src/lib/org-sync.ts`) and backfills
organizations, installations, and repositories from the GitHub API for
installations whose webhooks predate the database
(`src/lib/github/installation-sync.ts`).

Repository config status crosses the latest completed review's recorded
`config_files` with a cached default-branch GitHub contents probe. The settings
page refreshes missing or 15-minute-old probes with four-request concurrency;
failed probes preserve the last successful file list and render as unverified.
Repository health is derived from the latest enablement and review aggregates
since that enablement. Suspended installations and repositories with any
completed review in the active enablement window do not produce first-review
warnings.

Hosted reviews resolve configuration independently per artifact. A target
repository file wins, then the owner account's installed `.github` repository,
then the organization settings form, then built-in defaults. Shared owner reads
use the same installation token as the target repository, validate immutable
owner and repository IDs, and fetch only `.postil.yaml`,
`.postil/guardrails.md`, and `.postil/content-policy.md` from one pinned
default-branch commit. A private, internal, or public source is eligible only
when the GitHub App installation includes it. Authorization or identity failures
delete the usable snapshot and return no shared policy. A transient refresh after
installation access and immutable identity validation may retain the last
successful snapshot and marks review provenance degraded. Each review revalidates
repository identity and the default-branch commit before reusing cached file
contents. A changed commit loads only slots not supplied by the target repository;
later consumers hydrate other slots against that same immutable commit. Repository
removal and App uninstall events delete the snapshot in the same transaction as
access removal. Each completed review records the effective source, repository,
commit, path, and stale state for every configuration slot. Hosted inference
removes model settings after layer resolution; BYOK may use repository or shared
model settings.
Write access to the owner `.github` default branch is organization-wide policy
administration. The source repository uses CODEOWNERS, a ruleset, and required
review to constrain policy changes.

Aggregates (silence rate, gate failures) read the denormalized `silent` and
`gate_failing` columns; `engine_gate_failing` stores the immutable CLI gate
result. Active rows in `finding_approvals` clear kind-based blockers for the
same review and head SHA, while severity blockers remain governed by the
configured severity threshold. Per-review detail reads the stored envelope
`jsonb` verbatim. The envelope is the CLI's frozen v1 output contract
(`src/lib/envelope.ts`); the dashboard renders it and never reshapes it.
The worker enables local-prevention guidance on the second revision after one
earlier completed review on the same pull request introduced an actionable
finding. Silent and operational-only reviews do not arm the hint, and repeated
prior reviews carrying the same finding do not keep rearming it. Preflight
commands come only from allowlisted scripts and standard tool manifests on the
trusted default branch; model output never supplies shell commands.

## Observability

The app exposes three layers:

- `/api/health` for cheap liveness without database access.
- `/api/health/dependencies` and `/api/metrics` for dependency and product-operation metrics.
  Overlapping 30-minute incident gauges cover operational review failures, scorer
  failures and structured reviewer/scorer fallbacks, invalid model output, and failed jobs.
  The production monitor fails on any operational, scorer, invalid-output, or failed-job
  incident, more than two scorer fallbacks, or more than five model fallbacks in that
  window without exposing provider error text.
- PostHog for traffic-source, campaign, pageview, and likely bot/automation analysis.

PostHog is configured for anonymous cookieless capture on public pages only. The browser sends pageviews, pageleave engagement, scroll depth, and Core Web Vitals through a fixed same-origin relay with person profiles, click autocapture, surveys, heatmaps, exceptions, and session replay disabled. It stores no analytics cookies or browser-persistent identifiers and honors DNT/GPC. PostHog derives a rotating daily anonymous identifier from the project, hostname, IP address, and user agent, then discards the raw IP address. Event payloads omit arbitrary query strings and protected dashboard paths.

Operational Error Tracking and OTLP Logs are separate, server-only features disabled by default. `POSTHOG_ERROR_CAPTURE=1` sends exceptions only at the Next.js request boundary, worker boot boundary, and exhausted job boundary, plus fixed model-incident classification events after successful envelope ingestion. Those events contain only phase, category, recovery, and source classifications from typed `modelIncidents` or exact CLI operational sentinel paths. `POSTHOG_LOG_CAPTURE=1` sends fixed event names and fixed outcome categories with deterministic sampling and per-process hard caps. Both paths use a fixed `postil-system` identity and reject request data, headers, cookies, account identities, repository names, prompts, diffs, source code, finding text, model output, arbitrary caller properties, raw error messages, function names, and absolute paths. Source map upload is disabled because the supported PostHog upload path includes application source content.
