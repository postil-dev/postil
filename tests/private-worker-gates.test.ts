import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("private repository worker defense in depth", () => {
  test("review worker gates entitlement before token access and terminalizes provider mismatches", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const installationSync = readFileSync(
      "src/lib/github/installation-sync.ts",
      "utf8",
    );
    const gate = source.indexOf(
      "await canProcessRepositoryInference",
      source.indexOf("runReviewJob"),
    );
    expect(gate).toBeGreaterThan(0);
    const authorLookup = source.indexOf("getPullRequestReviewContext", gate);
    expect(authorLookup).toBeGreaterThan(gate);
    expect(source).toContain("authorGithubId: authorGithubId");
    expect(source).toContain("authorLogin: authorLogin");
    for (const sideEffect of [
      "insert(schema.reviews)",
      "await getInstallationToken",
      "await createCheckRun",
      "await materializeRepoConfig",
      "await runCli",
    ]) {
      expect(
        source.indexOf(sideEffect, source.indexOf("runReviewJob")),
      ).toBeGreaterThan(gate);
    }
    const providerMode = source.indexOf(
      "providerModeMatchesRepositoryAccess",
      gate,
    );
    const checkCreation = source.indexOf(
      "advisoryCheckRunId = await createCheckRun",
      gate,
    );
    const providerFailure = source.indexOf(
      "if (!providerModeMatches)",
      checkCreation,
    );
    expect(providerMode).toBeGreaterThan(
      source.indexOf("fetchRepositorySummary", gate),
    );
    expect(providerFailure).toBeGreaterThan(checkCreation);
    expect(providerFailure).toBeLessThan(source.indexOf("await runCli", gate));
    expect(
      source.slice(providerFailure, source.indexOf("await runCli", gate)),
    ).toContain("configured provider mode does not match");
    expect(source.indexOf("fetchRepositorySummary", gate)).toBeLessThan(
      source.indexOf("insert(schema.reviews)", gate),
    );
    expect(authorLookup).toBeLessThan(
      source.indexOf("insert(schema.reviews)", gate),
    );
    expect(authorLookup).toBeLessThan(
      source.indexOf("await reserveHostedReviewSpend", gate),
    );
    expect(authorLookup).toBeLessThan(source.indexOf("await runCli", gate));
    expect(
      source.slice(
        authorLookup,
        source.indexOf("const baseline", authorLookup),
      ),
    ).toContain("private review author identity is unavailable");
    expect(installationSync).toContain(
      "AbortSignal.any([signal, AbortSignal.timeout(10_000)])",
    );
    expect(installationSync).toContain('subscriptionMode: "hosted"');
    expect(installationSync).not.toContain("actorIdentityVerified");
    expect(installationSync).toContain(
      "initiatedByGithubId !== undefined",
    );
    expect(installationSync).toContain("initiatedByGithubId,");
    expect(installationSync).not.toContain(
      "initiatedByGithubId: initiatedByGithubId ?? account.id",
    );

    const runner = readFileSync("src/worker/runner.ts", "utf8");
    expect(runner).toContain("isPermanentJobError(err)");
    expect(runner).not.toContain("err instanceof PermanentJobError");

    const failureCatch = source.indexOf(
      "err instanceof TerminalReviewError ||",
      providerFailure,
    );
    expect(failureCatch).toBeGreaterThan(providerFailure);
    expect(source.slice(providerFailure, failureCatch)).toContain(
      "await failCheckRuns",
    );
  });

  test("private author enforcement activates only after the managed fleet replacement", () => {
    const deploy = readFileSync(".github/workflows/deploy.yml", "utf8");
    const activation = readFileSync("scripts/activate-release-jobs.ts", "utf8");
    const deactivation = readFileSync(
      "scripts/deactivate-hosted-inference.ts",
      "utf8",
    );
    expect(deploy.indexOf("Deploy managed fleet")).toBeLessThan(
      deploy.indexOf(
        "Verify and activate release capabilities after fleet replacement",
      ),
    );
    expect(activation).toContain("activatePrivateReviewAuthorIdentity");
    expect(activation.indexOf("activatePublicationLifecycleRelease")).toBeLessThan(
      activation.indexOf("activateReleaseJobs"),
    );
    expect(deactivation).toContain("deactivatePublicationLifecycleRelease");
  });

  test("disabled hosted inference stops before reservation, config fetch, or CLI spawn", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const claimSource = readFileSync("src/lib/hosted-review-pause.ts", "utf8");
    const start = source.indexOf("export async function runReviewJob");
    const mode = source.indexOf("const hostedReviewUnavailable =", start);
    const gate = source.indexOf("if (hostedReviewUnavailable)", mode);
    const token = source.indexOf(
      "getInstallationToken(payload.installationId",
      mode,
    );
    const reservation = source.indexOf("await reserveHostedReviewSpend", start);
    const materialization = source.indexOf(
      "await materializeRepoConfig",
      start,
    );
    const cli = source.indexOf("await runCli", start);
    const versionProbe = source.indexOf("postilCliVersionLogLine()", start);

    expect(mode).toBeGreaterThan(start);
    expect(gate).toBeGreaterThan(mode);
    expect(gate).toBeLessThan(token);
    expect(source.slice(gate, token)).toContain("claimPausedHostedReview");
    expect(source.slice(gate, token)).toContain("return;");
    expect(claimSource).toContain("pg_advisory_xact_lock");
    expect(claimSource).toContain("HOSTED_REVIEW_UNAVAILABLE_MESSAGE");
    expect(claimSource.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      claimSource.indexOf("insert(schema.reviews)"),
    );
    expect(versionProbe).toBeGreaterThan(gate);
    expect(reservation).toBeGreaterThan(gate);
    expect(materialization).toBeGreaterThan(gate);
    expect(cli).toBeGreaterThan(gate);
    const guardBody = source.slice(gate, token);
    expect(guardBody).toContain("checkRunsMayExist: false");
    expect(claimSource).toContain('kind: "check-run-cleanup"');
    expect(claimSource).toContain('intent: "neutralize"');
    expect(claimSource).toContain("db.transaction");
    expect(claimSource.lastIndexOf("insert(schema.jobs)")).toBeGreaterThan(
      claimSource.indexOf("insert(schema.reviews)"),
    );
    expect(guardBody).toContain("return;");
    expect(guardBody).not.toContain("getInstallationToken");
    expect(guardBody).not.toContain("createCheckRun");
    expect(guardBody).not.toContain("postReview");
    expect(guardBody).not.toContain("failCheckRuns");
  });

  test("release-dark publication lifecycle stops every review before recovery or forge access", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const start = source.indexOf("export async function runReviewJob");
    const lifecycleGate = source.indexOf(
      "await publicationLifecycleReleaseActivated(getPool())",
      start,
    );
    const recovery = source.indexOf("await resumeStagedReviewCompletion", start);
    const token = source.indexOf("getInstallationToken(payload.installationId", start);

    expect(lifecycleGate).toBeGreaterThan(start);
    expect(lifecycleGate).toBeLessThan(recovery);
    expect(lifecycleGate).toBeLessThan(token);
    expect(source.slice(lifecycleGate, recovery)).toContain(
      "throw new HostedInferenceReleaseDarkError(releaseSha)",
    );
  });

  test("publication lifecycle exclusion uses transaction-scoped advisory locks", () => {
    const rollout = readFileSync("src/lib/release-job-rollout.ts", "utf8");
    const sharedStart = rollout.indexOf(
      "export async function withPublicationLifecycleReleaseActive",
    );
    const sharedEnd = rollout.indexOf(
      "export async function deactivatePublicationLifecycleRelease",
      sharedStart,
    );
    const activationStart = rollout.indexOf(
      "export async function activatePublicationLifecycleRelease",
    );
    const activationEnd = rollout.indexOf(
      "function normalizedReleaseSha",
      activationStart,
    );
    const decisions = readFileSync("src/lib/finding-approvals.ts", "utf8");
    const database = readFileSync("src/lib/db-transaction.ts", "utf8");
    const lifecycleLock = readFileSync(
      "src/lib/publication-lifecycle-lock.ts",
      "utf8",
    );
    const exclusiveLockStart = rollout.indexOf(
      "async function lockPublicationLifecycleExclusive",
    );
    const exclusiveLockEnd = rollout.indexOf(
      "export class PublicationLifecycleReleaseDarkError",
      exclusiveLockStart,
    );
    const deactivationStart = rollout.indexOf(
      "export async function deactivatePublicationLifecycleRelease",
    );
    const deactivationEnd = rollout.indexOf(
      "async function darkenPublicationLifecycle",
      deactivationStart,
    );
    const decisionStart = decisions.indexOf(
      "export async function withReviewDecisionScopeLock",
    );
    const decisionEnd = decisions.indexOf(
      "export async function lockReviewDecisionScopeById",
      decisionStart,
    );

    const shared = rollout.slice(sharedStart, sharedEnd);
    const activation = rollout.slice(activationStart, activationEnd);
    const exclusiveLock = rollout.slice(exclusiveLockStart, exclusiveLockEnd);
    const deactivation = rollout.slice(deactivationStart, deactivationEnd);
    const decision = decisions.slice(decisionStart, decisionEnd);
    expect(lifecycleLock).toContain("pg_advisory_xact_lock_shared");
    expect(shared).toContain("withPinnedDatabaseTransaction");
    expect(shared).toContain("lockPublicationLifecycleShared(transaction)");
    expect(shared).toContain("operation(transaction, client)");
    expect(shared).not.toContain("drizzle(pool");
    expect(shared).not.toContain("pg_advisory_lock_shared");
    expect(shared).not.toContain("pg_advisory_unlock_shared");
    expect(activation).toContain("lockPublicationLifecycleExclusive(client)");
    expect(exclusiveLock).toContain("pg_advisory_xact_lock");
    expect(exclusiveLock).not.toContain("pg_try_advisory_xact_lock");
    expect(exclusiveLock).toContain("PUBLICATION_LIFECYCLE_LOCK_TIMEOUT_MS");
    expect(exclusiveLock).toContain("set_config('lock_timeout', $1, true)");
    expect(exclusiveLock).toContain("ROLLBACK TO SAVEPOINT");
    expect(exclusiveLock).not.toContain("pg_terminate_backend");
    expect(rollout).toContain(
      "waitForLegacyPublicationLifecycleOperations(client)",
    );
    expect(
      deactivation.indexOf("waitForLegacyPublicationLifecycleOperations(client)"),
    ).toBeLessThan(
      deactivation.indexOf("lockPublicationLifecycleExclusive(client)"),
    );
    expect(rollout).toContain("kind = 'gate-state-sync'");
    expect(rollout).toContain("status = 'running'");
    expect(exclusiveLock).not.toContain("pg_stat_activity");
    expect(exclusiveLock).toContain("publication lifecycle lock did not quiesce");
    expect(activation).toContain("client.release(releaseError)");
    expect(activation).not.toContain('query("ROLLBACK").catch');
    expect(activation).not.toContain("pg_advisory_unlock");
    expect(decision).toContain("withPinnedDatabaseTransaction");
    expect(decision).toContain("lockPublicationLifecycleShared(transaction)");
    expect(decision).toContain("lockReviewDecisionScopeById");
    expect(decision.indexOf("lockPublicationLifecycleShared(transaction)")).toBeLessThan(
      decision.indexOf("lockReviewDecisionScopeById"),
    );
    expect(decision).not.toContain("pg_advisory_lock(");
    expect(decision).not.toContain("pg_advisory_unlock(");
    expect(database).toContain("clientDatabase.transaction");
    expect(database).toContain("client.release(releaseError)");
    expect(database).toContain("bodyFailed && error === bodyError");
  });

  test("respond honors entitlement and release activation before tokens or provider access", () => {
    const source = readFileSync("src/worker/respond.ts", "utf8");
    const start = source.indexOf("export async function runRespondJob");
    const entitlement = source.indexOf(
      "await canProcessRepositoryInference",
      start,
    );
    const providerMode = source.indexOf(
      "providerModeMatchesRepositoryAccess",
      entitlement,
    );
    const activation = source.indexOf(
      "await hostedInferenceAvailable(getPool())",
      providerMode,
    );
    const token = source.indexOf("await getInstallationToken", start);
    const reservation = source.indexOf(
      "await reserveHostedRespondSpend",
      start,
    );
    const cli = source.indexOf("await runCli", start);

    expect(entitlement).toBeGreaterThan(start);
    expect(providerMode).toBeGreaterThan(entitlement);
    expect(activation).toBeGreaterThan(providerMode);
    expect(activation).toBeLessThan(token);
    expect(activation).toBeLessThan(reservation);
    expect(activation).toBeLessThan(cli);
    expect(source.slice(activation, token)).toContain("return;");
  });

  test("hosted reservation denial leaves durable forge-visible terminal checks", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const start = source.indexOf("export async function runReviewJob");
    const reservation = source.indexOf("await reserveHostedReviewSpend", start);
    const denial = source.indexOf(
      "if (spendReservation && !spendReservation.allowed)",
      reservation,
    );
    const denialEnd = source.indexOf("hostedUsageReservationId =", denial);
    const denialBody = source.slice(denial, denialEnd);

    expect(
      source.lastIndexOf("await createCheckRun", reservation),
    ).toBeGreaterThan(start);
    expect(
      source.lastIndexOf("await createCheckRun", reservation),
    ).toBeLessThan(reservation);
    expect(
      source.lastIndexOf("postilCliVersionLogLine()", reservation),
    ).toBeLessThan(reservation);
    expect(denialBody).toContain("db.transaction");
    expect(denialBody).toContain('kind: "check-run-cleanup"');
    expect(denialBody).toContain('intent: "fail"');
    expect(denialBody).toContain("detailsUrl");
    expect(denialBody).toContain("returning({ id: schema.reviews.id })");
    expect(denialBody).toContain("if (failedRows.length === 0) return false");
    expect(denialBody).toContain("if (settled)");
    expect(denialBody).toContain("await failCheckRuns");
    expect(denialBody.indexOf("db.transaction")).toBeLessThan(
      denialBody.indexOf("await failCheckRuns"),
    );
    expect(denialBody).toContain("return;");
    expect(denialBody).not.toContain("await runCli");
  });

  test("hosted review explicitly authorizes CLI publication", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const reviewStart = source.indexOf("export async function runReviewJob");
    const argsStart = source.indexOf(
      'const args = [\n      "review"',
      reviewStart,
    );
    const argsEnd = source.indexOf("];", argsStart);
    const args = source.slice(argsStart, argsEnd);

    expect(argsStart).toBeGreaterThan(reviewStart);
    expect(args.indexOf('"--publish"')).toBeGreaterThan(
      args.indexOf('"github"'),
    );
    expect(args.indexOf('"--defer-gate-check"')).toBeGreaterThan(
      args.indexOf('"--publish"'),
    );
    expect(args.indexOf('"--defer-gate-check"')).toBeLessThan(
      args.indexOf('"--repo"'),
    );
    expect(args.indexOf('"--publish"')).toBeLessThan(args.indexOf('"--repo"'));
    expect(args).not.toContain('"--no-post"');
  });

  test("hosted publication is bound to the stored GitHub repository id", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const reviewStart = source.indexOf("export async function runReviewJob");
    const envStart = source.indexOf("const cliEnv = buildCliEnv", reviewStart);
    const envEnd = source.indexOf("});", envStart);
    const cliEnv = source.slice(envStart, envEnd);

    expect(cliEnv).toContain(
      "POSTIL_EXPECTED_GITHUB_REPO_ID: String(repository.githubRepoId)",
    );
    expect(cliEnv).not.toContain("payload.githubRepoId");
  });

  test("hosted review terminalizes before publishing the exact gate verdict", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const reviewStart = source.indexOf("export async function runReviewJob");
    const cliCompletion = source.indexOf(
      "const result = await runCli",
      reviewStart,
    );
    const staging = source.indexOf(
      "const staged = await stageReviewCompletionCandidate",
      cliCompletion,
    );
    const verification = source.indexOf("verifyCompletedCheckRun", staging);
    const finalization = source.indexOf(
      "const completion = await finalizeStagedReviewCompletionWithGateMode",
      verification,
    );
    const lifecycleReconciliation = source.indexOf(
      "const observationCount = await reconcileReviewPublicationLifecycle",
      finalization,
    );
    const gatePublication = source.indexOf(
      'reviewLog.line("durable gate synchronization queued from stored review truth")',
      lifecycleReconciliation,
    );
    const lifecycleHelperStart = source.indexOf(
      "async function reconcileReviewPublicationLifecycle",
    );
    const lifecycleHelperEnd = source.indexOf(
      "export async function resumeStagedReviewCompletion",
      lifecycleHelperStart,
    );
    const lifecycleHelper = source.slice(lifecycleHelperStart, lifecycleHelperEnd);

    expect(staging).toBeGreaterThan(cliCompletion);
    expect(verification).toBeGreaterThan(staging);
    expect(finalization).toBeGreaterThan(verification);
    expect(lifecycleReconciliation).toBeGreaterThan(finalization);
    expect(gatePublication).toBeGreaterThan(lifecycleReconciliation);
    expect(lifecycleHelper).toContain("withReviewDecisionScopeLock");
    expect(lifecycleHelper.indexOf("applyPublicationThreadObservations")).toBeLessThan(
      lifecycleHelper.indexOf("completeReviewPublicationLifecycle"),
    );
    expect(source.slice(staging, finalization)).toContain(
      'reviewLog.line("review result and publication receipt staged durably")',
    );
    expect(source.slice(verification, finalization)).toContain(
      'reviewLog.line("forge advisory check-run verified completed by the CLI")',
    );
    expect(source.slice(verification, finalization)).toContain(
      '"GitHub review publication could not be verified"',
    );
    expect(source.slice(verification, finalization)).toContain(
      "{ cause: error }",
    );
    expect(source.slice(finalization, lifecycleReconciliation)).toContain(
      "queueGateStateSync: false",
    );
    expect(source.slice(lifecycleReconciliation, gatePublication)).toContain(
      'triggerQueueDrain("gate-state-sync")',
    );
  });

  test("publication recovery retries the exact gate after database completion", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const recoveryStart = source.indexOf(
      "async function resumeStagedReviewCompletion",
    );
    const recoveryEnd = source.indexOf("export async function runReviewJob", recoveryStart);
    const recovery = source.slice(recoveryStart, recoveryEnd);

    expect(recovery).toContain('stagedReview.status !== "running"');
    expect(recovery).toContain('stagedReview.status !== "completed"');
    expect(recovery).toContain('if (stagedReview.status === "running")');
    expect(recovery).toContain("queueGateStateSync: false");
    expect(recovery).toContain("await reconcileReviewPublicationLifecycle");
    expect(recovery).toContain('triggerQueueDrain("gate-state-sync")');
    expect(recovery).toContain("const detailsUrl = reviewDetailsUrl(");
    expect(recovery).toContain("stagedReview.publicId");
    expect(recovery).not.toContain("await completeExpectedCheckRun");
  });

  test("advisory organizations derive a neutral exact gate verdict", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const reviewStart = source.indexOf("export async function runReviewJob");
    const staging = source.indexOf(
      "const staged = await stageReviewCompletionCandidate",
      reviewStart,
    );
    const finalization = source.indexOf(
      "const completion = await finalizeStagedReviewCompletionWithGateMode",
      staging,
    );
    const gatePublication = source.indexOf(
      'triggerQueueDrain("gate-state-sync")',
      finalization,
    );

    expect(staging).toBeGreaterThan(reviewStart);
    expect(finalization).toBeGreaterThan(staging);
    expect(gatePublication).toBeGreaterThan(finalization);
    expect(source.slice(finalization, gatePublication)).not.toContain(
      "completeExpectedCheckRun",
    );
  });

  test("operational review failures durably queue terminal check cleanup", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const catchStart = source.indexOf(
      "  } catch (err) {",
      source.indexOf(
        'reviewLog.line("durable gate synchronization queued from stored review truth")',
        source.indexOf("export async function runReviewJob"),
      ),
    );
    const catchEnd = source.indexOf("} finally {", catchStart);
    const failureBody = source.slice(catchStart, catchEnd);

    expect(failureBody).toContain("err instanceof WorkerShutdownError");
    expect(failureBody.indexOf("if (completionStaged)")).toBeLessThan(
      failureBody.indexOf("const failedRows"),
    );
    const stagedBranch = failureBody.slice(
      failureBody.indexOf("if (completionStaged)"),
      failureBody.indexOf("if (err instanceof WorkerShutdownError) {"),
    );
    expect(stagedBranch).not.toContain('kind: "check-run-cleanup"');
    expect(stagedBranch).toContain("ReviewPublicationReconciliationError");
    const shutdownBranch = failureBody.slice(
      failureBody.indexOf("if (err instanceof WorkerShutdownError) {"),
      failureBody.indexOf("const publicationIncomplete"),
    );
    expect(shutdownBranch).not.toContain('kind: "check-run-cleanup"');
    expect(shutdownBranch).toContain('status: "stale"');
    expect(failureBody).toContain("db.transaction");
    expect(failureBody).toContain('kind: "check-run-cleanup"');
    expect(failureBody).toContain('intent: "fail"');
    expect(failureBody.indexOf("db.transaction")).toBeLessThan(
      failureBody.indexOf("await failCheckRuns"),
    );

    const reviewStart = source.indexOf("export async function runReviewJob");
    const checkCreation = source.indexOf(
      "advisoryCheckRunId = await createCheckRun",
      reviewStart,
    );
    const publicationBoundary = source.lastIndexOf(
      "onPublicationStarted?.()",
      checkCreation,
    );
    const cliCompletion = source.indexOf(
      "const result = await runCli",
      checkCreation,
    );
    const persistence = source.indexOf(
      "const completion = await finalizeStagedReviewCompletionWithGateMode",
      cliCompletion,
    );
    expect(publicationBoundary).toBeGreaterThan(reviewStart);
    expect(publicationBoundary).toBeLessThan(checkCreation);
    const advisoryPersistence = source.indexOf(
      ".set({ advisoryCheckRunId })",
      checkCreation,
    );
    const gateCreation = source.indexOf(
      "gateCheckRunId = await createCheckRun",
      checkCreation,
    );
    const gatePersistence = source.indexOf(
      ".set({ gateCheckRunId })",
      gateCreation,
    );
    expect(advisoryPersistence).toBeGreaterThan(checkCreation);
    expect(advisoryPersistence).toBeLessThan(gateCreation);
    expect(gatePersistence).toBeGreaterThan(gateCreation);
    expect(source.slice(checkCreation, gatePersistence)).toContain("reviewSignal,");
    expect(source.slice(cliCompletion, persistence)).not.toContain(
      "throwIfWorkerStopping(signal)",
    );
  });

  test("publication verification races preserve superseded review semantics", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const catchStart = source.indexOf(
      "  } catch (err) {",
      source.indexOf(
        'reviewLog.line("durable gate synchronization queued from stored review truth")',
        source.indexOf("export async function runReviewJob"),
      ),
    );
    const failureUpdate = source.indexOf("const failedRows", catchStart);
    const supersessionRace = source.slice(catchStart, failureUpdate);

    expect(supersessionRace).toContain(
      "err instanceof CheckRunPublicationError && receiptUsageForRace",
    );
    expect(supersessionRace).toContain('terminal?.status === "stale"');
    expect(supersessionRace).toContain(
      "await reconcileHostedReviewSpendFromReceipt",
    );
    expect(supersessionRace).toContain("await neutralizeSupersededCheckRuns");
    expect(supersessionRace).toContain("return;");
  });

  test("respond worker gates before token mint, config fetch, inference, and failure comments", () => {
    const source = readFileSync("src/worker/respond.ts", "utf8");
    const respondStart = source.indexOf("runRespondJob");
    const failureStart = source.indexOf("postRespondFailureComment");
    expect(respondStart).toBeGreaterThan(0);
    expect(failureStart).toBeGreaterThan(respondStart);
    const respondGate = source.indexOf(
      "await canProcessRepositoryInference",
      respondStart,
    );
    expect(respondGate).toBeGreaterThan(respondStart);
    for (const sideEffect of [
      "await getInstallationToken",
      "await materializeRepoConfig",
      "await runCli",
    ]) {
      expect(source.indexOf(sideEffect, respondStart)).toBeGreaterThan(
        respondGate,
      );
    }
    expect(
      source.indexOf("providerModeMatchesRepositoryAccess", respondGate),
    ).toBeLessThan(source.indexOf("await getInstallationToken", respondGate));
    expect(source.slice(respondStart, failureStart)).toContain(
      "allowModelSettings: llm.byok",
    );
    const reservation = source.indexOf(
      "await reserveHostedRespondSpend",
      respondStart,
    );
    const cliRun = source.indexOf("await runCli", respondStart);
    const reconciliation = source.indexOf(
      "await reconcileHostedRespondSpend",
      respondStart,
    );
    expect(reservation).toBeGreaterThan(respondGate);
    expect(reservation).toBeLessThan(cliRun);
    expect(reconciliation).toBeGreaterThan(cliRun);
    expect(source.slice(respondStart, failureStart)).toContain(
      "if (!llm.byok)",
    );
    expect(source.slice(respondStart, failureStart)).toContain(
      "POSTIL_USAGE_RECEIPT_PATH",
    );
    expect(source.slice(respondStart, failureStart)).toContain(
      "await releaseHostedRespondSpend",
    );
    const failureGate = source.indexOf(
      "await canProcessRepositoryInference",
      failureStart,
    );
    expect(failureGate).toBeGreaterThan(failureStart);
    expect(source.slice(failureStart, failureGate)).not.toContain(
      "postIssueComment",
    );
    expect(
      source.indexOf("await deliverPreparedRespond", failureStart),
    ).toBeGreaterThan(failureGate);
    const deliveryStart = source.indexOf(
      "async function deliverPreparedRespond",
    );
    expect(deliveryStart).toBeGreaterThan(0);
    expect(
      source.indexOf("await postIssueComment", deliveryStart),
    ).toBeGreaterThan(deliveryStart);
  });

  test("all webhook review, rerequest, mention, and approval paths pass through the gate before side effects", () => {
    const source = readFileSync("src/lib/github/webhook-handler.ts", "utf8");
    const pullStart = source.indexOf("async function handlePullRequest");
    const pullGate = source.indexOf(
      "await canProcessRepositoryInference",
      pullStart,
    );
    expect(
      source.indexOf("await supersedeActiveReviews", pullGate),
    ).toBeGreaterThan(pullGate);
    expect(source.indexOf("await enqueueReviewJob", pullStart)).toBeGreaterThan(
      pullGate,
    );

    const rerequestResolver = source.slice(
      source.indexOf("async function enabledRepoForRerequest"),
      source.indexOf("async function handleCheckRerequest"),
    );
    expect(rerequestResolver).toContain("await canProcessRepositoryInference");
    const rerequestHandler = source.slice(
      source.indexOf("async function handleCheckRerequest"),
      source.indexOf("async function handleCheckRun"),
    );
    expect(rerequestHandler.indexOf("enabledRepoForRerequest")).toBeLessThan(
      rerequestHandler.indexOf("enqueueReviewJob"),
    );

    const mentionResolver = source.slice(
      source.indexOf("async function enabledRepoForMention"),
      source.indexOf("function isBot"),
    );
    expect(mentionResolver).toContain("await canProcessRepositoryInference");
    for (const handler of [
      "handleIssueComment",
      "handleReviewComment",
      "handleIssues",
    ]) {
      const start = source.indexOf(`async function ${handler}`);
      const end = source.indexOf("\nasync function ", start + 1);
      const body = source.slice(start, end === -1 ? undefined : end);
      expect(body.indexOf("enabledRepoForMention")).toBeGreaterThan(0);
      if (body.includes("enqueueRespond")) {
        expect(body.indexOf("enabledRepoForMention")).toBeLessThan(
          body.indexOf("enqueueRespond"),
        );
      }
      if (body.includes("handleApproveCommand")) {
        expect(body.indexOf("handleApproveCommand")).toBeLessThan(
          body.indexOf("enabledRepoForMention"),
        );
      }
    }
  });
});
