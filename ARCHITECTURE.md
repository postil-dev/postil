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

Completed hosted reviews send one Brevo transactional email when their stored
envelope contains a calibrated `humanEscalation` finding at or above the gate
confidence floor. The notification targets only the organization-owned recipient
whose address has a non-null verification timestamp. New and replacement addresses
remain pending until a single-use, 24-hour token is consumed. Token digests bind the
token to the organization and normalized address; sealed token material is available
only to durable verification-email jobs. Replacing a pending address invalidates its
old token without deactivating an existing verified recipient. A durable queue job retries transient provider
failures using the public review ID as the provider idempotency key, so email
delivery cannot change review storage, comments, checks, or gate state. Queue
delivery is at-least-once: Brevo deduplicates ordinary retries, while a rare
duplicate after an extended worker outage is preferred to a lost escalation.
Verification jobs use the token digest as their provider idempotency key. The backfill
command detects matching live jobs and restores missing or exhausted jobs without
exposing addresses or token material.

Billing credits are append-only rows in `billing_credit_grants`, granted through `scripts/grant-billing-credit.ts` with a per-org idempotency key. `src/lib/billing-credits.ts` prices existing `usage_events` from the checked-in model catalog and computes the remaining credit balance shown on `/orgs/[slug]/billing`.

Private-repository product access is organization-scoped and fail-closed.
`organization_entitlements` records hosted or BYOK subscription mode, lifecycle
state, trial and past-due grace boundaries, operator promotions, billing-contact
verification, and the current-period included usage plus overage hard cap.
`src/lib/private-repository-entitlement.ts` is the single decision point used by
webhook intake and workers. The webhook stores delivery and repository metadata,
then skips review/respond queue, check, and conversational comment side effects
when a private repository is ineligible. Approval commands remain available
because they update stored control state without code fetch or inference.
Workers repeat the gate before token minting, code/config fetch, check creation,
CLI spawn, or inference. Hosted subscriptions default to zero overage; only BYOK
may omit the provider-spend cap. Public repositories bypass entitlement lookup.
Provider credentials do not grant product access. Operators apply the
complete entitlement state idempotently through
`scripts/set-org-entitlement.ts`; the billing page reports the stored state and
does not represent a payment checkout. Review rows snapshot the pull request
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
  links), resolved findings, suppressed/ungrounded counts, gate verdict,
  model, token usage, timing, and kind-blocking approval state.

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

Aggregates (silence rate, gate failures) read the denormalized `silent` and
`gate_failing` columns; `engine_gate_failing` stores the immutable CLI gate
result. Active rows in `finding_approvals` clear kind-based blockers for the
same review and head SHA, while severity blockers remain governed by the
configured severity threshold. Per-review detail reads the stored envelope
`jsonb` verbatim. The envelope is the CLI's frozen v1 output contract
(`src/lib/envelope.ts`); the dashboard renders it and never reshapes it.

## Observability

The app exposes three layers:

- `/api/health` for cheap liveness without database access.
- `/api/health/dependencies` and `/api/metrics` for dependency and product-operation metrics.
- PostHog for traffic-source, campaign, pageview, and likely bot/automation analysis.

PostHog is configured for minimal capture: browser pageviews and pageleave engagement events with autocapture and session replay disabled, plus server-side request events on public pages only. Events omit IP addresses, arbitrary query strings, and protected dashboard paths.
