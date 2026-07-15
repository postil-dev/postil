import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("private repository worker defense in depth", () => {
  test("review worker gates before review rows, GitHub tokens, checks, config fetch, or CLI spawn", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const gate = source.indexOf("await canProcessPrivateRepository", source.indexOf("runReviewJob"));
    expect(gate).toBeGreaterThan(0);
    expect(source).toContain("authorGithubId: payload.authorGithubId");
    expect(source).toContain("authorLogin: payload.authorLogin");
    for (const sideEffect of [
      "insert(schema.reviews)",
      "await getInstallationToken",
      "await createCheckRun",
      "await materializeRepoConfig",
      "await runCli",
    ]) {
      expect(source.indexOf(sideEffect, source.indexOf("runReviewJob"))).toBeGreaterThan(gate);
    }
    expect(source.indexOf("providerModeMatchesPrivateAccess", gate)).toBeLessThan(
      source.indexOf("await getInstallationToken", gate),
    );
    expect(source.indexOf("fetchRepositorySummary", gate)).toBeLessThan(
      source.indexOf("insert(schema.reviews)", gate),
    );
  });

  test("disabled hosted inference stops before reservation, config fetch, or CLI spawn", () => {
    const source = readFileSync("src/worker/review.ts", "utf8");
    const start = source.indexOf("export async function runReviewJob");
    const gate = source.indexOf("if (!llm.byok && !hostedInferenceEnabled())", start);
    const reservation = source.indexOf("await reserveHostedReviewSpend", start);
    const materialization = source.indexOf("await materializeRepoConfig", start);
    const cli = source.indexOf("await runCli", start);
    const versionProbe = source.indexOf("postilCliVersionLogLine()", start);

    expect(gate).toBeGreaterThan(start);
    expect(versionProbe).toBeGreaterThan(gate);
    expect(reservation).toBeGreaterThan(gate);
    expect(materialization).toBeGreaterThan(gate);
    expect(cli).toBeGreaterThan(gate);
    const guardBody = source.slice(gate, reservation);
    expect(guardBody).toContain("completeHostedInferenceDisabledCheckRuns");
    expect(guardBody).toContain("supersedeActiveReviews");
    expect(guardBody).toContain("return;");
    expect(guardBody).not.toContain("postReview");
    expect(guardBody).not.toContain("failCheckRuns");
  });

  test("respond worker gates before token mint, config fetch, inference, and failure comments", () => {
    const source = readFileSync("src/worker/respond.ts", "utf8");
    const respondStart = source.indexOf("runRespondJob");
    const failureStart = source.indexOf("postRespondFailureComment");
    expect(respondStart).toBeGreaterThan(0);
    expect(failureStart).toBeGreaterThan(respondStart);
    const respondGate = source.indexOf("await canProcessPrivateRepository", respondStart);
    expect(respondGate).toBeGreaterThan(respondStart);
    for (const sideEffect of [
      "await getInstallationToken",
      "await materializeRepoConfig",
      "await runCli",
    ]) {
      expect(source.indexOf(sideEffect, respondStart)).toBeGreaterThan(respondGate);
    }
    expect(source.indexOf("providerModeMatchesPrivateAccess", respondGate)).toBeLessThan(
      source.indexOf("await getInstallationToken", respondGate),
    );
    expect(source.slice(respondStart, failureStart)).toContain(
      "allowModelSettings: llm.byok",
    );
    const reservation = source.indexOf("await reserveHostedRespondSpend", respondStart);
    const cliRun = source.indexOf("await runCli", respondStart);
    const reconciliation = source.indexOf("await reconcileHostedRespondSpend", respondStart);
    expect(reservation).toBeGreaterThan(respondGate);
    expect(reservation).toBeLessThan(cliRun);
    expect(reconciliation).toBeGreaterThan(cliRun);
    expect(source.slice(respondStart, failureStart)).toContain(
      "currentRepository.private && !llm.byok",
    );
    expect(source.slice(respondStart, failureStart)).toContain(
      "POSTIL_USAGE_RECEIPT_PATH",
    );
    expect(source.slice(respondStart, failureStart)).toContain(
      "await releaseHostedRespondSpend",
    );
    const failureGate = source.indexOf("await canProcessPrivateRepository", failureStart);
    expect(failureGate).toBeGreaterThan(failureStart);
    expect(source.slice(failureStart, failureGate)).not.toContain("postIssueComment");
    expect(source.indexOf("await deliverPreparedRespond", failureStart)).toBeGreaterThan(
      failureGate,
    );
    const deliveryStart = source.indexOf("async function deliverPreparedRespond");
    expect(deliveryStart).toBeGreaterThan(0);
    expect(source.indexOf("await postIssueComment", deliveryStart)).toBeGreaterThan(
      deliveryStart,
    );
  });

  test("all webhook review, rerequest, mention, and approval paths pass through the gate before side effects", () => {
    const source = readFileSync("src/app/api/webhooks/github/route.ts", "utf8");
    const pullStart = source.indexOf("async function handlePullRequest");
    const pullGate = source.indexOf("await canProcessPrivateRepository", pullStart);
    expect(source.indexOf("await supersedeActiveReviews", pullStart)).toBeGreaterThan(pullGate);
    expect(source.indexOf("await enqueueReviewJob", pullStart)).toBeGreaterThan(pullGate);

    const rerequestResolver = source.slice(
      source.indexOf("async function enabledRepoForRerequest"),
      source.indexOf("async function handleCheckRerequest"),
    );
    expect(rerequestResolver).toContain("await canProcessPrivateRepository");
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
    expect(mentionResolver).toContain("await canProcessPrivateRepository");
    for (const handler of ["handleIssueComment", "handleReviewComment", "handleIssues"]) {
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
