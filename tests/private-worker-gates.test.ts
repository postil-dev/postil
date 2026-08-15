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
      "return runCli",
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
    expect(providerFailure).toBeLessThan(source.indexOf("return runCli", gate));
    expect(
      source.slice(providerFailure, source.indexOf("return runCli", gate)),
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
    expect(authorLookup).toBeLessThan(source.indexOf("return runCli", gate));
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
    expect(deploy.indexOf("Deploy managed fleet")).toBeLessThan(
      deploy.indexOf(
        "Verify and activate release capabilities after fleet replacement",
      ),
    );
    expect(activation).toContain("activatePrivateReviewAuthorIdentity");
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
    const cli = source.indexOf("return runCli", start);
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
    expect(args).toContain('"--sha",\n      payload.headSha');
    expect(args).toContain('"--base-sha",\n      payload.baseSha');
    expect(args).not.toContain('"--no-post"');
  });

  test("legacy review fencing occurs before any resumable publication path", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const start = source.indexOf("export async function runReviewJob");
    const fence = source.indexOf(
      "await publicationControllerLegacyReviewFenced",
      start,
    );
    const resume = source.indexOf("await resumeStagedReviewCompletion", start);
    const token = source.indexOf("await getInstallationToken", start);

    expect(fence).toBeGreaterThan(start);
    expect(fence).toBeLessThan(resume);
    expect(fence).toBeLessThan(token);
    expect(source.slice(fence, resume)).toContain(
      "PublicationControllerReleaseFenceError",
    );
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
      "return runCli",
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
    const gatePublication = source.indexOf(
      'reviewLog.line("durable gate synchronization queued from stored review truth")',
      finalization,
    );

    expect(staging).toBeGreaterThan(cliCompletion);
    expect(verification).toBeGreaterThan(staging);
    expect(finalization).toBeGreaterThan(verification);
    expect(gatePublication).toBeGreaterThan(finalization);
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
    expect(source.slice(finalization, gatePublication)).toContain(
      'triggerQueueDrain("gate-state-sync")',
    );
  });

  test("completion staging binds the recovery pointer to the exact running claim", () => {
    const completion = readFileSync("src/lib/review-completion.ts", "utf8");
    const review = readFileSync("src/worker/review.ts", "utf8");
    const staging = completion.slice(
      completion.indexOf("export async function stageReviewCompletionCandidate"),
      completion.indexOf("export async function finalizeStagedReviewCompletionWithGateMode"),
    );

    expect(staging).toContain('eq(schema.jobs.status, "running")');
    expect(staging).toContain(
      "eq(schema.jobs.lockedBy, input.reviewJobLease.lockedBy)",
    );
    expect(staging).toContain(
      "eq(schema.jobs.lockGeneration, input.reviewJobLease.lockGeneration)",
    );
    expect(staging).toContain("throw new ReviewCompletionJobLeaseLostError");
    expect(review).toContain("reviewJobLease: timing.lease");
    expect(review).not.toContain("reviewJobId: timing.lease");
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
    expect(recovery).not.toContain("await enqueueGateStateSync(db, stagedReview)");
    expect(recovery).toContain('triggerQueueDrain("gate-state-sync")');
    expect(recovery).toContain("getPullRequestReviewContext(");
    expect(recovery).toContain("pendingReviewInputSupersedes(");
    expect(recovery.indexOf("getPullRequestReviewContext(")).toBeLessThan(
      recovery.indexOf("await verifyCompletedCheckRun("),
    );
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
      "} catch (err) {",
      source.indexOf(
        'reviewLog.line("publication lifecycle observation deferred")',
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
    expect(shutdownBranch).toContain("await markReviewStaleWithDurableCleanup");
    expect(shutdownBranch).toContain('intent: "neutralize"');
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
      "return runCli",
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

  test("review input convergence retains signed heads and is enforced before CLI invocation", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const reviewStart = source.indexOf("export async function runReviewJob");
    const liveContext = source.indexOf("const liveContext", reviewStart);
    const convergenceCheck = source.indexOf(
      "livePullRequestSnapshotLagsEvent(",
      liveContext,
    );
    const reviewInsert = source.indexOf(".insert(schema.reviews)", liveContext);
    const cliInvocation = source.indexOf("return runCli", liveContext);
    const publicationFence = source.indexOf(
      "const result = await withReviewPublicationFence",
      liveContext,
    );
    const finalAuthorization = source.lastIndexOf(
      "if (!(await publicationAuthorized()))",
      cliInvocation,
    );
    const authorizationDefinition = source.indexOf(
      "const publicationAuthorized",
      convergenceCheck,
    );
    const authorizationLiveFetch = source.indexOf(
      "getPullRequestReviewContext(",
      authorizationDefinition,
    );
    const durableInputAuthority = source.indexOf(
      "await reviewInputLeaseState(",
      authorizationDefinition,
    );
    const activeInputMonitor = source.indexOf(
      "startReviewInputLeaseMonitor(",
      reviewInsert,
    );
    const newerPendingRejection = source.indexOf(
      'inputLeaseState === "newer-pending"',
      durableInputAuthority,
    );
    const firstAuthorization = source.indexOf(
      "if (!(await publicationAuthorized()))",
      authorizationDefinition,
    );
    const advisoryCheckCreation = source.indexOf(
      "advisoryCheckRunId = await createCheckRun",
      firstAuthorization,
    );

    expect(liveContext).toBeGreaterThan(reviewStart);
    expect(convergenceCheck).toBeGreaterThan(liveContext);
    expect(source.slice(liveContext, reviewInsert)).toContain(
      "const expectedPullRequestUpdatedAt",
    );
    expect(source.slice(convergenceCheck, reviewInsert)).toContain(
      "liveSnapshotLagsEvent",
    );
    expect(reviewInsert).toBeGreaterThan(convergenceCheck);
    expect(authorizationDefinition).toBeGreaterThan(reviewInsert);
    expect(activeInputMonitor).toBeGreaterThan(reviewInsert);
    expect(activeInputMonitor).toBeLessThan(cliInvocation);
    expect(publicationFence).toBeGreaterThan(advisoryCheckCreation);
    expect(publicationFence).toBeLessThan(finalAuthorization);
    expect(source.slice(activeInputMonitor, cliInvocation)).toContain(
      "reviewInputLeaseState(",
    );
    expect(durableInputAuthority).toBeGreaterThan(authorizationLiveFetch);
    expect(newerPendingRejection).toBeGreaterThan(durableInputAuthority);
    expect(newerPendingRejection).toBeLessThan(finalAuthorization);
    expect(
      source.slice(authorizationDefinition, finalAuthorization),
    ).toContain("expectedPullRequestUpdatedAt");
    expect(firstAuthorization).toBeGreaterThan(authorizationDefinition);
    expect(advisoryCheckCreation).toBeGreaterThan(firstAuthorization);
    expect(source.slice(firstAuthorization, advisoryCheckCreation)).toContain(
      "error instanceof ReviewInputConvergenceError",
    );
    expect(finalAuthorization).toBeGreaterThan(advisoryCheckCreation);
    expect(finalAuthorization).toBeGreaterThan(authorizationDefinition);
    expect(cliInvocation).toBeGreaterThan(finalAuthorization);

    const catchStart = source.indexOf("} catch (err) {", cliInvocation);
    expect(source.slice(cliInvocation, catchStart)).toContain(
      "ReviewInputSupersededError",
    );
    const convergenceRetry = source.indexOf(
      "if (err instanceof ReviewInputConvergenceError)",
      catchStart,
    );
    const terminalFailure = source.indexOf("const failedRows", convergenceRetry);
    const retryPath = source.slice(convergenceRetry, terminalFailure);
    expect(convergenceRetry).toBeGreaterThan(catchStart);
    expect(retryPath).toContain("await markReviewStaleWithDurableCleanup");
    expect(retryPath).toContain('intent: "neutralize"');
    expect(retryPath).toContain("markReviewStaleWithDurableCleanup");
    expect(source).toContain('intent: "neutralize"');
    expect(retryPath).toContain("await reconcileInterruptedSpend()");
    expect(retryPath).not.toContain("await releaseHostedReviewSpend");
    expect(retryPath).toContain("retained pull request input queued");
    expect(retryPath.indexOf("return;")).toBeLessThan(
      retryPath.indexOf("throw err"),
    );
    expect(retryPath).toContain("throw err");
  });

  test("reconciliation retry promotes retained input under the exact claim", () => {
    const source = readFileSync("src/lib/queue.ts", "utf8");
    const retryStart = source.indexOf(
      "export async function retryJobIndefinitely",
    );
    const deadlineBranch = source.indexOf(
      "if (nextRunAt === null)",
      retryStart,
    );
    const ordinaryTransition = source.indexOf(
      "const res = await pool.query<{",
      source.indexOf("return res.rows[0]?.outcome", deadlineBranch) + 1,
    );
    const retryEnd = source.indexOf(
      "export async function queueDepth",
      ordinaryTransition,
    );
    const retryBody = source.slice(ordinaryTransition, retryEnd);

    expect(ordinaryTransition).toBeGreaterThan(deadlineBranch);
    expect(retryBody).toContain("jsonb_typeof(payload -> $7) = 'object'");
    expect(retryBody).toContain("INSERT INTO jobs");
    expect(retryBody).toContain("THEN 'coalesced'");
    expect(retryBody).toContain("AND job.lock_generation = $4");
  });

  test("publication verification races preserve superseded review semantics", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const catchStart = source.indexOf(
      "} catch (err) {",
      source.indexOf('reviewLog.line("publication lifecycle observation deferred")'),
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
