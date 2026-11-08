import { describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { publicWebhookProbe, remoteEvalProgram, sameIdentity, selectPhases } from "../scripts/deploy-managed-fleet";

const source = randomBytes(20).toString("hex");
const target = randomBytes(20).toString("hex");
const binary = randomBytes(128);
const targetHash = createHash("sha256").update(binary).digest("hex");
const helper = resolve("scripts/deploy-managed-fleet.ts");

function execute(mode: "plan" | "source" | "target", scenario = "healthy") {
  const directory = mkdtempSync(join(tmpdir(), "postil-phased-fly-"));
  try {
    mkdirSync(join(directory, "vendor"));
    mkdirSync(join(directory, "src", "data"), { recursive: true });
    writeFileSync(join(directory, "vendor", "postil"), binary);
    writeFileSync(join(directory, "src", "data", "public-cli-release.json"), JSON.stringify({ hostedCliRelease: "v0.9.21" }));
    writeFileSync(join(directory, "postil-source-machines.json"), JSON.stringify([
      { id: "a4", config: { metadata: { fly_process_group: "worker" } } },
      { id: "a3", config: { metadata: { fly_process_group: "monitor" } } },
      { id: "a2", config: { metadata: { fly_process_group: "worker" } } },
      { id: "a1", config: { metadata: { fly_process_group: "web" } } },
      { id: "a0", config: { metadata: { fly_process_group: "web" } } },
    ]));
    const flyctl = join(directory, "flyctl");
    writeFileSync(flyctl, `#!/usr/bin/env bun
const args=process.argv.slice(2);
if(args[0]!=='machine'||args[1]!=='exec')process.exit(91);
const match=args[3]?.match(/Buffer.from\\(\\"([^\\"]+)\\"/);
if(!match)process.exit(92);
const program=Buffer.from(match[1],'base64').toString();
const id=args[2];
const scenario=process.env.TEST_SCENARIO;
const failures=scenario?.startsWith('generated-')?Number(scenario.slice('generated-'.length)):0;
if(program.includes('/api/webhooks/github')){
  if(id!=='a1'||!program.includes('"a0"'))process.exit(95);
  if(scenario==='webhook-transport')process.exit(96);
  console.log(JSON.stringify({status:scenario==='webhook-http'?503:400,
    authenticated:scenario!=='webhook-auth'&&scenario!=='webhook-source'&&!(failures&4)}));
}else if(program.includes('/api/health/dependencies')){
  if(id!=='a0')process.exit(93);
  console.log(JSON.stringify({status:scenario==='web-http'?503:200,ok:scenario!=='web-ok',database:scenario!=='web-db'&&!(failures&2)}));
}else if(program.includes('POSTIL_RELEASE_SHA')){
  const target=process.env.TEST_MODE==='target';
  const release=target?process.env.TARGET_RELEASE_SHA:process.env.SOURCE_RELEASE_SHA;
  const version=target?'postil 0.9.21':scenario==='ambiguous-source'?'postil 0.9.21':'postil 0.9.17';
  const hash=target?process.env.TEST_TARGET_HASH:scenario==='source-mismatch'&&id==='a4'?'b'.repeat(64):'a'.repeat(64);
  const contract=[scenario==='worker-release'&&id==='a2'?'b'.repeat(40):release,
    process.env.SOURCE_RELEASE_SHA,'additive-publication-hosted-v1','1'];
  if(scenario==='source-compatible'&&id==='a4')contract[1]='b'.repeat(40);
  if(scenario==='source-protocol')contract[2]='unknown-protocol';
  if(scenario==='source-managed')contract[3]='0';
  if(scenario==='source-shape')contract.push('unexpected');
  console.log(JSON.stringify({contract,
    version,hash:(scenario==='worker-hash'||(failures&1))&&id==='a2'?'b'.repeat(64):hash}));
}else process.exit(94);
`);
    chmodSync(flyctl, 0o755);
    const result = Bun.spawnSync(["bun", helper, mode], { cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 10_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory,
        GITHUB_OUTPUT: join(directory, "output"), TARGET_RELEASE_SHA: target, SOURCE_RELEASE_SHA: source,
        TEST_TARGET_HASH: targetHash, TEST_MODE: mode, TEST_SCENARIO: scenario } });
    let output = "";
    try { output = readFileSync(join(directory, "output"), "utf8"); } catch { /* failed before output */ }
    return { code: result.exitCode, error: result.stderr.toString(), stdout: result.stdout.toString(), output };
  } finally { rmSync(directory, { recursive: true }); }
}

describe("phased managed fleet helper", () => {
  test.each([false, true])("executes the emitted Bun module context with async=%s", asynchronous => {
    const argument = randomBytes(24).toString("hex");
    const body = `const {createHash}=require('node:crypto');
      process.stdout.write(JSON.stringify({argument:process.argv[1],
        hash:createHash('sha256').update(process.argv[1]).digest('hex'),
        dependency:require('node:path').basename('/probe/item')}));`;
    const program = asynchronous ? `(async()=>{await Bun.sleep(5);${body}})()` : body;
    const result = Bun.spawnSync(["bun", "-e", remoteEvalProgram(program), argument], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3000,
      env: { PATH: process.env.PATH },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ argument,
      hash: createHash("sha256").update(argument).digest("hex"), dependency: "item" });
    expect(result.stderr.length).toBe(0);
  });

  test("the emitted Bun loader preserves program failure", () => {
    const result = Bun.spawnSync(["bun", "-e", remoteEvalProgram("throw Error('probe rejected')")], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3000,
      env: { PATH: process.env.PATH },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.toString()).toContain("probe rejected");
  });

  test("deterministically selects the approved two web, two worker and monitor fleet", () => {
    const machines = ["worker", "monitor", "web", "worker", "web"].map((group, index) =>
      ({ id: `a${4 - index}`, config: { metadata: { fly_process_group: group } } }));
    const phases = selectPhases(machines);
    expect(phases.first).toEqual(["a0", "a1"]);
    expect(new Set([...phases.first, ...phases.remaining]).size).toBe(5);
    expect(() => selectPhases([...machines.slice(0, 4), machines[0]!])).toThrow();
  });

  test("source CLI identity must be distinguishable before phase one", () => {
    const observed = execute("source");
    expect(observed.code).toBe(0);
    expect(JSON.parse(observed.stdout).sourceWorkers).toEqual([
      { id: "a2", version: "postil 0.9.17", binarySha256: "a".repeat(64) },
      { id: "a4", version: "postil 0.9.17", binarySha256: "a".repeat(64) },
    ]);
    const ambiguous = execute("source", "ambiguous-source");
    expect(ambiguous.code).not.toBe(0);
    expect(ambiguous.error).toContain("phase probe failed");
    expect(execute("source", "source-mismatch").code).not.toBe(0);
  });

  test.each(["web-http", "web-ok", "web-db", "worker-hash", "worker-release",
    "webhook-http", "webhook-auth", "webhook-source", "webhook-transport"])(
    "rejects exact first-target %s failure before peers", scenario => {
      const result = execute("target", scenario);
      expect(result.code).not.toBe(0);
      expect(result.output).toBe("");
    });

  test.each(["source-compatible", "source-protocol", "source-managed", "source-shape"])(
    "rejects incomplete or inconsistent %s contracts before phase one", scenario => {
      expect(execute("source", scenario).code).not.toBe(0);
    });

  test("target contract, binary and dependency proof all succeed together", () => {
    const result = execute("target");
    expect(result.code, result.error).toBe(0);
    expect(result.stdout).toContain("verified");
    const plan = execute("plan");
    expect(plan.code, plan.error).toBe(0);
    expect(plan.output).toContain("first-ids=a0,a2");
    expect(plan.output).toContain("remaining-ids=a1,a4,a3");
    expect(plan.output).toContain(`cli-hash=${targetHash}`);
  });

  test("identity comparison requires every release field and actual CLI hash", () => {
    const contract = [target, source, "additive-publication-hosted-v1", "1"];
    const identity = { contract, version: "postil 0.9.21", hash: targetHash };
    expect(sameIdentity(identity, contract, identity.version, targetHash)).toBe(true);
    for (let field = 0; field < 4; field++) {
      const wrong = { ...identity, contract: [...contract] };
      wrong.contract[field] = "wrong";
      expect(sameIdentity(wrong, contract, identity.version, targetHash)).toBe(false);
    }
    expect(sameIdentity({ ...identity, hash: "0".repeat(64) }, contract, identity.version, targetHash)).toBe(false);
  });

  test.each(Array.from({ length: 8 }, (_, failures) => failures))(
    "requires every first-target barrier with generated failure mask %i", failures => {
      const result = execute("target", `generated-${failures}`);
      expect(result.code === 0).toBe(failures === 0);
      expect(result.stdout.includes("verified")).toBe(failures === 0);
      expect(result.output).toBe("");
    });

  test.each(["authenticated", "unauthorized", "wrong-response", "redirect", "wrong-source", "missing-key", "network"])(
    "executes the emitted public webhook probe with %s", async scenario => {
      const key = randomBytes(24).toString("hex");
      let requests = 0;
      let requestIsBound = false;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        requests++;
        const body = await request.text();
        requestIsBound = new URL(request.url).pathname === "/api/webhooks/github" &&
          request.method === "POST" && body === "{}" &&
          request.headers.get("fly-force-instance-id") === "a0" &&
          request.headers.get("x-hub-signature-256") ===
            `sha256=${createHmac("sha256", key).update(body).digest("hex")}` &&
          !request.headers.has("x-github-delivery") && !request.headers.has("x-github-event");
        if (scenario === "redirect") return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
        return Response.json({ error: scenario === "unauthorized" ? "invalid signature" :
          scenario === "wrong-response" ? "invalid payload" : "missing delivery headers" },
        { status: scenario === "unauthorized" ? 401 : 400 });
      } });
      try {
        const wrapper = `const originalFetch=globalThis.fetch;
          globalThis.fetch=(url,options)=>{
            if(url!=='https://postil.dev/api/webhooks/github'||options.redirect!=='error'||!options.signal)throw Error();
            if(${scenario === "network"})throw Error();
            return originalFetch(${JSON.stringify(server.url.toString())}+'api/webhooks/github',options);
          };`;
        const child = Bun.spawn(["bun", "-e", wrapper + publicWebhookProbe("a0", source)], {
          stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3000,
          env: { PATH: process.env.PATH, HOME: process.env.HOME,
            POSTIL_RELEASE_SHA: scenario === "wrong-source" ? target : source,
            ...(scenario === "missing-key" ? {} : { GITHUB_WEBHOOK_SECRET: key }) },
        });
        const [code, output, error] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect(output.includes(key) || error.includes(key)).toBe(false);
        if (["wrong-source", "missing-key", "network"].includes(scenario)) {
          expect(code).toBe(64);
          expect(requests).toBe(0);
        } else {
          expect(requests).toBe(1);
          expect(requestIsBound).toBe(true);
          if (scenario === "redirect") {
            expect(code).toBe(64);
            expect(output).toBe("");
          } else {
            expect(code).toBe(0);
            expect(JSON.parse(output)).toEqual({ status: scenario === "unauthorized" ? 401 : 400,
              authenticated: scenario === "authenticated" });
          }
        }
      } finally { server.stop(true); }
    });
});
