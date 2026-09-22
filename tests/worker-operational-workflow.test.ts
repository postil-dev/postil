import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { createLocalGitHubServer } from "../scripts/run-review-locally";
import { calculateUsageCostMicrosForModel } from "@/lib/billing-credits";
import { closeDb, schema } from "@/lib/db";
import { claimJob, enqueueJob } from "@/lib/queue";
import { reconcileHostedReviewSpendFromReceipt } from "@/lib/hosted-usage-reservations";
import {
  hashEffectiveReviewConfiguration, PostgresLargeReviewAttemptStore, providerIdentity,
} from "@/lib/large-review-resume";
import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";

const describeDb = process.env.POSTIL_TEST_DATABASE_URL ? describe : describe.skip;
const model = "z-ai/glm-5.2";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const planSha = "c".repeat(64);

describeDb("operational recovery through the worker and CLI", () => {
  let fixture: EphemeralDatabase;
  let directory: string;
  let orgId: number;
  let installationId: number;
  let repositoryId: number;
  let runClaimedJob: typeof import("@/worker/runner").runClaimedJob;
  const originalEnvironment = { ...process.env };
  const sealingKey = randomBytes(32);
  const apiKey = randomUUID();

  beforeAll(async () => {
    fixture = await createEphemeralDatabase("operational_workflow");
    directory = await mkdtemp(join(tmpdir(), "postil-operational-workflow-"));
    process.env.DATABASE_URL = fixture.url;
    process.env.POSTIL_CACHE_DIR = directory;
    process.env.POSTIL_SEALING_KEY = sealingKey.toString("hex");
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    process.env.MODEL_API_KEY = apiKey;
    process.env.POSTIL_API_FORMAT = "openai-compatible";
    process.env.POSTIL_ALLOW_PRIVATE_API_BASE = "1";
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    process.env.POSTIL_WEBHOOK_DRAIN_ENABLED = "0";
    delete process.env.POSTIL_RELEASE_SHA;
    delete process.env.POSTIL_ENDPOINT_AUTH_HEADER;
    delete process.env.POSTIL_ENDPOINT_AUTH_VALUE;
    const q = fixture.pool;
    orgId = Number((await q.query("INSERT INTO organizations(slug,name) VALUES ('workflow','Workflow') RETURNING id")).rows[0].id);
    installationId = Number((await q.query("INSERT INTO installations(github_installation_id,account_login,account_type,org_id) VALUES (990001,'workflow','Organization',$1) RETURNING id", [orgId])).rows[0].id);
    repositoryId = Number((await q.query("INSERT INTO repositories(installation_id,github_repo_id,full_name,private,enabled) VALUES ($1,990002,'workflow/repo',false,true) RETURNING id", [installationId])).rows[0].id);
    await q.query("INSERT INTO organization_entitlements(org_id,subscription_mode,status,included_usage_micros,updated_by) VALUES ($1,'hosted','active',10000000,'fixture')", [orgId]);
    await q.query("INSERT INTO org_settings(org_id,gate_enabled,shared_config_enabled) VALUES ($1,true,false)", [orgId]);
    process.env.POSTIL_BIN = join(directory, "postil-fixture");
    await writeFile(process.env.POSTIL_BIN, mockCliSource(), { mode: 0o755 });
    ({ runClaimedJob } = await import("@/worker/runner"));
  }, 30_000);

  afterAll(async () => {
    await closeDb();
    await fixture?.drop();
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
  });

  for (const scenario of ["unavailable", "foreign-plan", "feedback"] as const) {
    const foreignPlan = scenario === "foreign-plan";
    const withFeedback = scenario === "feedback";
    test(withFeedback ? "queued feedback survives retry with exact CLI context and plan binding" : foreignPlan ? "failed registration retries without retiring a foreign plan" : "unavailable output is retired before a successful queue retry", async () => {
      const prNumber = withFeedback ? 5 : foreignPlan ? 2 : 1;
      let providerCalls = 0;
      const configurations: string[] = [];
      const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
        providerCalls += 1;
        if (withFeedback) {
          const plans = await fixture.pool.query(`SELECT configuration_sha256 FROM large_review_runs
            WHERE repository_id=$1 AND pr_number=$2`, [repositoryId, prNumber]);
          expect(plans.rows).toHaveLength(1);
          configurations.push(plans.rows[0].configuration_sha256);
        }
        return Response.json({ choices: [{ message: {
          content: !foreignPlan && providerCalls === 1 ? "unavailable" : "complete",
        } }] });
      } });
      const github = createLocalGitHubServer({
        repoPath: directory, repoFullName: "workflow/repo", prNumber,
        diffText: "", headSha, baseSha, pullRequestTitle: "Review workflow",
        repositorySource: { kind: "working-tree" }, baseRepositorySource: { kind: "working-tree" },
      });
      process.env.POSTIL_API_BASE = `http://127.0.0.1:${upstream.port}/v1`;
      process.env.GITHUB_API_URL = github.origin;
      process.env.POSTIL_PUBLIC_URL = github.origin;
      process.env.POSTIL_FIXTURE_COUNT_PATH = join(directory, `invocations-${prNumber}`);
      process.env.POSTIL_FIXTURE_FOREIGN_PLAN = foreignPlan ? "1" : "0";
      const reviewFeedback = {
        version: 1, repository: "workflow/repo", prNumber, headSha,
        threads: [{ findingId: "documented-sequence", rootCommentId: 501, resolved: true,
          comments: [{ commentId: 502, author: { id: 503, login: "maintainer" },
            body: "The documented restore follows initial installation.", updatedAt: "2026-09-01T12:00:00Z" }] }],
      };
      if (withFeedback) process.env.POSTIL_FIXTURE_EXPECTED_FEEDBACK = JSON.stringify(reviewFeedback);
      else delete process.env.POSTIL_FIXTURE_EXPECTED_FEEDBACK;
      const payload = {
        installationId: 990001, sourceInstallationId: installationId, sourceOrgId: orgId,
        githubRepoId: 990002, repoFullName: "workflow/repo", prNumber, headSha, baseSha,
        ...(withFeedback ? { reviewFeedback } : {}),
      };
      const q = fixture.pool;
      const kind = withFeedback ? "review-feedback" : "review";
      const jobId = await enqueueJob(q, kind, payload);
      let foreignKey: string | undefined;
      let foreignSnapshot: Array<Record<string, unknown>> = [];
      if (foreignPlan) {
        const owner = Number((await q.query("INSERT INTO reviews(repository_id,pr_number,head_sha,base_sha,status) VALUES ($1,$2,$3,$4,'completed') RETURNING id", [repositoryId, prNumber, headSha, baseSha])).rows[0].id);
        const reservation = (await q.query("INSERT INTO hosted_usage_reservations(org_id,review_id,operation,status,reserved_micros,expires_at) VALUES ($1,$2,'review','released',1000000,now()+interval '15 minutes') RETURNING id", [orgId, owner])).rows[0].id;
        const store = new PostgresLargeReviewAttemptStore(drizzle(q, { schema }));
        foreignKey = await store.bindRun({
          repositoryId, prNumber, cliVersion: "0.9.8",
          configurationSha256: await hashEffectiveReviewConfiguration(directory, []),
          providerIdentity: providerIdentity({ apiBase: process.env.POSTIL_API_BASE,
            apiFormat: "openai-compatible", byok: false, apiKey, identityKey: sealingKey }),
          headSha, baseSha, retryLineage: `review-job:${jobId}`, planSha256: planSha,
        }, { currentReviewId: owner, hostedReservationId: reservation });
        foreignSnapshot = (await q.query("SELECT * FROM large_review_runs WHERE run_key=$1", [foreignKey])).rows;
      }
      try {
        const first = await claimJob(q, "workflow-first", [kind]);
        expect(first?.id).toBe(jobId);
        await runClaimedJob(first!, "workflow-first");
        const firstJob = (await q.query("SELECT status,attempts,max_attempts,payload FROM jobs WHERE id=$1", [jobId])).rows[0];
        expect(firstJob.status).toBe("queued");
        expect(firstJob.attempts).toBe(1);
        expect(firstJob.max_attempts).toBe(3);
        expect(firstJob.payload.recoveryReviewId).toBeUndefined();
        const failed = (await q.query("SELECT id,status,envelope FROM reviews WHERE repository_id=$1 AND pr_number=$2 AND status='failed'", [repositoryId, prNumber])).rows[0];
        expect(failed.envelope.findings[0].path).toBe(foreignPlan ? ".postil/model-output" : ".postil/provider");
        expect((await q.query("SELECT count(*)::int AS count FROM review_publication_receipts WHERE review_id=$1", [failed.id])).rows[0].count).toBe(0);
        expect((await q.query("SELECT count(*)::int AS count FROM large_review_runs WHERE current_review_id=$1", [failed.id])).rows[0].count).toBe(0);
        const expectedCost = calculateUsageCostMicrosForModel(model, 10, 5);
        expect(expectedCost).not.toBeNull();
        expect((await q.query("SELECT status,actual_micros::int AS actual_micros FROM hosted_usage_reservations WHERE review_id=$1", [failed.id])).rows).toEqual([{ status: "reconciled", actual_micros: expectedCost }]);
        await q.query("UPDATE jobs SET run_after=now() WHERE id=$1", [jobId]);
        const second = await claimJob(q, "workflow-second", [kind]);
        expect(second?.id).toBe(jobId);
        await runClaimedJob(second!, "workflow-second");
        const finalJob = (await q.query("SELECT status,attempts,payload FROM jobs WHERE id=$1", [jobId])).rows[0];
        expect(finalJob.status).toBe("done");
        expect(finalJob.attempts).toBe(2);
        const completed = (await q.query("SELECT id,status,envelope,advisory_check_run_id FROM reviews WHERE id=$1", [finalJob.payload.recoveryReviewId])).rows[0];
        expect(completed.status).toBe("completed");
        expect(completed.envelope.findings).toEqual([]);
        expect(String(completed.id)).not.toBe(String(failed.id));
        const usage = (await q.query("SELECT review_id,cost_micros::int AS cost_micros,billing_scope FROM usage_events WHERE review_id IN ($1,$2) ORDER BY review_id", [failed.id, completed.id])).rows;
        expect(usage).toEqual([
          { review_id: String(failed.id), cost_micros: expectedCost, billing_scope: "private_hosted" },
          { review_id: String(completed.id), cost_micros: expectedCost, billing_scope: "private_hosted" },
        ]);
        expect(providerCalls).toBe(foreignPlan ? 1 : 2);
        if (withFeedback) {
          expect(configurations).toHaveLength(2);
          expect(configurations[0]).toBe(configurations[1]);
          expect(configurations[0]).not.toBe(await hashEffectiveReviewConfiguration(directory, []));
          expect(finalJob.payload.reviewFeedback).toEqual(reviewFeedback);
        }
        expect(github.events.some((event) => event.type === "check-completed" && event.id === Number(completed.advisory_check_run_id) && event.conclusion === "success")).toBe(true);
        if (foreignKey) {
          expect((await q.query("SELECT * FROM large_review_runs WHERE run_key=$1", [foreignKey])).rows).toEqual(foreignSnapshot);
        }
      } finally {
        delete process.env.POSTIL_FIXTURE_EXPECTED_FEEDBACK;
        github.stop();
        upstream.stop(true);
      }
    }, 30_000);
  }

  test("recovers a settled journal after process loss without replaying cached failure", async () => {
    const prNumber = 3;
    let providerCalls = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      providerCalls += 1;
      return Response.json({ choices: [{ message: { content: "complete" } }] });
    } });
    const github = configureWorkflow(prNumber, upstream.port!);
    const q = fixture.pool;
    const db = drizzle(q, { schema });
    const jobId = await enqueueJob(q, "review", workflowPayload(prNumber));
    const sourceReviewId = Number((await q.query(
      "INSERT INTO reviews(repository_id,pr_number,head_sha,base_sha,status) VALUES ($1,$2,$3,$4,'failed') RETURNING id",
      [repositoryId, prNumber, headSha, baseSha],
    )).rows[0].id);
    const reservationId = (await q.query(
      "INSERT INTO hosted_usage_reservations(org_id,review_id,operation,status,reserved_micros,expires_at) VALUES ($1,$2,'review','active',1000000,now()+interval '15 minutes') RETURNING id",
      [orgId, sourceReviewId],
    )).rows[0].id;
    const store = new PostgresLargeReviewAttemptStore(db);
    const runKey = await store.bindRun({
      repositoryId, prNumber, cliVersion: "0.9.8", headSha, baseSha,
      retryLineage: `review-job:${jobId}`, planSha256: planSha,
      configurationSha256: await hashEffectiveReviewConfiguration(directory, []),
      providerIdentity: providerIdentity({ apiBase: process.env.POSTIL_API_BASE!,
        apiFormat: "openai-compatible", byok: false, apiKey, identityKey: sealingKey }),
    }, { currentReviewId: sourceReviewId, hostedReservationId: reservationId });
    const request = JSON.stringify({ model, messages: [{ role: "user", content: "review" }] });
    const requestSha256 = new Bun.CryptoHasher("sha256").update(request).digest("hex");
    const claim = await store.claimAttempt({
      runKey, requestSha256, batchIdentity: "f".repeat(64), attempt: 1, model,
    });
    if (claim.kind !== "execute") throw new Error("fixture attempt was not acquired");
    await store.completeAttempt({ ...claim, response: { status: 200, headers: {},
      body: JSON.stringify({ choices: [{ message: { content: "unavailable" } }] }) } });
    const expectedCost = calculateUsageCostMicrosForModel(model, 10, 5)!;
    await reconcileHostedReviewSpendFromReceipt(db, {
      reservationId, repositoryId, reviewId: sourceReviewId, triggerSource: "unknown",
      usage: [{ modelUsed: model, promptTokens: 10, completionTokens: 5, costMicros: expectedCost }],
      usageAccountingComplete: true,
    });
    // These committed rows are the restart boundary between settlement and retirement.
    const settled = (await q.query("SELECT * FROM hosted_usage_reservations WHERE id=$1", [reservationId])).rows;
    expect((await q.query("SELECT count(*)::int AS count FROM large_review_attempts WHERE run_key=$1", [runKey])).rows[0].count).toBe(1);
    await q.query("UPDATE jobs SET attempts=1 WHERE id=$1", [jobId]);
    try {
      const job = await claimJob(q, "workflow-restart", ["review"]);
      expect(job?.id).toBe(jobId);
      expect(job?.attempts).toBe(2);
      await runClaimedJob(job!, "workflow-restart");
      const terminal = (await q.query("SELECT status,attempts,payload FROM jobs WHERE id=$1", [jobId])).rows[0];
      expect(terminal.status).toBe("done");
      expect(terminal.attempts).toBe(2);
      expect(Number(terminal.payload.recoveryReviewId)).not.toBe(sourceReviewId);
      expect(providerCalls).toBe(1);
      expect((await q.query("SELECT * FROM hosted_usage_reservations WHERE id=$1", [reservationId])).rows).toEqual(settled);
      expect((await q.query("SELECT count(*)::int AS count FROM large_review_attempts WHERE run_key=$1", [runKey])).rows[0].count).toBe(0);
      expect((await q.query("SELECT cost_micros::int AS cost FROM usage_events WHERE review_id IN ($1,$2) ORDER BY review_id", [sourceReviewId, terminal.payload.recoveryReviewId])).rows).toEqual([{ cost: expectedCost }, { cost: expectedCost }]);
    } finally {
      github.stop();
      upstream.stop(true);
    }
  }, 30_000);

  test("supersession during inference finishes neutral after the CLI's late failure", async () => {
    const prNumber = 4;
    const { supersedeActiveReviews } = await import("@/worker/review");
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
      expect(await supersedeActiveReviews({
        repositoryId, prNumber, newHeadSha: "e".repeat(40),
        repoFullName: "workflow/repo", githubInstallationId: 990001,
      })).toBe(1);
      return Response.json({ choices: [{ message: { content: "unavailable" } }] });
    } });
    const github = configureWorkflow(prNumber, upstream.port!);
    const q = fixture.pool;
    const jobId = await enqueueJob(q, "review", workflowPayload(prNumber));
    try {
      const job = await claimJob(q, "workflow-superseded", ["review"]);
      expect(job?.id).toBe(jobId);
      await runClaimedJob(job!, "workflow-superseded");
      const terminal = (await q.query("SELECT status,attempts,payload FROM jobs WHERE id=$1", [jobId])).rows[0];
      expect(terminal.status).toBe("done");
      expect(terminal.attempts).toBe(1);
      expect(terminal.payload.recoveryReviewId).toBeUndefined();
      const review = (await q.query("SELECT id,status,advisory_check_run_id,gate_check_run_id FROM reviews WHERE repository_id=$1 AND pr_number=$2", [repositoryId, prNumber])).rows[0];
      expect(review.status).toBe("stale");
      const advisory = github.events.filter((event) => event.type === "check-completed" && event.id === Number(review.advisory_check_run_id));
      expect(advisory.map((event) => event.type === "check-completed" && event.conclusion)).toEqual(["neutral", "failure", "neutral"]);
      const gate = github.events.filter((event) => event.type === "check-completed" && event.id === Number(review.gate_check_run_id));
      expect(gate.at(-1)).toMatchObject({ conclusion: "neutral" });
      expect((await q.query("SELECT status,actual_micros::int AS cost FROM hosted_usage_reservations WHERE review_id=$1", [review.id])).rows).toEqual([{ status: "reconciled", cost: calculateUsageCostMicrosForModel(model, 10, 5) }]);
      expect((await q.query("SELECT count(*)::int AS count FROM large_review_runs WHERE current_review_id=$1", [review.id])).rows[0].count).toBe(0);
    } finally {
      github.stop();
      upstream.stop(true);
    }
  }, 30_000);

  function workflowPayload(prNumber: number) {
    return { installationId: 990001, sourceInstallationId: installationId, sourceOrgId: orgId,
      githubRepoId: 990002, repoFullName: "workflow/repo", prNumber, headSha, baseSha };
  }

  function configureWorkflow(prNumber: number, upstreamPort: number) {
    const github = createLocalGitHubServer({
      repoPath: directory, repoFullName: "workflow/repo", prNumber, diffText: "", headSha, baseSha,
      pullRequestTitle: "Review workflow", repositorySource: { kind: "working-tree" },
      baseRepositorySource: { kind: "working-tree" },
    });
    process.env.POSTIL_API_BASE = `http://127.0.0.1:${upstreamPort}/v1`;
    process.env.GITHUB_API_URL = github.origin;
    process.env.POSTIL_PUBLIC_URL = github.origin;
    process.env.POSTIL_FIXTURE_COUNT_PATH = join(directory, `invocations-${prNumber}`);
    process.env.POSTIL_FIXTURE_FOREIGN_PLAN = "0";
    return github;
  }
});

function mockCliSource(): string {
  return `#!/usr/bin/env bun
if (process.argv.includes("--version")) { console.log("postil 0.9.8"); process.exit(0); }
const args=process.argv.slice(2);
const value=(flag)=>args[args.indexOf(flag)+1];
if(process.env.POSTIL_FIXTURE_EXPECTED_FEEDBACK){const observed=await Bun.file(process.env.POSTIL_REVIEW_FEEDBACK_PATH).json();if(!Bun.deepEquals(observed,JSON.parse(process.env.POSTIL_FIXTURE_EXPECTED_FEEDBACK))||observed.repository!==value("--repo")||String(observed.prNumber)!==value("--pr")||observed.headSha!==value("--sha"))throw Error("CLI feedback context mismatch");}
const countFile=Bun.file(process.env.POSTIL_FIXTURE_COUNT_PATH);
const count=(await countFile.exists()?Number(await countFile.text()):0)+1;
await Bun.write(countFile,String(count));
const planSha=process.env.POSTIL_FIXTURE_FOREIGN_PLAN==="1"&&count>1?"d".repeat(64):"c".repeat(64);
const registered=await fetch(process.env.POSTIL_LARGE_REVIEW_PLAN_ENDPOINT,{method:"POST",headers:{authorization:"Bearer "+process.env.POSTIL_LARGE_REVIEW_PLAN_TOKEN,"content-type":"application/json"},body:JSON.stringify({version:1,planSha256:planSha,directHunks:1,semanticHunks:0,unreviewedHunks:0,selectedBatches:1,totalBatches:1,concurrency:1,requestTimeoutSeconds:60,reviewBudgetSeconds:120})});
let unavailable=!registered.ok;
if(registered.ok){const response=await fetch(process.env.POSTIL_API_BASE+"/chat/completions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:${JSON.stringify(model)},messages:[{role:"user",content:"review"}]})});const body=await response.json();unavailable=body.choices[0].message.content==="unavailable";}
const findings=unavailable?[{id:"operational",path:registered.ok?".postil/provider":".postil/model-output",line:1,severity:"error",kind:"uncertainty",confidence:1,title:"Review unavailable",body:"Provider unavailable or plan registration HTTP "+registered.status}]:[];
const envelope={version:1,summary:unavailable?"Review unavailable":"Complete",silent:!unavailable,findings,resolved:[],counts:{info:0,warn:0,error:findings.length,suppressed:0,ungrounded:0},confidenceBuckets:unavailable?[0,0,0,0,1]:[0,0,0,0,0],gate:{failOn:"error",failing:unavailable},modelUsed:${JSON.stringify(model)},usage:{promptTokens:10,completionTokens:5},usageAccountingComplete:true,durationMs:1,headSha:value("--sha"),baseSha:${JSON.stringify(baseSha)},sinceSha:null};
await fetch(process.env.GITHUB_API_URL+"/repos/"+value("--repo")+"/check-runs/"+value("--check-run-id"),{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({status:"completed",conclusion:unavailable?"failure":"success",details_url:process.env.POSTIL_DETAILS_URL,output:{title:envelope.summary,summary:envelope.summary}})});
console.log(JSON.stringify(envelope));process.exit(unavailable?1:0);
`;
}
