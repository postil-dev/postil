import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { verifyManagedImageBinding } from "../scripts/start-managed-process";
import { runReleaseMigrations } from "../scripts/run-release-migrations";

const workflow = parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
const steps = workflow.jobs.deploy.steps as Array<{ id?: string; name?: string; run?: string }>;
const sourceSha = "35dd695af19e817bd7b87be5be808b45cefaa7a7";
const targetSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const sourceImage = `registry.fly.io/postil-web@${digest}`;
const secretMetadata = [{ name: "DATABASE_URL", digest: "fixture-digest", status: "Deployed" }];
const binding = {
  POSTIL_MANAGED_RELEASE: "1",
  POSTIL_RELEASE_SHA: targetSha,
  POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA: sourceSha,
  POSTIL_RELEASE_PROTOCOL: "additive-publication-hosted-v1",
};
function fleet() {
  return ["web", "web", "worker", "monitor"].map((group, index) => ({
    id: `a${index}`, state: "started", host_status: "ok", release: sourceSha,
    image_ref: { registry: "registry.fly.io", repository: "postil-web", digest },
    checks: [{ status: "passing" }],
    config: {
      image: sourceImage,
      metadata: { fly_platform_version: "v2", fly_process_group: group },
      env: { POSTIL_HOSTED_INFERENCE_ENABLED: "1", POSTIL_PROVISIONAL_HOSTED_ROSTER: "1" },
      mounts: group === "monitor" ? [{ volume: "vol_test", path: "/var/lib/postil-monitor" }] : [],
    },
  }));
}

function runStep(id: string, machines = fleet(), snapshot = fleet(), secrets = secretMetadata,
  afterExecSecrets?: typeof secretMetadata, statusMachines = machines) {
  const directory = mkdtempSync(join(tmpdir(), "postil-deploy-test-"));
  try {
    writeFileSync(join(directory, "machines.json"), JSON.stringify(machines));
    writeFileSync(join(directory, "postil-source-machines.json"), JSON.stringify(snapshot));
    writeFileSync(join(directory, "postil-source-secrets.json"), JSON.stringify(secretMetadata));
    writeFileSync(join(directory, "secrets.json"), JSON.stringify(secrets));
    writeFileSync(join(directory, "status-machines.json"), JSON.stringify(statusMachines));
    if (afterExecSecrets) writeFileSync(join(directory, "after-exec-secrets.json"), JSON.stringify(afterExecSecrets));
    const script = steps.find((step) => step.id === id)?.run;
    if (!script) throw new Error(`missing workflow step ${id}`);
    const result = Bun.spawnSync(["bash", "-c", `
      flyctl() {
        case "$1 $2" in
          "machine list") cat "$RUNNER_TEMP/machines.json" ;;
          "secrets list") cat "$RUNNER_TEMP/secrets.json" ;;
          "deploy --remote-only") printf 'deploy' >> "$RUNNER_TEMP/updates" ;;
          "machine exec")
            if [[ -f "$RUNNER_TEMP/after-exec-secrets.json" ]]; then cp "$RUNNER_TEMP/after-exec-secrets.json" "$RUNNER_TEMP/secrets.json"; fi
            jq -jr --arg id "$3" '.[] | select(.id == $id) | .release' "$RUNNER_TEMP/machines.json" ;;
          "machine status") jq --arg id "$3" '.[] | select(.id == $id)' "$RUNNER_TEMP/status-machines.json" ;;
          "machine update")
            printf '%s\\n' "$*" >> "$RUNNER_TEMP/updates"
            jq --arg id "$3" --arg image "$SOURCE_IMAGE" --arg sha "$SOURCE_RELEASE_SHA" '
              map(if .id == $id then .config.image = $image | .image_ref.digest = ($image | split("@")[1]) | .release = $sha else . end)
            ' "$RUNNER_TEMP/machines.json" > "$RUNNER_TEMP/next.json"
            mv "$RUNNER_TEMP/next.json" "$RUNNER_TEMP/machines.json"
            cp "$RUNNER_TEMP/machines.json" "$RUNNER_TEMP/status-machines.json" ;;
          *) return 98 ;;
        esac
      }
      ${script}
    `], {
      env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, "output"),
        TARGET_RELEASE_SHA: targetSha, SOURCE_RELEASE_SHA: sourceSha, SOURCE_IMAGE: sourceImage, POSTIL_CLI_TAG: "v0.9.4" },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const read = (name: string) => { try { return readFileSync(join(directory, name), "utf8"); } catch { return ""; } };
    return { code: result.exitCode, error: result.stderr.toString(), output: read("output"), updates: read("updates"), machines: JSON.parse(read("machines.json")) };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("managed deployment contract", () => {
  test("binds checkout, build, and verification to the triggering workflow SHA", () => {
    expect(workflow.jobs.deploy.env.TARGET_RELEASE_SHA).toBe("${{ github.event.workflow_run.head_sha || github.sha }}");
    const source = readFileSync(".github/workflows/deploy.yml", "utf8");
    expect(source).not.toContain("${GITHUB_SHA}");
    expect(source).not.toContain("--skip-release-command");
    expect(source).not.toMatch(/flyctl secrets (import|unset|set)/);
    expect(source).not.toContain("Infisical/secrets-action");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toContain("flyctl machine start");
    expect(steps.some((step) => step.id === "recover")).toBe(false);
    for (const step of steps.filter((step) => step.run)) {
      expect(Bun.spawnSync(["bash", "-n"], { stdin: new Blob([step.run!]), stderr: "pipe" }).exitCode).toBe(0);
    }
  });

  test("captures deployed secret metadata and rejects staged, partial, unknown, or missing proof", () => {
    expect(runStep("secret-contract").code).toBe(0);
    for (const secrets of [
      [{ ...secretMetadata[0]!, status: "Staged" }],
      [{ ...secretMetadata[0]!, status: "Partial" }],
      [{ ...secretMetadata[0]!, status: "Unknown" }],
      [{ ...secretMetadata[0]!, status: "" }],
      [{ ...secretMetadata[0]!, digest: "" }],
      [{ ...secretMetadata[0]!, name: "POSTIL_RELEASE_SHA" }],
      [],
    ]) {
      const result = runStep("secret-contract", fleet(), fleet(), secrets);
      expect(result.code).not.toBe(0);
      expect(result.updates).toBe("");
    }
  });

  test("checks secret names, digests, and deployment status before deploy or rollback", () => {
    expect(runStep("deploy").updates).toBe("deploy");
    for (const id of ["deploy", "rollback"]) {
      for (const secrets of [
        [{ ...secretMetadata[0]!, status: "Staged" }],
        [{ ...secretMetadata[0]!, digest: "changed-digest" }],
        [...secretMetadata, { name: "NEW_SETTING", digest: "new-digest", status: "Deployed" }],
        [],
      ]) {
        const result = runStep(id, fleet(), fleet(), secrets);
        expect(result.code).not.toBe(0);
        expect(result.updates).toBe("");
      }
    }
    const machines = fleet();
    machines[2]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
    machines[2]!.release = targetSha;
    const result = runStep("rollback", machines, fleet(), secretMetadata, [{ ...secretMetadata[0]!, status: "Staged" }]);
    expect(result.code).not.toBe(0);
    expect(result.updates).toBe("");
  });

  test("refuses original configuration drift and unproven images without starting machines", () => {
    for (const change of [
      (machines: ReturnType<typeof fleet>) => { machines[2]!.config.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0"; },
      (machines: ReturnType<typeof fleet>) => { Object.assign(machines[2]!.config, { init: { cmd: ["unexpected"] } }); },
      (machines: ReturnType<typeof fleet>) => { Object.assign(machines[2]!.config.metadata, { custom: "unexpected" }); },
      (machines: ReturnType<typeof fleet>) => { machines[2]!.config.mounts.push({ volume: "unexpected", path: "/data" }); },
      (machines: ReturnType<typeof fleet>) => { machines[2]!.image_ref.digest = `sha256:${"d".repeat(64)}`; },
      (machines: ReturnType<typeof fleet>) => { machines[2]!.state = "stopped"; },
    ]) {
      const machines = fleet(); change(machines);
      const result = runStep("rollback", machines);
      expect(result.code).not.toBe(0);
      expect(result.updates).toBe("");
    }
    const changedAfterList = fleet();
    changedAfterList[0]!.config.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0";
    const result = runStep("rollback", fleet(), fleet(), secretMetadata, undefined, changedAfterList);
    expect(result.code).not.toBe(0);
    expect(result.updates).toBe("");
  });

  test("allows only image and Fly-generated release metadata differences", () => {
    const machines = fleet();
    machines[2]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
    machines[2]!.release = targetSha;
    Object.assign(machines[2]!.config.metadata, {
      fly_release_id: "generated-release", fly_release_version: "2", fly_flyctl_version: "0.4.71",
    });
    const result = runStep("rollback", machines);
    expect(result.code, result.error).toBe(0);
    expect(result.updates).toContain("machine update a2");
  });

  test("requires a healthy homogeneous exact predecessor and immutable image", () => {
    const accepted = runStep("source-fleet");
    expect(accepted.code, accepted.error).toBe(0);
    expect(accepted.output).toContain(`release-sha=${sourceSha}`);
    expect(accepted.output).toContain(`image=${sourceImage}`);
    for (const change of [
      (machines: ReturnType<typeof fleet>) => { machines[1]!.release = targetSha; },
      (machines: ReturnType<typeof fleet>) => { for (const m of machines) m.release = "a".repeat(7); },
      (machines: ReturnType<typeof fleet>) => { machines[1]!.state = "stopped"; },
      (machines: ReturnType<typeof fleet>) => { machines[1]!.checks[0]!.status = "critical"; },
      (machines: ReturnType<typeof fleet>) => { machines[1]!.image_ref.digest = ""; },
    ]) {
      const machines = fleet(); change(machines);
      const rejected = runStep("source-fleet", machines);
      expect(rejected.code).not.toBe(0);
      expect(rejected.updates).toBe("");
    }
  });

  test("rolls back only changed captured machines by digest and retains configuration and volumes", () => {
    const machines = fleet();
    machines[2]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
    machines[2]!.config.image = `registry.fly.io/postil-web@${machines[2]!.image_ref.digest}`;
    machines[2]!.release = targetSha;
    const result = runStep("rollback", machines);
    expect(result.code, result.error).toBe(0);
    expect(result.updates.trim()).toBe(`machine update a2 --app postil-web --image ${sourceImage} --wait-timeout 120 --yes`);
    expect(result.machines).toEqual(fleet());
    const taggedSource = fleet();
    for (const machine of taggedSource) machine.config.image = "registry.fly.io/postil-web:source";
    const mixed = structuredClone(taggedSource);
    mixed[2] = machines[2]!;
    expect(runStep("rollback", mixed, taggedSource).code).toBe(0);
    const changedVolumes = fleet(); changedVolumes[3]!.config.mounts[0]!.volume = "vol_unexpected";
    const rejected = runStep("rollback", changedVolumes);
    expect(rejected.code).not.toBe(0);
    expect(rejected.updates).toBe("");
  });

  test("rejects managed runtime overrides and missing identities before startup", () => {
    expect(() => verifyManagedImageBinding(binding, binding)).not.toThrow();
    for (const name of Object.keys(binding)) {
      expect(() => verifyManagedImageBinding(binding, { ...binding, [name]: "" })).toThrow();
    }
    expect(() => verifyManagedImageBinding(binding, { ...binding, POSTIL_MANAGED_RELEASE: "0" })).toThrow();
    expect(() => verifyManagedImageBinding(null, { POSTIL_MANAGED_RELEASE: "1" })).toThrow();
    expect(() => verifyManagedImageBinding({ POSTIL_MANAGED_RELEASE: "0" }, { POSTIL_MANAGED_RELEASE: "0", POSTIL_RELEASE_SHA: "telemetry", FLY_APP_NAME: "self-hosted-app" })).not.toThrow();
    const docker = readFileSync("Dockerfile", "utf8");
    expect(docker).toContain("ARG POSTIL_MANAGED_RELEASE=0");
    const imageWriter = docker.match(/RUN bun -e '(.+Bun.write.+)'/)!;
    expect(() => new Bun.Transpiler().transformSync(imageWriter[1]!, "js")).not.toThrow();
  });

  test("managed default activation rejects a missing contract", () => {
    const environment: Record<string, string | undefined> = { ...process.env, POSTIL_MANAGED_RELEASE: "1" };
    delete environment.POSTIL_RELEASE_SHA;
    delete environment.POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA;
    const result = Bun.spawnSync(["bun", "scripts/activate-release-jobs.ts"], {
      env: environment, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("rolling release verification requires");
  });

  test("preserves unmanaged migration commands with an informational release SHA", async () => {
    for (const marker of [undefined, "0"]) {
      const commands: string[][] = [];
      await runReleaseMigrations({ DATABASE_URL: "postgresql://local@localhost/test", POSTIL_MANAGED_RELEASE: marker, POSTIL_RELEASE_SHA: "telemetry" },
        (command) => { commands.push([...command]); return { exited: Promise.resolve(0) }; },
        async () => { throw new Error("unmanaged release must not verify a managed protocol"); });
      expect(commands.map((command) => command[2])).toEqual(["db:migrate", "operational:indexes", "notifications:quiesce"]);
    }
  });
});
