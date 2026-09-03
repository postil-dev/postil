# Postil Architecture

## Source Of Truth

- Database schema: `src/lib/db/schema.ts` and generated migrations under `drizzle/`.
- Queue semantics: `src/lib/queue.ts`; it depends on PostgreSQL row locks and `FOR UPDATE SKIP LOCKED`.
- Job execution: `src/worker/runner.ts` owns claimed-job execution shared by the long-running worker and webhook-triggered web drains.
- Hosted runtime configuration: `fly.toml` plus secrets injected by Infisical/Fly.
- Private production monitoring: `src/monitor/index.ts` and `src/lib/private-monitoring.ts`.
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

Web, worker, and monitor processes use `DATABASE_URL`. The release migration subprocess
uses an optional `POSTIL_DIRECT_DATABASE_URL`, or derives the known Supabase
session-pool endpoint from a port-6543 transaction-pool URL. Only the Drizzle
child receives that value as `DATABASE_URL`; ordinary runtime connections keep
the configured pooling mode.

The free-tier operating profile keeps Postgres idle-capable by avoiding permanent hot polling when the private monitor is disabled. Webhook intake verifies the signature, then commits the payload and one `webhook-dispatch` job in the same transaction before acknowledging GitHub. A Next.js `after` callback claims that exact job without delaying the response, and the long-running worker remains a fallback with configurable idle backoff. Completed inbox payloads are cleared. A stopped web process leaves a retryable queue claim and retained payload instead of a completed dedupe marker with missing side effects.

The worker scans GitHub's App delivery summaries through a leased, cursor-paginated pass inside GitHub's three-day recovery window. It records payload-free delivery identity, event, response status, and bounded request outcome before asking GitHub to redeliver a failed attempt. A newer successful delivery closes every older failure with the same GUID. Ambiguous requests receive one delayed retry, each GUID has a three-request ceiling, and API rate-limit state pauses the shared scanner. Recovery metadata expires after 30 days; webhook payloads remain confined to the signed durable inbox.

The watchdog shares that free-tier profile: its interval is configurable so the fallback worker does not keep a scale-to-zero database warm by checking for stuck jobs every minute during idle periods. Enabling the private monitor also enables an explicit worker heartbeat and periodic database checks, so that profile intentionally generates background database traffic.

The private monitor owns the worker-interruption rehearsal control. A database-only
operator command can arm one short-lived request for the configured sandbox
organization and repository, with one exact pull request, head commit, review,
and nonce. The worker can consume the request only after the recovery review ID,
review envelope, and publication receipt are durable. Fly restarts the failed
worker process, and the monitor waits for a different worker heartbeat before it
requeues that exact recovery job. The audit row stores identities, state changes,
and before-and-after review, usage, check, and publication counts without review
content. Generic web drains and the queue watchdog exclude the rehearsal job.

The long-running worker stops claiming on `SIGINT` or `SIGTERM` and gives active
jobs a bounded drain window. Review work can be interrupted and requeued without
consuming an attempt until GitHub publication begins; its unpublished review row
is marked stale first. Publication begins before superseding or creating a check
run. From that boundary, the worker settles the review instead of force-requeueing
it. Each created check-run ID is stored immediately. Stable external IDs let the
cleanup worker reconcile an ambiguous GitHub response, complete every known
check first, and retry any check that may exist but is not visible yet. The
watchdog carries the same reconciliation identity when recovering a worker that
exits before terminal cleanup is queued.

The self-hosted Next.js server handles `SIGINT` and `SIGTERM`, stops accepting
connections, finishes in-flight requests, and waits for registered `after`
callbacks before exit. Fly gives the process a bounded termination window. A
forced exit during webhook dispatch leaves the inbox job recoverable by the
queue watchdog; completed delivery IDs remain durable dedupe records.

Every queue consumer supplies its explicit supported job kinds to the claim query.
The bounded web drain uses the latency-sensitive capability list. The long-running
worker adds maintenance jobs such as repository-rule discovery, keeping those jobs
away from request-serving processes.
The claim query also caps how many `review` and `respond` jobs one organization
runs at once, which reduces how much of the fleet a single organization opening
many pull requests occupies. Cheap kinds carry no cap, and the limit is
best-effort: concurrent claim loops read the running count independently, so an
organization can exceed it by up to the number of loops. A claim that finds only
capped work reports it as deferred rather than as an empty queue, so the poll
loop holds its interval instead of backing off toward the idle ceiling while a
ready backlog waits.
Release job kinds are also staged in PostgreSQL with an infinite `run_after` until
the deploy workflow confirms that every managed web and worker Machine is running
one image. Activation and inserts share a transaction advisory lock, so no job can
become claimable between the fleet check and capability activation.

`humanEscalation` is a GitHub-native, kind-blocking maintainer decision. The PR review
contains the grounded finding and directs the author to encode the intended behavior
in code, tests, configuration, or the pull request before pushing again.
New organizations use `postil/gate` as an advisory check. An organization admin
can enable blocking in settings. The raw CLI verdict lives in `engine_gate_failing`, while
`gate_failing` records the verdict after applying organization mode and active
finding decisions. Mode changes, approvals, and dismissals atomically enqueue
gate-state synchronization.
Publishers take a per-review database lease, lock approval and organization mode
in one order, verify the pull request head, and republish until the observed
generation is stable. A disabled gate is neutral on normal completion,
operational failure, watchdog cleanup, and finding-decision changes. Approvals
clear eligible kind blockers. Admin dismissals clear severity and kind blockers
for one non-operational finding on the reviewed commit.

Review completion keeps `postil/gate` pending until Postil reconciles its GitHub
review threads. The publisher holds the pull-request decision lock while it
derives terminal thread state from the latest stable finding occurrence,
observes and resolves the matching GitHub threads, persists those observations,
and records lifecycle completion. That durable marker queues the gate update.
The release capability parks gate jobs during fleet replacement, recovers any
receipt-backed completion that crosses the replacement boundary, and fails
closed when the lifecycle cannot be verified within its bounded recovery
budget.

A bounded worker sweep reads the effective default-branch protection and active
ruleset APIs for each enabled repository. Coverage is `required` only when
`postil/gate` is bound to this GitHub App. Any-source rules, another App, missing
permissions, malformed responses, and stale observations remain distinct or
unknown. Admission uses a scope advisory lock, GitHub rate limits continue the
same durable job at the reported reset time, and the settings page exposes a
scoped re-check with visible progress.

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

Customer notifications are immutable, organization-scoped events with a stable
producer key, bounded copy, optional organization-local action, role visibility,
and a 180-day expiry. Per-user receipts preserve the first read time. Members see
shared trial and service state; administrators also see billing and account actions.
The inbox separates unread events from retained past notifications, excludes expired
events from reads and counts, and deletes them in bounded worker batches. Trial,
subscription, GitHub App access, and customer-visible service transitions write the
event in the same database transaction as the source state change. Service events
fan out to the organizations that exist when a global disruption opens or recovers.
Operator incidents and model, provider, cost, or stack details remain outside the
customer store. Customer email batches use only the verified billing contact and
retain content-free delivery audit state. Security, payment-failure, trial-expiry,
and service-incident events queue immediately and ignore optional summary choices.
Restored, paused, and canceled subscription events enter a billing summary after a
24-hour aggregation delay when billing summaries are enabled. Provider delivery uses
one stable logical key per batch through the shared authenticated HTTPS API. An
exclusive, stale-reclaimable sending state admits one worker per batch; inbox read
state does not affect email delivery. Trial-start events are inbox-only. Service
summary email has no producer because the service ledger contains incident
transitions rather than periodic review-health events.

Private-repository product access is organization-scoped and fail-closed.
`organization_entitlements` records hosted or BYOK subscription mode, lifecycle
state, trial and past-due grace boundaries, operator promotions, verified billing
contacts, and the current-period included usage plus overage hard cap.
The first active GitHub App installation for an owner atomically inserts one
30-day trial and, when operator email is configured, a durable alert job. The
trial uses hosted inference when hosted service is enabled and BYOK otherwise.
The organization GitHub ID is the trial identity, and the entitlement survives
uninstall, so reinstalling cannot restart the trial. Alert delivery uses a
provider idempotency key and contains account and installation metadata without
repository content.
Managed release activation durably queues one provider-key lifecycle job per
eligible organization after the release becomes active. The dedicated worker
binds each OpenRouter key to the exact entitlement period and spending limit,
stores the create intent before provider access, seals the runtime credential,
and periodically reconciles renewal, BYOK changes, suspension, expiration, and
revocation. Provider access holds the same database lock as release activation,
so no provider request crosses a release-dark transition. Web processes never
claim provider-key lifecycle jobs.
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
A worker-owned loopback proxy journals deterministic large-review provider
responses before returning them to the CLI. The CLI registers one authenticated
request-inventory plan with the loopback proxy before it constructs a model
client. Unregistered provider requests fail without reaching the upstream.
The durable run identity binds the repository, pull request, base and head
commits, retry lineage, CLI release, effective configuration, complete provider
endpoint and keyed authentication identity, and coverage-plan hash. Each attempt
also binds the model, serialized request,
batch identity, and bounded attempt number. A restarted job replays a completed
response byte-for-byte, while 429, 5xx, timeout, and empty-response failures
remain subject to the CLI's bounded transient retry policy. The journal expires
after 24 hours and is deleted when the review envelope and publication receipt
are staged. The CLI applies the same schema, grounding, and publication
validation to original and replayed response bytes. The active hosted-spend
reservation is attached to the run and transferred to the replacement review
only when the source review is terminal and every retry identity component
matches. The registered plan must reproduce the stored run key before provider
access. The proxy resolves and validates the upstream once, then pins that
address while retaining TLS hostname verification for HTTPS. The loopback-only
private-base opt-in is scoped to the spawned CLI and never relaxes BYOK upstream
validation.
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
malformed, or unpriceable usage after CLI start consumes the full reservation.
A failed attempt whose completed provider responses are all durable and
replayable retains its hold for the exact retry. Ambiguous provider contact
reconciles the logical run conservatively once and makes that run non-resumable,
so the settled retry lineage cannot bill or contact the provider again while its
journal identity exists. BYOK spend remains provider-direct and never creates a
Postil reservation or receipt.
Review envelopes preserve the CLI's coverage plan, admission bound, and
`usageAccountingComplete`; respond receipts carry the same accounting-completeness
signal.
Missing or false completeness consumes at least the full reservation while known
per-model token and price rows remain available as analytics; an unattributed
adjustment event makes committed billing equal the conservative charge.
Provider credentials do not grant product access. Operators can apply the
complete post-trial entitlement state idempotently through
`scripts/set-org-entitlement.ts`, including the hosted overage hard cap. The
billing page reports plan and provider state. BYOK billing copy directs
administrators to provider-side budgets because Postil cannot enforce external
charges. Before
a private review row can run, the worker resolves the pull request's author ID,
login, head, and base from GitHub. A rollout-activated database trigger rejects
anonymous active reviews and makes the recorded author identity immutable.
Historical rows remain unknown rather than receiving a guessed identity.
Billing counts distinct GitHub author IDs on private pull requests within the
entitlement period; bot and service identities count by the same ID rule.

## GitHub Conversations

The durable webhook inbox owns delivery deduplication and retries. During
dispatch, response admission serializes the source-delivery check, indexed
rolling-hour limit, and response-job insert. A separate idempotent reaction job
acknowledges accepted collaborator comment requests before model work.
Gratitude-only comments receive a thumbs-up without inference.

An unmentioned reply in a review thread is eligible only when its root comment
belongs to the configured GitHub App and its text is a bounded question or
clarification. The response job carries bounded Postil-authored thread context
and the root review-comment ID. Success and terminal-failure delivery remain in
that thread. Each new delivery includes a random marker plus the legacy job
marker for rolling compatibility. Ambiguous GitHub responses reconcile only
against markers authored by the configured App. Other unmentioned text,
bot-authored events, unauthorized actors, overlong input, and requests above
the installation cap remain silent.

Self-service BYOK billing uses Paddle as merchant of record and remains inert
unless `POSTIL_PADDLE_BILLING_ENABLED=1` and the complete process-specific
configuration passes startup validation. Organization admins create one
server-side transaction and open Paddle's overlay checkout with a client token;
the browser never receives an API key. Checkout attempts carry a durable ID in
provider custom data. An uncertain create call is reconciled against provider
transactions before another attempt is admitted. Verified webhook events
project the provider subscription into local entitlement state with event-ID deduplication,
out-of-order rejection, and a content-free receipt. A closed provider period
stores one immutable distinct-author count. A settlement job submits one catalog
charge after placing the settlement ID in subscription custom data, which Paddle
copies to the resulting transaction. Reconciliation requires that exact ID. An
ambiguous provider outcome enters reconciliation and never retries the charge. Failed or
stale settlements, unmatched provider events, and subscription lifecycle changes
feed operator email and production metrics.

Each review snapshots a closed trigger class and its signed-webhook context at
creation: automatic pull-request event, explicit review command, GitHub check
rerun, or unknown. Historical rows and rolling-deploy jobs without evidence use
unknown; the system does not infer an origin. A database trigger makes review
provenance immutable. Usage events copy the trigger class so billing attribution
survives removal of the related repository or review row. Conversational replies
remain `respond` jobs, record their GitHub mention context in the job payload,
and use the separate `github_mention` usage class.

Published review findings have a separate durable lifecycle. CLI publication
receipts bind each review and stable finding ID to its initial channel and
GitHub review/comment identities. The initial record is immutable. Later
envelopes can mark the same stable finding carried, resolved, or suppressed;
GitHub review-thread flags can mark line-level and file-level review comments
resolved, outdated, or deleted. Comment prose, reactions, and dismissed reviews
do not change finding state. Reviews produced by a CLI without the receipt
contract record their unobserved findings as `unknown`. Dashboard publication
counts and confidence metrics read this normalized state instead of assuming
every envelope finding reached the pull request. Receipts store finding
identities, GitHub object identifiers, and lifecycle states only. They do not
store comment prose or provider payloads, and dashboard rendering uses the same
organization authorization boundary as the review envelope.

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
- `/orgs/[slug]/runs/[publicId]` renders one review from its stored envelope and publication receipt:
  summary, findings (severity, kind, confidence, sha-pinned GitHub file
  links), resolved findings, retained policy-suppressed findings in collapsed
  detail, suppressed/ungrounded counts, gate verdict,
  model, token usage, timing, immutable trigger provenance, and commit-scoped
  approval or dismissal state. Dismissals show their structured reason,
  rationale, actor, and author-self-dismissal audit flag. The recent-review table exposes the same trigger class and
  includes it in text filtering.

Authorization is uniform: every page and server action re-derives access from
the session. A sealed GitHub OAuth credential refreshes the complete active
organization membership set every 15 minutes during the seven-day session.
Refreshes use a database lease, revoke removed memberships, apply role changes,
and fail closed without deleting known membership state when GitHub is
unavailable. An `org_members` row grants read access; the `admin` role gates
writes. Rows and aggregates are scoped through `installations.org_id`, so an id
belonging to another organization returns 404. Sign-in also synchronizes known
GitHub App installations (`src/lib/github/installation-sync.ts`).

GitHub finding-decision commands authorize independently from dashboard sessions. The
signed webhook identifies the actor, and the installation token reads that
actor's live organization membership before an approval or dismissal is stored.
Dashboard dismissal and revocation actions perform the same live check. The response
must bind the expected user and organization identities and report an active
`role=admin`. Missing, ambiguous, stale, or unavailable membership data fails
closed. Personal-account installations bind the actor to the installed account
id. The decision record snapshots the actor and rationale against the reviewed
commit and finding. Dismissals also retain their structured reason and whether
the pull request author performed the action. The durable webhook delivery id
prevents replay.

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

Aggregates (silence rate, effective gate failures) read the denormalized `silent`
and `gate_failing` columns; `engine_gate_failing` stores the immutable CLI gate
result independently of organization mode. Active approval rows in
`finding_approvals` clear eligible kind blockers for the same review and head
SHA. Active dismissal rows clear both blocker classes for one non-operational
finding. Per-review detail reads the stored envelope
`jsonb` verbatim. The envelope is the CLI's frozen v1 output contract
(`src/lib/envelope.ts`); the dashboard renders it and never reshapes it.
`large_review_runs` and `large_review_attempts` contain the bounded, expiring
resume journal. They store provider response envelopes for replay but never
store credentials or request headers. Provider authentication contributes only
a keyed digest to the run identity.
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
- PostHog for traffic-source, campaign, pageview, and likely bot/automation analysis.

Production monitoring runs in a dedicated process group. PostgreSQL owns its
lease, pass ledger, process heartbeats, incident state, and notification outbox.
The monitor probes the public origin and reads operational state directly from
PostgreSQL, so a dead review worker cannot suppress queue, check-run, signup,
billing, email, webhook, or provider incident detection. Incident notifications
use the shared operator-notification transport directly instead of the review
job queue. A database-outage alert bypasses the incident outbox and uses a
time-bucketed provider idempotency key. One monitor process stores the last
sent outage bucket and timestamp in a bounded, atomically replaced file on a
monitor-only persistent volume. The file is fsynced before replacement is
acknowledged. Missing, expired, or invalid state enables delivery instead of
suppressing an alert. Monitoring state and target details are visible only on
the operator dashboard. Active incidents and retained resolved alerts use separate
operator-only views. Alert messages identify the affected capability, state, first
and last observation, bounded evidence, and the recommended operator action.
The monitor uses a non-inference OpenRouter management credential to read
account credits and paginated key metadata. Account-wide credit depletion and
each review key's daily-cap depletion are separate incidents. The configured
outage threshold defaults to the maximum hosted review reservation. The
emergency production key has its own daily cap; its enabled state and zero
lifetime, period, and BYOK usage are checked without retrieving or storing its
value. These incidents use the same PostgreSQL history and external alerting path and
never publish to GitHub. Missing, malformed, or rejected
OpenRouter monitoring configuration opens one private configuration incident;
all non-OpenRouter monitor checks continue and service deployment remains
available. The bearer-protected metrics endpoint exposes aggregate
monitor-heartbeat age and freshness gauges for an external dead-man alarm. The
scheduled GitHub monitor is an independent check of public reachability and
aggregate operational metrics without receiving private monitor targets.

Alert delivery for monitoring is owned by ilert, an external alerting service:
the platform and the GitHub monitor report events to an alert source
(`ILERT_INTEGRATION_KEY`), and ilert owns paging, escalation, deduplication by
incident key, and auto-close on resolve events. The platform never pages the
operator by its own email path for monitoring; operator email remains for
business lifecycle and billing notifications only. After each completed pass
the monitor pings an ilert heartbeat (`POSTIL_MONITOR_HEARTBEAT_URL`), so a
dead monitor process or persistently failing pass raises a missed-heartbeat
alert outside the platform's failure domain. Without a configured integration
key, monitoring alerts are logged only and paging relies on the heartbeat, the
external uptime checks, and the GitHub monitor.

iLert alert actions can deliver bounded alert lifecycle events to
`/api/webhooks/ilert` with HTTP Basic authentication. The receiver stores the
validated operator metadata and a raw-payload digest in PostgreSQL, deduplicates
by iLert event id, and publishes the committed sequence through PostgreSQL
`NOTIFY`. `/api/operator/alerts/stream` replays committed sequences and then
uses a dedicated session-capable `LISTEN` connection for SSE delivery. A known
Supabase port-6543 transaction-pool URL is converted to its port-5432 session
endpoint for that connection only; ordinary runtime queries retain transaction
pooling. The stream requires a
renewable CLI bearer token and the separate `POSTIL_OPERATOR_GITHUB_IDS`
allowlist. Transport keepalives do not query alert state. The receiver and
stream make no outbound iLert API calls and cannot acknowledge, accept, or
resolve an alert.

The production-monitor workflow loads the workflow-only `ILERT_API_KEY`
management bearer credential through its dedicated least-privilege Infisical
OIDC identity and sends monitor and canary events with the
`ILERT_INTEGRATION_KEY` Event API credential. The management credential is not
part of the application environment. Its
`POSTIL_ILERT_ALERT_SOURCE_ID` GitHub Actions variable selects the alert source
whose action is reconciled. `POSTIL_ILERT_WEBHOOK_SECRET` supplies the receiver
password embedded as URL-encoded HTTP Basic credentials in that action, and
`POSTIL_ILERT_RECEIVER_ORIGIN` selects its strictly validated HTTPS origin. The
deployment and reconciliation workflows load the receiver password from one
secret record. Reconciliation verifies that the deployed receiver accepts the
credential before it creates or updates the action. Before any action mutation
or Event API mutation, reconciliation reads `GET /api/alert-sources/{id}` with
the URL-encoded Event API integration key and the management bearer credential.
The returned numeric source id and Event API type must match the configured
source. The key, management authorization, integration fields, and full lookup
URL remain confined to the sensitive request. Manual canaries send a
HIGH-priority production test alert that can invoke the escalation path. They
use attempt-specific keys derived from the workflow run id and producer run
attempt, distinct from production monitor keys. Earlier main keys are swept
through the current attempt and every discovered open alert is resolved with
`PUT /api/alerts/{id}/resolve` then polled by that exact id until management
reports RESOLVED. Open inventory requests PENDING and ACCEPTED states at the
server, while accepted-current proof uses a separate bounded all-state lookup.
A blind same-key Event API RESOLVE is limited to an undiscovered current key.
The main alert is discovered within the configured
source using a report-time window whose upper bound follows successful Event API
acceptance. It must remain PENDING or ACCEPTED at HIGH priority and have an
exact persisted `alert-created` receiver event. A `cleaned` handoff means the
primary canary also proves the exact persisted `alert-resolved` receiver event.
The independent cleanup-only finalizer uses the producer attempt for
accepted-current proof and the running attempt as a sweep ceiling. It accepts
GitHub's 1 through 51 attempt range, bounds work per attempt, uses
continuity-checked overlapping pages for mutable open-alert inventory, performs
delayed consecutive terminal discoveries that each complete empty before
success, and
verifies every retained id as RESOLVED. A cleaned handoff still performs this
management sweep to resolve a delayed Event API duplicate. If the producer
output is unavailable, the finalizer uses its running attempt to reconstruct
the deterministic identity. It never reads receiver configuration or
reconciles the action. The
command supports `--dry-run`,
`--canary`, and `--finalize-canary`; unflagged live reconciliation is rejected
because it has no recoverable run identity. The canary does not open the
authenticated operator SSE stream.

The monitor and product processes share the deployment platform, network, and
DNS path. The private database, the external alerting service, and the
external metrics collector are separate dependencies. A platform-wide or
network-wide outage can prevent the in-platform monitor from sending, so the
missed ilert heartbeat and the external collector alarm on a missing scrape or
stale aggregate heartbeat.
PostHog operational telemetry is a separate private signal for process failures
when enabled; it is not the source of incident state or alert deduplication.

PostHog is configured for anonymous cookieless capture on an exact allowlist of public pages. The browser sends pageviews, pageleave engagement, scroll depth, and Core Web Vitals through a fixed same-origin relay with person profiles, click autocapture, surveys, heatmaps, exceptions, and session replay disabled. It stores no analytics cookies or browser-persistent identifiers and honors DNT/GPC. PostHog derives a rotating daily anonymous identifier from the project, hostname, IP address, and user agent, then discards the raw IP address. Cookieless ingestion drops any event that omits one of those hash inputs, so browser events report the user agent. Browser event payloads are rebuilt from an allowlist that keeps the public path, bounded campaign labels, referrer origin, the user agent, numeric engagement metrics, and numeric Web Vitals. Query strings, persistent device or session identifiers, arbitrary SDK properties, and protected dashboard paths are discarded.

## Transactional email

Billing-contact verification, account, installation, billing, and service-monitor
messages share one typed content model and one HTML plus plain-text renderer. The
application permits one HTTPS action URL and rejects remote-content capabilities
before sending. The renderer uses live text, email-safe tables, inline styles,
responsive rules, dark-mode colors, and Outlook-compatible button padding. Local
previews cover every production message type.

Delivery uses Brevo's transactional email API as an authenticated HTTPS REST
call to `https://api.brevo.com/v3/smtp/email` with provider idempotency. The
`smtp` path segment is Brevo's API naming; Postil does not use SMTP transport.
Production callers use one provider-neutral send function. A Brevo adapter owns
the endpoint, authentication, idempotency translation, and response handling,
so product and operator message code contains no provider-specific behavior.
Stable logical delivery keys become deterministic UUIDs for Brevo's 30-minute
idempotency window. The five-attempt queue schedule and ten-minute watchdog
reclaim fit inside that window during normal operation. Brevo's anonymous
transactional-email tracking and log retention are account-level operator
settings. Anonymous tracking retains aggregate unique open and click counts
without linking them to a contact. The send API has no per-message tracking
override, so delivery remains available when a stricter provider setting is not
available. A provider acceptance followed by more than 30 minutes without any
worker or watchdog completion can produce a duplicate retry because Brevo does
not expose an idempotency-key lookup; delivery remains at-least-once in that
outage mode.

Operational Error Tracking and OTLP Logs are separate, server-only features disabled by default. `POSTHOG_ERROR_CAPTURE=1` sends exceptions only at the Next.js request boundary, worker boot boundary, and exhausted job boundary, plus fixed model-incident classification events after successful envelope ingestion. Those events contain only phase, category, recovery, and source classifications from typed `modelIncidents` or exact CLI operational sentinel paths. `POSTHOG_LOG_CAPTURE=1` sends fixed event names and fixed outcome categories with deterministic sampling and per-process hard caps. Both paths use a fixed `postil-system` identity and reject request data, headers, cookies, account identities, repository names, prompts, diffs, source code, finding text, model output, arbitrary caller properties, raw error messages, function names, and absolute paths. Source map upload is disabled because the supported PostHog upload path includes application source content.
