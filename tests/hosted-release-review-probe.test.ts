import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { runInNewContext } from "node:vm";
import { remoteReviewProgram } from "../scripts/probe-hosted-release-review";

const head = randomBytes(20).toString("hex");
const target = randomBytes(20).toString("hex");
const hash = randomBytes(32).toString("hex");
const publicId = "4aee0c62-44bc-4b86-824e-c03c45132345";
const input = { repository: "postil-dev/postil", pr: 7, head, checkRun: 42,
  target, version: "postil 0.9.21", hash, deadline: 1800003600 };
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

type Observation = {
  id: number; status: string; finished: boolean; no_error: boolean; cli_match: boolean;
  public_id: string; advisory: number; gate: number; repository?: string; head?: string;
};
const row = (id: number, changes: Partial<Observation> = {}): Observation => ({
  id, status: "completed", finished: true, no_error: true, cli_match: true,
  public_id: publicId, advisory: 201, gate: 202, ...changes,
});

async function simulate(attempts: readonly (readonly Observation[])[], options: {
  associations?: number; selectedHead?: string; checkHead?: string;
  checkExternalId?: string; previousCount?: number; rerunStatus?: number; advisoryConclusion?: string;
} = {}) {
  let now = 1800000000000;
  let rerequests = 0;
  let output = "";
  let errors = 0;
  let tokenMints = 0;
  const calls: Array<{ path: string; method: string; signal: boolean }> = [];
  const token = randomBytes(32).toString("hex");
  class Client {
    async connect() {}
    async end() {}
    async query(query: string, args: unknown[] = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(query)) return { rows: [] };
      if (query.startsWith("SELECT i.github_installation_id")) return { rows: [{
        installation: 9, suspended: false, repo_id: 10, enabled: true, full_name: input.repository,
      }] };
      if (query.startsWith("SELECT v.id FROM reviews")) return { rows: Array.from({ length: options.previousCount ?? 1 }, () => ({ id: 99 })) };
      if (query.startsWith("SELECT COALESCE")) return { rows: [{ id: 100 }] };
      if (query.startsWith("SELECT v.id, v.public_id")) {
        expect(query).toContain("v.source_github_installation_id=$4");
        expect(query).toContain("v.source_repo_full_name=$5");
        expect(query).toContain("webhookAction");
        expect(query).toContain("v.id>$8");
        const selected = (attempts[rerequests - 1] ?? []).filter(item =>
          item.id > Number(args[7]) && (item.repository ?? input.repository) === args[4] &&
          (item.head ?? input.head) === args[2]);
        return { rows: selected };
      }
      throw Error("unexpected SQL");
    }
  }
  const fetch = async (url: string, request: { method?: string; signal?: AbortSignal }) => {
    const path = new URL(url).pathname;
    const method = request.method ?? "GET";
    calls.push({ path, method, signal: request.signal instanceof AbortSignal });
    let body: unknown;
    let status = 200;
    if (path === "/app") body = { id: 11 };
    else if (path.endsWith("/access_tokens")) { tokenMints++; body = { token }; }
    else if (path === "/repos/postil-dev/postil") body = { id: 10, full_name: input.repository };
    else if (path.endsWith("/pulls/7")) body = { number: 7, state: "open", head: { sha: head }, base: { repo: { id: 10 } } };
    else if (path.endsWith("/check-runs/42")) body = {
      id: 42, head_sha: options.selectedHead ?? head, app: { id: 11 }, name: "postil/review",
      pull_requests: Array.from({ length: options.associations ?? 1 }, () => ({ number: 7, head: { sha: head } })),
    };
    else if (path.endsWith("/rerequest")) { rerequests++; status = options.rerunStatus ?? 201; body = {}; }
    else if (path.endsWith("/check-runs/201") || path.endsWith("/check-runs/202")) {
      const gate = path.endsWith("202");
      body = { id: gate ? 202 : 201, name: gate ? "postil/gate" : "postil/review",
        head_sha: options.checkHead ?? head, app: { id: 11 }, status: "completed",
        external_id: options.checkExternalId ?? `postil:${publicId}:${gate ? "gate" : "review"}`,
        conclusion: gate ? "failure" : options.advisoryConclusion ?? "success" };
    } else throw Error(`unexpected GitHub path ${path}`);
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
  };
  const process = {
    argv: ["bun", Buffer.from(JSON.stringify(input)).toString("base64")],
    env: { DATABASE_URL: randomBytes(24).toString("hex"), GITHUB_APP_ID: "11", GITHUB_APP_PRIVATE_KEY: privateKey },
    stdout: { write: (value: string) => { output += value; } },
    exit: () => { errors++; },
  };
  await runInNewContext(remoteReviewProgram, {
    require: (name: string) => name === "pg" ? { Client } : require(name),
    Buffer, process, fetch, AbortSignal,
    Date: class { static now() { return now; } },
    Bun: { sleep: async (milliseconds: number) => { now += milliseconds + 60000; } },
    console: { error: () => { errors++; } },
  });
  return { output, errors, rerequests, tokenMints, calls };
}

describe("owned hosted release review probe", () => {
  test("accepts a completed target review and both terminal check IDs from that attempt", async () => {
    const accepted = await simulate([[row(101)]]);
    expect(accepted.errors).toBe(0);
    expect(accepted.rerequests).toBe(1);
    expect(JSON.parse(accepted.output)).toMatchObject({ target, version: input.version, hash,
      repository: input.repository, pr: input.pr, head, reviewId: 101,
      advisoryCheckRunId: 201, gateCheckRunId: 202 });
    expect(accepted.calls.every(call => call.signal)).toBe(true);
  });

  test("generated duplicate and reordered observations cannot borrow another attempt or head", async () => {
    for (let seed = 0; seed < 12; seed++) {
      const source = row(101, { cli_match: false });
      const targetRow = row(102);
      const duplicate = row(103, { cli_match: false });
      const second = seed % 2 ? [duplicate, targetRow] : [targetRow, duplicate];
      const observed = await simulate([[source], second]);
      expect(JSON.parse(observed.output).reviewId).toBe(102);
      expect(observed.rerequests).toBe(2);
      const wrong = await simulate([[source], [row(102, { repository: "other/repository" }),
        row(103, { head: randomBytes(20).toString("hex") })]]);
      expect(wrong.output).toBe("");
      expect(wrong.rerequests).toBe(2);
    }
  });

  test.each([
    { attempts: [[row(101, { cli_match: false })]] },
    { attempts: [[row(101, { status: "running", finished: false })]] },
    { attempts: [[]] },
    { attempts: [[row(101), row(102, { status: "running", finished: false })]] },
  ])("missing, source-only or incomplete proof remains inconclusive", async ({ attempts }) => {
    const result = await simulate(attempts);
    expect(result.output).toBe("");
    expect(result.errors).toBeGreaterThan(0);
  });

  test("refuses multi-PR association and local ownership mismatch before rerequest", async () => {
    const multi = await simulate([[row(101)]], { associations: 2 });
    expect(multi.rerequests).toBe(0);
    expect(multi.output).toBe("");
    const unowned = await simulate([[row(101)]], { previousCount: 0 });
    expect(unowned.tokenMints).toBe(0);
    expect(unowned.calls).toHaveLength(0);
  });

  test.each([{ selectedHead: randomBytes(20).toString("hex") },
    { checkHead: randomBytes(20).toString("hex") }, { checkExternalId: "other-attempt" },
    { rerunStatus: 202 }, { advisoryConclusion: "failure" }])("refuses head, check attempt or rerequest mismatch", async options => {
      const result = await simulate([[row(101)]], options);
      expect(result.output).toBe("");
      expect(result.errors).toBeGreaterThan(0);
    });
});
