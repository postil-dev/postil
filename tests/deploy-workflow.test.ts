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
const stagedFeedback = { name: "POSTIL_REVIEW_FEEDBACK_ENABLED", digest: "feedback-digest", status: "Staged" };
const deployedFeedback = { ...stagedFeedback, status: "Deployed" };
const approvedMachineIds = ["a0", "a1", "a2", "a3", "a4"];
const binding = {
  POSTIL_MANAGED_RELEASE: "1",
  POSTIL_RELEASE_SHA: targetSha,
  POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA: sourceSha,
  POSTIL_RELEASE_PROTOCOL: "additive-publication-hosted-v1",
};
function fleet() {
  return ["web", "web", "worker", "monitor", "worker"].map((group, index) => ({
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
  afterExecSecrets?: typeof secretMetadata, statusMachines = machines, afterUpdateMachines?: ReturnType<typeof fleet>, deadlineEnvironment: Record<string, string> = {}, sourceSecrets = secretMetadata) {
  const directory = mkdtempSync(join(tmpdir(), "postil-deploy-test-"));
  try {
    writeFileSync(join(directory, "machines.json"), JSON.stringify(machines));
    writeFileSync(join(directory, "postil-source-machines.json"), JSON.stringify(snapshot));
    writeFileSync(join(directory, "postil-source-secrets.json"), JSON.stringify(sourceSecrets));
    writeFileSync(join(directory, "secrets.json"), JSON.stringify(secrets));
    writeFileSync(join(directory, "status-machines.json"), JSON.stringify(statusMachines));
    if (afterUpdateMachines) writeFileSync(join(directory, "after-update-machines.json"), JSON.stringify(afterUpdateMachines));
    if (afterExecSecrets) writeFileSync(join(directory, "after-exec-secrets.json"), JSON.stringify(afterExecSecrets));
    const script = steps.find((step) => step.id === id)?.run;
    if (!script) throw new Error(`missing workflow step ${id}`);
    const volumePredicate = script.match(/\(\.name \/\/ \.Name\) == "([^"]+)" and \(\.region \/\/ \.Region\) == "([^"]+)"/);
    writeFileSync(join(directory, "volumes.json"), JSON.stringify(volumePredicate
      ? [{ name: volumePredicate[1], region: volumePredicate[2], id: "vol_test" }]
      : []));
    const result = Bun.spawnSync(["bash", "-c", `
      date() { printf '%s\\n' "$TEST_NOW_EPOCH"; }
      sleep() { printf '%s\\n' "$1" >> "$RUNNER_TEMP/sleeps"; }
      flyctl() {
        case "$1 $2" in
          "volumes list") cat "$RUNNER_TEMP/volumes.json" ;;
          "volumes create") printf 'volume-create' >> "$RUNNER_TEMP/updates" ;;
          "machine list")
            if [[ -f "$RUNNER_TEMP/list-observed" ]]; then
              cat "$RUNNER_TEMP/status-machines.json"
            else
              touch "$RUNNER_TEMP/list-observed"
              cat "$RUNNER_TEMP/machines.json"
            fi ;;
          "secrets list") cat "$RUNNER_TEMP/secrets.json" ;;
          "deploy --remote-only") printf 'deploy' >> "$RUNNER_TEMP/updates" ;;
          "machine exec")
            if [[ "$4" == "bun run jobs:activate-release" ]]; then printf 'activate' >> "$RUNNER_TEMP/updates"; return 0; fi
            local count_file="$RUNNER_TEMP/exec-$3" count=0
            [[ ! -f "$count_file" ]] || read -r count < "$count_file"
            count=$((count + 1))
            printf '%s\\n' "$count" > "$count_file"
            printf '%s\\n' "$3" >> "$RUNNER_TEMP/exec-calls"
            if [[ "\${TEST_FAIL_RESTORED:-0}" == "1" && -f "$RUNNER_TEMP/updates" && "$3" == "a0" ]]; then return 1; fi
            if (( count <= \${TEST_EXEC_FAILURES:-0} )); then printf 'partial failed output'; return 1; fi
            if [[ "\${TEST_EXEC_WRONG:-0}" == "1" ]]; then printf 'wrong'; return 0; fi
            if [[ -f "$RUNNER_TEMP/after-exec-secrets.json" ]]; then cp "$RUNNER_TEMP/after-exec-secrets.json" "$RUNNER_TEMP/secrets.json"; fi
            if [[ "$4" == *'JSON.stringify(contract)'* ]]; then
              jq -cn --arg target "$TARGET_RELEASE_SHA" --arg source "$SOURCE_RELEASE_SHA" '[$target, $source, "additive-publication-hosted-v1", "1"]'
              return 0
            fi
            if jq -e --arg id "$3" '.[] | select(.id == $id and (.state == "stopped" or .exec_unavailable == true))' "$RUNNER_TEMP/machines.json" >/dev/null; then
              return 1
            fi
            jq -er --arg id "$3" '.[] | select(.id == $id and .state != "stopped") | .release' "$RUNNER_TEMP/machines.json" ;;
          "machine status") echo 'Error: unknown flag: --json' >&2; return 64 ;;
          "machine update")
            printf '%s\\n' "$*" >> "$RUNNER_TEMP/updates"
            jq --arg id "$3" --arg image "$SOURCE_IMAGE" --arg sha "$SOURCE_RELEASE_SHA" '
              map(if .id == $id then .config.image = $image | .image_ref.digest = ($image | split("@")[1]) | .release = $sha | .state = "started" | .host_status = "ok" | (.checks[]?.status) = "passing" else . end)
            ' "$RUNNER_TEMP/machines.json" > "$RUNNER_TEMP/next.json"
            mv "$RUNNER_TEMP/next.json" "$RUNNER_TEMP/machines.json"
            if [[ -f "$RUNNER_TEMP/after-update-machines.json" ]]; then
              cp "$RUNNER_TEMP/after-update-machines.json" "$RUNNER_TEMP/status-machines.json"
            else
              cp "$RUNNER_TEMP/machines.json" "$RUNNER_TEMP/status-machines.json"
            fi ;;
          *) return 98 ;;
        esac
      }
      ${script}
    `], {
      env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, "output"),
        TARGET_RELEASE_SHA: targetSha, SOURCE_RELEASE_SHA: sourceSha, SOURCE_IMAGE: sourceImage, POSTIL_CLI_TAG: "v0.9.4", MONITOR_VOLUME_ID: "vol_test", TEST_NOW_EPOCH: "1800000000",
        ROLLBACK_DEADLINE_EPOCH: "1800004000", ROLLBACK_TARGET_SHA: targetSha,
        APPROVED_MACHINE_IDS: JSON.stringify(approvedMachineIds), ...deadlineEnvironment },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const read = (name: string) => { try { return readFileSync(join(directory, name), "utf8"); } catch { return ""; } };
    return { code: result.exitCode, error: result.stderr.toString(), stdout: result.stdout.toString(), output: read("output"), calls: read("exec-calls"), sleeps: read("sleeps"), updates: read("updates"), machines: JSON.parse(read("machines.json")) };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("managed deployment contract", () => {
  test.each(["verify", "rollback"])("%s retries transient reads but rejects persistent failure and wrong identity", (id) => {
    const machines = fleet();
    if (id === "rollback") {
      machines[1]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
      machines[1]!.release = targetSha;
    }
    const execute = (environment: Record<string, string>) => runStep(id, structuredClone(machines), fleet(), secretMetadata,
      undefined, structuredClone(machines), undefined, environment);
    const recovered = execute({ TEST_EXEC_FAILURES: "2" });
    expect(recovered.code, recovered.error).toBe(0);
    expect(recovered.sleeps.trim().split("\n").every(value => value === "2")).toBe(true);
    expect(recovered.stdout).not.toContain("partial failed output");
    expect(recovered.calls.trim().split("\n").filter(value => value === "a1").length).toBe(id === "verify" ? 3 : 4);
    const unavailable = execute({ TEST_EXEC_FAILURES: "99" });
    expect(unavailable.code).not.toBe(0);
    expect(unavailable.calls.trim().split("\n")).toHaveLength(3);
    expect(unavailable.sleeps.trim().split("\n")).toHaveLength(2);
    expect(unavailable.updates).toBe("");
    const wrong = execute({ TEST_EXEC_WRONG: "1" });
    expect(wrong.code).not.toBe(0);
    expect(wrong.calls.trim().split("\n")).toHaveLength(1);
    expect(wrong.sleeps).toBe("");
    expect(wrong.updates).toBe("");
  });

  test("rollback fails closed when restored runtime remains unavailable", () => {
    const machines = fleet();
    machines[1]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
    machines[1]!.release = targetSha;
    const result = runStep("rollback", machines, fleet(), secretMetadata, undefined, machines, undefined,
      { TEST_FAIL_RESTORED: "1" });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("A restored machine did not report its release SHA");
    expect(result.calls.trim().split("\n").filter(id => id === "a0")).toHaveLength(3);
    expect(result.sleeps.trim().split("\n")).toHaveLength(2);
    expect(result.updates.trim().split("\n")).toHaveLength(1);
  });

  test("runtime retries retain bounded request and workflow timeouts", () => {
    expect(readFileSync("scripts/probe-managed-runtime.sh", "utf8")).toContain("--timeout 15");
    expect(workflow.jobs.deploy.steps.find((step: any) => step.id === "verify")["timeout-minutes"]).toBe(5);
    expect(workflow.jobs.deploy.steps.find((step: any) => step.id === "rollback")["timeout-minutes"]).toBe(10);
  });

  test("requires manual target-bound admission and never rolls back an unattempted deploy", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    for (const input of ["machine_ids", "rollback_deadline_epoch", "rollback_target_sha"]) {
      expect(workflow.on.workflow_dispatch.inputs[input]).toMatchObject({ required: true, type: "string" });
    }
    expect(workflow.jobs.deploy.if).toBe("vars.FLY_DEPLOY_ENABLED == 'true' && github.event_name == 'workflow_dispatch'");
    expect(workflow.jobs.deploy.env.ROLLBACK_DEADLINE_EPOCH).toBe("${{ inputs.rollback_deadline_epoch }}");
    expect(workflow.jobs.deploy.env.ROLLBACK_TARGET_SHA).toBe("${{ inputs.rollback_target_sha }}");
    expect(workflow.jobs.deploy.env.APPROVED_MACHINE_IDS).toBe("${{ inputs.machine_ids }}");
    expect(workflow.jobs.deploy.steps.find((step: any) => step.id === "rollback").if).toContain("steps.deploy.outputs.attempted == 'true'");
  });

  test.each(["monitor-volume", "deploy", "activate", "rollback"])("%s rejects invalid or stale admission without mutation", (id) => {
    const rejected: Record<string, string>[] = [
      { ROLLBACK_DEADLINE_EPOCH: "" }, { ROLLBACK_DEADLINE_EPOCH: "yesterday" },
      { ROLLBACK_DEADLINE_EPOCH: "1800009999; exit 0" }, { ROLLBACK_DEADLINE_EPOCH: "01800004000" },
      { ROLLBACK_DEADLINE_EPOCH: "1799999999" }, { ROLLBACK_DEADLINE_EPOCH: "1800000000" },
      { ROLLBACK_DEADLINE_EPOCH: "99999999999999999999" }, { ROLLBACK_TARGET_SHA: "" },
      { ROLLBACK_TARGET_SHA: "b".repeat(40) }, { TEST_NOW_EPOCH: "invalid" },
    ];
    for (const environment of rejected) {
      const result = runStep(id, fleet(), fleet(), secretMetadata, undefined, fleet(), undefined, environment);
      expect(result.code).not.toBe(0);
      expect(result.updates).toBe("");
      expect(result.output).not.toContain("attempted=true");
    }
  });

  test.each([["monitor-volume", 2400], ["deploy", 2100], ["activate", 1200], ["rollback", 900]] as const)("%s enforces its complete boundary", (id, window) => {
    for (const offset of [-1, 0, 1]) {
      const result = runStep(id, fleet(), fleet(), secretMetadata, undefined, fleet(), undefined,
        { ROLLBACK_DEADLINE_EPOCH: String(1800000000 + window + offset) });
      expect(result.code, result.error).toBe(offset < 0 ? 1 : 0);
      expect(result.updates).toBe(offset >= 0 && ["deploy", "activate"].includes(id) ? id : "");
      if (id === "deploy" && offset >= 0) expect(result.output).toContain("attempted=true");
    }
  });

  test.each([["activate", 1200], ["rollback", 900]] as const)("%s rejects a depleted recovery window", (id, window) => {
    const result = runStep(id, fleet(), fleet(), secretMetadata, undefined, fleet(), undefined,
      { ROLLBACK_DEADLINE_EPOCH: String(1800000000 + window - 1) });
    expect(result.code).toBe(1);
    expect(result.updates).toBe("");
    expect(result.stdout).toContain("insufficient time");
  });

  test("deadline windows cover all mutation bounds and preserve margin after queuing", () => {
    const minutes = (id: string) => workflow.jobs.deploy.steps.find((step: any) => step.id === id)["timeout-minutes"];
    const downstream = ["deploy", "verify", "activate", "rollback"].reduce((sum, id) => sum + minutes(id), 0);
    expect((downstream + 5) * 60).toBe(2100);
    expect((downstream + minutes("monitor-volume") + 5) * 60).toBe(2400);
    const script = steps.find(step => step.id === "deploy")!.run!;
    expect(script.indexOf("now=$(date -u +%s)")).toBeGreaterThan(script.indexOf("flyctl secrets list"));
    expect(script.indexOf("now=$(date -u +%s)")).toBeLessThan(script.indexOf("flyctl deploy"));
    const result = runStep("deploy", fleet(), fleet(), secretMetadata, undefined, fleet(), undefined,
      { ROLLBACK_DEADLINE_EPOCH: "1800004000", TEST_NOW_EPOCH: "1800002000" });
    expect(result.code).toBe(1);
    expect(result.updates).toBe("");
  });

  test.each(["missing", "duplicate"])("rejects a %s captured machine in the fresh list", (failure) => {
    const observed = fleet();
    if (failure === "missing") observed.shift();
    else observed.push(structuredClone(observed[0]!));
    const result = runStep("rollback", fleet(), fleet(), secretMetadata, undefined, observed);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain("captured machine identity is not unique");
    expect(result.updates).toBe("");
  });

  test.each(["missing", "duplicate"])("rejects a %s restored machine after update", (failure) => {
    const machines = fleet();
    machines[1]!.state = "stopped";
    const observed = fleet();
    if (failure === "missing") observed.splice(1, 1);
    else observed.push(structuredClone(observed[1]!));
    const result = runStep("rollback", machines, fleet(), secretMetadata, undefined, machines, observed);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain("restored machine identity is not unique");
    expect(result.updates.trim().split("\n")).toHaveLength(1);
  });

  test("binds checkout, build, and verification to the triggering workflow SHA", () => {
    expect(workflow.jobs.deploy.env.TARGET_RELEASE_SHA).toBe("${{ github.sha }}");
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

  test("admits exactly five distinct approved Machine IDs before mutation and immediately before deploy", () => {
    expect(runStep("source-fleet").code).toBe(0);
    expect(runStep("deploy").updates).toBe("deploy");
    for (const approved of ["", "not json", "[]", JSON.stringify(approvedMachineIds.slice(0, 4)),
      JSON.stringify([...approvedMachineIds.slice(0, 4), "a3"]),
      JSON.stringify([...approvedMachineIds.slice(0, 4), "A4"]),
      JSON.stringify([...approvedMachineIds, "a5"])]) {
      for (const id of ["source-fleet", "deploy"]) {
        const result = runStep(id, fleet(), fleet(), secretMetadata, undefined, fleet(), undefined,
          { APPROVED_MACHINE_IDS: approved });
        expect(result.code).not.toBe(0);
        expect(result.updates).toBe("");
        expect(result.output).not.toContain("attempted=true");
      }
    }
    for (const mutate of [
      (machines: ReturnType<typeof fleet>) => { machines[4]!.id = "a5"; },
      (machines: ReturnType<typeof fleet>) => { machines.pop(); },
      (machines: ReturnType<typeof fleet>) => { machines.push(structuredClone(machines[0]!)); },
      (machines: ReturnType<typeof fleet>) => { machines.push({ ...structuredClone(machines[0]!), id: "a5" }); },
    ]) {
      const observed = fleet(); mutate(observed);
      for (const id of ["source-fleet", "deploy"]) {
        const result = runStep(id, observed);
        expect(result.code).not.toBe(0);
        expect(result.updates).toBe("");
        expect(result.output).not.toContain("attempted=true");
      }
    }
    const deployScript = steps.find((step) => step.id === "deploy")!.run!;
    expect(deployScript.lastIndexOf("flyctl machine list")).toBeGreaterThan(deployScript.indexOf("flyctl secrets list"));
    expect(deployScript.lastIndexOf("flyctl machine list")).toBeLessThan(deployScript.indexOf("flyctl deploy"));
  });

  test("captures deployed secret metadata and rejects staged, partial, unknown, or missing proof", () => {
    expect(runStep("secret-contract").code).toBe(0);
    expect(runStep("secret-contract", fleet(), fleet(), [...secretMetadata, stagedFeedback]).code).toBe(0);
    for (const secrets of [
      [{ ...secretMetadata[0]!, status: "Staged" }],
      [...secretMetadata, { name: "ANOTHER_SETTING", digest: "other-digest", status: "Staged" }],
      [...secretMetadata, { ...stagedFeedback, status: "Partial" }],
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

  test("deploy accepts a staged feedback flag only with unchanged source metadata", () => {
    const sourceSecrets = [...secretMetadata, stagedFeedback];
    const accepted = runStep("deploy", fleet(), fleet(), sourceSecrets, undefined, fleet(), undefined, {}, sourceSecrets);
    expect(accepted.code).toBe(0);
    expect(accepted.updates).toBe("deploy");
    for (const changed of [
      [...secretMetadata, deployedFeedback],
      [...secretMetadata, { ...stagedFeedback, digest: "changed-digest" }],
      [...secretMetadata, stagedFeedback, { name: "EXTRA", digest: "extra-digest", status: "Deployed" }],
    ]) {
      const result = runStep("deploy", fleet(), fleet(), changed, undefined, fleet(), undefined, {}, sourceSecrets);
      expect(result.code).not.toBe(0);
      expect(result.updates).toBe("");
    }
  });

  test("successful verification requires the staged flag to deploy with its original digest", () => {
    const sourceSecrets = [...secretMetadata, stagedFeedback];
    const accepted = runStep("verify", fleet(), fleet(), [...secretMetadata, deployedFeedback], undefined,
      fleet(), undefined, {}, sourceSecrets);
    expect(accepted.code).toBe(0);
    for (const changed of [
      sourceSecrets,
      [...secretMetadata, { ...deployedFeedback, digest: "changed-digest" }],
      [{ ...secretMetadata[0]!, status: "Staged" }, deployedFeedback],
      [...secretMetadata, deployedFeedback, { name: "EXTRA", digest: "extra-digest", status: "Deployed" }],
    ]) {
      const result = runStep("verify", fleet(), fleet(), changed, undefined, fleet(), undefined, {}, sourceSecrets);
      expect(result.code).not.toBe(0);
    }
  });

  test("rollback tolerates only the staged feedback status transition and preserves every digest", () => {
    const sourceSecrets = [...secretMetadata, stagedFeedback];
    const machines = fleet();
    machines[1]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
    machines[1]!.release = targetSha;
    for (const observed of [sourceSecrets, [...secretMetadata, { ...stagedFeedback, status: "Partial" }],
      [...secretMetadata, deployedFeedback]]) {
      const accepted = runStep("rollback", structuredClone(machines), fleet(), observed, undefined,
        structuredClone(machines), undefined, {}, sourceSecrets);
      expect(accepted.code, accepted.error).toBe(0);
      expect(accepted.updates).toContain("machine update a1");
    }
    for (const changed of [
      [...secretMetadata, { ...deployedFeedback, digest: "changed-digest" }],
      [{ ...secretMetadata[0]!, digest: "changed-digest" }, deployedFeedback],
      [{ ...secretMetadata[0]!, status: "Staged" }, deployedFeedback],
      [{ ...secretMetadata[0]!, status: "Partial" }, deployedFeedback],
      [...secretMetadata, { ...stagedFeedback, status: "Unknown" }],
    ]) {
      const rejected = runStep("rollback", structuredClone(machines), fleet(), changed, undefined,
        structuredClone(machines), undefined, {}, sourceSecrets);
      expect(rejected.code).not.toBe(0);
      expect(rejected.updates).toBe("");
    }
    const afterExec = runStep("rollback", structuredClone(machines), fleet(), sourceSecrets,
      [...secretMetadata, { ...deployedFeedback, digest: "changed-digest" }], structuredClone(machines),
      undefined, {}, sourceSecrets);
    expect(afterExec.code).not.toBe(0);
    expect(afterExec.updates).toBe("");
    const deployedSource = [...secretMetadata, deployedFeedback];
    const reversed = runStep("rollback", structuredClone(machines), fleet(),
      [...secretMetadata, { ...deployedFeedback, status: "Partial" }], undefined,
      structuredClone(machines), undefined, {}, deployedSource);
    expect(reversed.code).not.toBe(0);
    expect(reversed.updates).toBe("");
  });

  test("checks secret names, digests, and deployment status before deploy, successful verification, or rollback", () => {
    expect(runStep("deploy").updates).toBe("deploy");
    const verified = runStep("verify");
    expect(verified.code, verified.error).toBe(0);
    for (const id of ["deploy", "verify", "rollback"]) {
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

  test("refuses original configuration drift without starting machines", () => {
    for (const change of [
      (machines: ReturnType<typeof fleet>) => { machines[2]!.config.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0"; },
      (machines: ReturnType<typeof fleet>) => { Object.assign(machines[2]!.config, { init: { cmd: ["unexpected"] } }); },
      (machines: ReturnType<typeof fleet>) => { Object.assign(machines[2]!.config.metadata, { custom: "unexpected" }); },
      (machines: ReturnType<typeof fleet>) => { machines[2]!.config.mounts.push({ volume: "unexpected", path: "/data" }); },
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

  test.each(["added", "changed", "removed"])("allows generated builder metadata to be %s during rollback", (builderChange) => {
    const snapshot = fleet();
    const machines = fleet();
    machines[1]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
    machines[1]!.release = targetSha;
    Object.assign(machines[1]!.config.metadata, {
      fly_release_id: "generated-release", fly_release_version: "2", fly_flyctl_version: "0.4.71",
    });
    if (builderChange !== "added") {
      Object.assign(snapshot[1]!.config.metadata, { fly_builder_id: "source-builder" });
    }
    if (builderChange !== "removed") {
      Object.assign(machines[1]!.config.metadata, { fly_builder_id: "target-builder" });
    }
    const result = runStep("rollback", machines, snapshot);
    expect(result.code, result.error).toBe(0);
    expect(result.updates.trim()).toBe(`machine update a1 --app postil-web --image ${sourceImage} --wait-timeout 120 --yes`);
    expect(result.machines[1].release).toBe(sourceSha);
    expect(result.machines[1].image_ref.digest).toBe(digest);
    expect(result.machines[1].config.metadata).toEqual(machines[1]!.config.metadata);
    expect(result.machines[1].config.env).toEqual(snapshot[1]!.config.env);
    expect(result.machines[3].config.mounts).toEqual(snapshot[3]!.config.mounts);

    Object.assign(machines[1]!.config.metadata, { application_mode: "unexpected" });
    const rejected = runStep("rollback", machines, snapshot);
    expect(rejected.code).not.toBe(0);
    expect(rejected.updates).toBe("");
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
    machines[1]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
    machines[1]!.config.image = `registry.fly.io/postil-web@${machines[1]!.image_ref.digest}`;
    machines[1]!.release = targetSha;
    const result = runStep("rollback", machines);
    expect(result.code, result.error).toBe(0);
    expect(result.updates.trim()).toBe(`machine update a1 --app postil-web --image ${sourceImage} --wait-timeout 120 --yes`);
    expect(result.machines).toEqual(fleet());
    const taggedSource = fleet();
    for (const machine of taggedSource) machine.config.image = "registry.fly.io/postil-web:source";
    const mixed = structuredClone(taggedSource);
    mixed[1] = machines[1]!;
    expect(runStep("rollback", mixed, taggedSource).code).toBe(0);
    const changedVolumes = fleet(); changedVolumes[3]!.config.mounts[0]!.volume = "vol_unexpected";
    const rejected = runStep("rollback", changedVolumes);
    expect(rejected.code).not.toBe(0);
    expect(rejected.updates).toBe("");
  });

  test("recovers stopped captured source and target machines through the sequential image update", () => {
    const stoppedSource = fleet();
    stoppedSource[1]!.state = "stopped";
    const sourceResult = runStep("rollback", stoppedSource);
    expect(sourceResult.code, sourceResult.error).toBe(0);
    expect(sourceResult.updates.trim()).toBe(`machine update a1 --app postil-web --image ${sourceImage} --wait-timeout 120 --yes`);
    expect(sourceResult.machines).toEqual(fleet());

    const stoppedTarget = fleet();
    stoppedTarget[1]!.state = "stopped";
    stoppedTarget[1]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
    stoppedTarget[1]!.config.image = `registry.fly.io/postil-web@${stoppedTarget[1]!.image_ref.digest}`;
    stoppedTarget[1]!.release = targetSha;
    const targetResult = runStep("rollback", stoppedTarget);
    expect(targetResult.code, targetResult.error).toBe(0);
    expect(targetResult.updates.trim()).toBe(`machine update a1 --app postil-web --image ${sourceImage} --wait-timeout 120 --yes`);
    expect(targetResult.machines).toEqual(fleet());
  });

  test("refuses an unavailable runtime identity on a healthy machine", () => {
    const machines = fleet();
    machines[1]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
    machines[1]!.config.image = `registry.fly.io/postil-web@${machines[1]!.image_ref.digest}`;
    machines[1]!.release = targetSha;
    Object.assign(machines[1]!, { exec_unavailable: true });
    const result = runStep("rollback", machines);
    expect(result.code).not.toBe(0);
    expect(result.updates).toBe("");
  });

  test("rejects an observable release outside the captured source and attempted target", () => {
    const machines = fleet();
    machines[1]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
    machines[1]!.config.image = `registry.fly.io/postil-web@${machines[1]!.image_ref.digest}`;
    machines[1]!.release = "d".repeat(40);
    const result = runStep("rollback", machines);
    expect(result.code).not.toBe(0);
    expect(result.updates).toBe("");
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
