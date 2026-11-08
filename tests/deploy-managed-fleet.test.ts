import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sameIdentity, selectPhases } from "../scripts/deploy-managed-fleet";

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
if(program.includes('/api/health/dependencies')){
  if(id!=='a0')process.exit(93);
  console.log(JSON.stringify({status:scenario==='web-http'?503:200,ok:scenario!=='web-ok',database:scenario!=='web-db'}));
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
    version,hash:scenario==='worker-hash'&&id==='a2'?'b'.repeat(64):hash}));
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

  test.each(["web-http", "web-ok", "web-db", "worker-hash", "worker-release"])(
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
});
