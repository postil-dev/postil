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

  test("hosted review cannot persist completion before forge publication is verified", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const reviewStart = source.indexOf("export async function runReviewJob");
    const cliCompletion = source.indexOf(
      "const result = await runCli",
      reviewStart,
    );
    const publication = source.indexOf("await Promise.all([", cliCompletion);
    const verification = source.indexOf("verifyCompletedCheckRun", publication);
    const persistence = source.indexOf(
      "const completed = await persistReviewCompletion",
      verification,
    );

    expect(publication).toBeGreaterThan(cliCompletion);
    expect(verification).toBeGreaterThan(publication);
    expect(persistence).toBeGreaterThan(verification);
    expect(source.slice(publication, persistence)).toContain(
      'reviewLog.line("forge check-runs verified completed by the CLI")',
    );
    expect(source.slice(publication, persistence)).toContain(
      '"GitHub review publication could not be verified"',
    );
    expect(source.slice(publication, persistence)).toContain(
      "{ cause: error }",
    );
  });

  test("operational review failures durably queue terminal check cleanup", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const catchStart = source.indexOf(
      "} catch (err) {",
      source.indexOf("await persistReviewCompletion"),
    );
    const catchEnd = source.indexOf("} finally {", catchStart);
    const failureBody = source.slice(catchStart, catchEnd);

    expect(failureBody).toContain("err instanceof WorkerShutdownError");
    expect(
      failureBody.indexOf("err instanceof WorkerShutdownError"),
    ).toBeLessThan(failureBody.indexOf("db.transaction"));
    expect(
      failureBody.slice(0, failureBody.indexOf("const message")),
    ).not.toContain('kind: "check-run-cleanup"');
    expect(
      failureBody.slice(0, failureBody.indexOf("const message")),
    ).toContain('.set({ status: "stale", finishedAt: new Date() })');
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
      "const completed = await persistReviewCompletion",
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
    expect(source.slice(checkCreation, gatePersistence)).toContain("signal,");
    expect(source.slice(cliCompletion, persistence)).not.toContain(
      "throwIfWorkerStopping(signal)",
    );
  });

  test("publication verification races preserve superseded review semantics", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const catchStart = source.indexOf(
      "} catch (err) {",
      source.indexOf("await persistReviewCompletion"),
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
      source.indexOf("await supersedeActiveReviews", pullStart),
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
