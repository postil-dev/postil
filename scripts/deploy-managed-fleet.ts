import { createHash } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";

type Machine = { id: string; config: { metadata: { fly_process_group: string } } };

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
  return { firstWeb: web[0]!, firstWorker: worker[0]!, sourceWorkers: worker,
    first: [web[0]!, worker[0]!], remaining: [web[1]!, worker[1]!, monitor[0]!] };
}

const remoteIdentity = String.raw`const {createHash}=require('node:crypto'); const fs=require('node:fs');
const contract=[process.env.POSTIL_RELEASE_SHA,process.env.POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA,process.env.POSTIL_RELEASE_PROTOCOL,process.env.POSTIL_MANAGED_RELEASE];
const binary=fs.readFileSync('/usr/local/bin/postil');
const version=Bun.spawnSync(['/usr/local/bin/postil','--version'],{stdout:'pipe',stderr:'pipe',timeout:5000});
if(version.exitCode!==0)process.exit(64);
process.stdout.write(JSON.stringify({contract,version:version.stdout.toString().trim(),hash:createHash('sha256').update(binary).digest('hex')}));`;
const remoteDependencies = String.raw`(async()=>{const response=await fetch('http://127.0.0.1:3000/api/health/dependencies',{signal:AbortSignal.timeout(5000)}); const body=await response.json(); process.stdout.write(JSON.stringify({status:response.status,ok:body?.ok===true,database:body?.database==='up'}));})().catch(()=>process.exit(64));`;

function remote(machine: string, program: string): unknown {
  if (!/^[0-9a-f]+$/.test(machine)) throw new Error("invalid managed machine ID");
  const command = `bun -e 'eval(Buffer.from("${Buffer.from(program).toString("base64")}","base64").toString())'`;
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
    for (const value of identities) {
      const actual = value as { contract?: unknown; version?: unknown; hash?: unknown };
      if (!Array.isArray(actual.contract) || actual.contract[0] !== source ||
          typeof actual.version !== "string" || !/^postil [0-9]+\.[0-9]+\.[0-9]+$/.test(actual.version) ||
          !/^[0-9a-f]{64}$/.test(String(actual.hash)) || actual.version === version) {
        throw new Error("source worker CLI identity is missing or ambiguous");
      }
      if (sourceVersion && (actual.version !== sourceVersion || actual.hash !== sourceHash)) {
        throw new Error("source worker CLI identities differ");
      }
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
    console.log("First target release, CLI and web dependency readiness verified.");
    return;
  }
  throw new Error("unknown phased release probe mode");
}

if (import.meta.main) {
  try { main(); }
  catch { console.error("Managed fleet phase probe failed; source peers remain unchanged."); process.exit(1); }
}
