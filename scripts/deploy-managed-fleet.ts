import { createHash } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";

type Machine = { id: string; config: { metadata: { fly_process_group: string } } };

export function remoteEvalProgram(program: string): string {
  // Direct eval needs a lexical require; Bun's source transform cannot supply it.
  // Resolve application dependencies from the managed image, regardless of cwd.
  return `const require=(await import("node:module")).createRequire("/app/package.json");` +
    `await eval(Buffer.from("${Buffer.from(program).toString("base64")}","base64").toString())`;
}

export function selectPhases(machines: Machine[]) {
  if (machines.length !== 5 || new Set(machines.map(machine => machine.id)).size !== 5) {
    throw new Error("expected five distinct managed machines");
  }
  const members = (group: string) => machines.filter(machine => machine.config.metadata.fly_process_group === group)
    .map(machine => machine.id).sort();
  const web = members("web"), worker = members("worker"), monitor = members("monitor");
  if (web.length !== 2 || worker.length !== 2 || monitor.length !== 1 ||
      machines.some(machine => !/^[0-9a-f]+$/.test(machine.id))) {
    throw new Error("expected exactly two web, two worker and one monitor machines");
  }
  return { firstWeb: web[0]!, sourceWeb: web[1]!, firstWorker: worker[0]!, sourceWorkers: worker,
    first: [web[0]!, worker[0]!], remaining: [web[1]!, worker[1]!, monitor[0]!] };
}

const remoteIdentity = String.raw`const {createHash}=require('node:crypto'); const fs=require('node:fs');
const contract=[process.env.POSTIL_RELEASE_SHA,process.env.POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA,process.env.POSTIL_RELEASE_PROTOCOL,process.env.POSTIL_MANAGED_RELEASE];
const binary=fs.readFileSync('/usr/local/bin/postil');
const version=Bun.spawnSync(['/usr/local/bin/postil','--version'],{stdout:'pipe',stderr:'pipe',timeout:5000});
if(version.exitCode!==0)process.exit(64);
process.stdout.write(JSON.stringify({contract,version:version.stdout.toString().trim(),hash:createHash('sha256').update(binary).digest('hex')}));`;
const remoteDependencies = String.raw`(async()=>{const response=await fetch('http://127.0.0.1:3000/api/health/dependencies',{signal:AbortSignal.timeout(5000)}); const body=await response.json(); process.stdout.write(JSON.stringify({status:response.status,ok:body?.ok===true,database:body?.database==='up'}));})().catch(()=>process.exit(64));`;

export function publicWebhookProbe(targetWeb: string, source: string): string {
  if (!/^[0-9a-f]+$/.test(targetWeb) || !/^[0-9a-f]{40}$/.test(source)) {
    throw new Error("invalid public webhook probe binding");
  }
  // Run on the retained source web so the target cannot authenticate its own key.
  // Missing delivery headers stop the real handler before any database access.
  return String.raw`(async()=>{
    if(process.env.POSTIL_RELEASE_SHA!==${JSON.stringify(source)})throw Error();
    const key=process.env.GITHUB_WEBHOOK_SECRET;
    if(!key)throw Error();
    const body='{}';
    const signature='sha256='+require('node:crypto').createHmac('sha256',key).update(body).digest('hex');
    const response=await fetch('https://postil.dev/api/webhooks/github',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),body,
      headers:{'content-type':'application/json','fly-force-instance-id':${JSON.stringify(targetWeb)},'x-hub-signature-256':signature}});
    const result=await response.json();
    process.stdout.write(JSON.stringify({status:response.status,authenticated:result?.error==='missing delivery headers'}));
  })().catch(()=>process.exit(64));`;
}

function remote(machine: string, program: string): unknown {
  if (!/^[0-9a-f]+$/.test(machine)) throw new Error("invalid managed machine ID");
  const command = `bun -e '${remoteEvalProgram(program)}'`;
  const result = Bun.spawnSync(["flyctl", "machine", "exec", machine, command, "--app", "postil-web", "--timeout", "15"],
    { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  if (result.exitCode !== 0 || result.stdout.length > 4096) throw new Error("managed target probe failed");
  try { return JSON.parse(result.stdout.toString()); }
  catch { throw new Error("managed target probe returned no closed result"); }
}

export function sameIdentity(value: unknown, contract: string[], version: string, hash: string): boolean {
  if (!value || typeof value !== "object") return false;
  const actual = value as { contract?: unknown; version?: unknown; hash?: unknown };
  return Array.isArray(actual.contract) && actual.contract.length === 4 &&
    actual.contract.every((field, index) => field === contract[index]) &&
    actual.version === version && actual.hash === hash;
}

function expectedBinary() {
  const authority = JSON.parse(readFileSync("src/data/public-cli-release.json", "utf8")) as { hostedCliRelease: string };
  const version = `postil ${authority.hostedCliRelease.slice(1)}`;
  const hash = createHash("sha256").update(readFileSync("vendor/postil")).digest("hex");
  return { version, hash };
}

function main() {
  const [mode] = process.argv.slice(2);
  const phase = selectPhases(JSON.parse(readFileSync(`${process.env.RUNNER_TEMP}/postil-source-machines.json`, "utf8")));
  const target = process.env.TARGET_RELEASE_SHA ?? "";
  const source = process.env.SOURCE_RELEASE_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(target) || !/^[0-9a-f]{40}$/.test(source) || target === source) {
    throw new Error("source and target release identities must be exact and distinct");
  }
  const { version, hash } = expectedBinary();
  if (mode === "plan") {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error("missing workflow output path");
    appendFileSync(output, `first-web=${phase.firstWeb}\nfirst-worker=${phase.firstWorker}\nfirst-ids=${phase.first.join(",")}\nremaining-ids=${phase.remaining.join(",")}\ncli-version=${version}\ncli-hash=${hash}\n`);
    return;
  }
  if (mode === "source") {
    const identities = phase.sourceWorkers.map(id => remote(id, remoteIdentity));
    let sourceVersion = "", sourceHash = "";
    let sourceContract: string[] | undefined;
    for (const value of identities) {
      const actual = value as { contract?: unknown; version?: unknown; hash?: unknown };
      if (!Array.isArray(actual.contract) || actual.contract.length !== 4 || actual.contract[0] !== source ||
          typeof actual.contract[1] !== "string" || !/^[0-9a-f]{40}$/.test(actual.contract[1]) ||
          actual.contract[2] !== "additive-publication-hosted-v1" || actual.contract[3] !== "1" ||
          typeof actual.version !== "string" || !/^postil [0-9]+\.[0-9]+\.[0-9]+$/.test(actual.version) ||
          !/^[0-9a-f]{64}$/.test(String(actual.hash)) || actual.version === version) {
        throw new Error("source worker CLI identity is missing or ambiguous");
      }
      if (sourceContract && !sameIdentity(value, sourceContract, sourceVersion, sourceHash)) {
        throw new Error("source worker CLI identities differ");
      }
      sourceContract = actual.contract;
      sourceVersion = actual.version;
      sourceHash = String(actual.hash);
    }
    console.log(JSON.stringify({ sourceWorkers: phase.sourceWorkers.map(id => ({ id, version: sourceVersion, binarySha256: sourceHash })) }));
    return;
  }
  if (mode === "target") {
    const contract = [target, source, "additive-publication-hosted-v1", "1"];
    for (const id of phase.first) {
      if (!sameIdentity(remote(id, remoteIdentity), contract, version, hash)) {
        throw new Error("first target release or CLI identity differs from the qualified image");
      }
    }
    const dependency = remote(phase.firstWeb, remoteDependencies) as { status?: number; ok?: boolean; database?: boolean };
    if (!Number.isInteger(dependency?.status) || dependency.status! < 200 || dependency.status! >= 300 ||
        dependency.ok !== true || dependency.database !== true) {
      throw new Error("first target web dependency readiness failed");
    }
    const webhook = remote(phase.sourceWeb, publicWebhookProbe(phase.firstWeb, source)) as {
      status?: number; authenticated?: boolean;
    };
    if (webhook?.status !== 400 || webhook.authenticated !== true) {
      throw new Error("first target public webhook authentication failed");
    }
    console.log("First target release, CLI, web dependency and public webhook readiness verified.");
    return;
  }
  throw new Error("unknown phased release probe mode");
}

if (import.meta.main) {
  try { main(); }
  catch { console.error("Managed fleet phase probe failed; source peers remain unchanged."); process.exit(1); }
}
