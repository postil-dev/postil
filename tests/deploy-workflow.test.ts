import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { verifyManagedImageBinding } from "../scripts/start-managed-process";
import { runReleaseMigrations } from "../scripts/run-release-migrations";

const workflow = parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
const steps = workflow.jobs.deploy.steps as Array<{ id?: string; name?: string; run?: string }>;
const sourceSha = randomBytes(20).toString("hex");
const targetSha = randomBytes(20).toString("hex");
const digest = `sha256:${randomBytes(32).toString("hex")}`;
const sourceImage = `registry.fly.io/postil-web@${digest}`;
const targetImage = `registry.fly.io/postil-web@sha256:${randomBytes(32).toString("hex")}`;
const secretMetadata = [{ name: "DATABASE_URL", digest: "fixture-digest", status: "Deployed" }];
const stagedFeedback = { name: "POSTIL_REVIEW_FEEDBACK_ENABLED", digest: "feedback-digest", status: "Staged" };
const deployedFeedback = { ...stagedFeedback, status: "Deployed" };
const stagedSecrets = [...secretMetadata, stagedFeedback];
const deployedSecrets = [...secretMetadata, deployedFeedback];
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

function mixedFleet() {
  const machines = fleet();
  for (const machine of machines.filter(item => item.id === "a0" || item.id === "a2")) {
    machine.image_ref.digest = targetImage.split("@")[1]!;
    machine.config.image = targetImage;
    machine.release = targetSha;
  }
  return machines;
}

function runStep(id: string, machines = fleet(), snapshot = fleet(), secrets = id === "verify" ? deployedSecrets : stagedSecrets,
  afterExecSecrets?: typeof secretMetadata, statusMachines = machines, afterUpdateMachines?: ReturnType<typeof fleet>, deadlineEnvironment: Record<string, string> = {}, sourceSecrets = stagedSecrets) {
  const directory = mkdtempSync(join(tmpdir(), "postil-deploy-test-"));
  try {
    writeFileSync(join(directory, "machines.json"), JSON.stringify(machines));
    writeFileSync(join(directory, "postil-source-machines.json"), JSON.stringify(snapshot.filter(machine => approvedMachineIds.includes(machine.id))));
    const retained = deadlineEnvironment.RETAINED_MACHINE_IDS ?? "[]";
    const baseline = Bun.spawnSync(["jq", "-cS", "--arg", "retained", retained,
      '($retained | fromjson) as $held | [.[] | select(.id as $id | $held | index($id)) | {id, region, state, config, image_ref}] | sort_by(.id)'],
      { stdin: Buffer.from(JSON.stringify(snapshot)), stdout: "pipe", stderr: "pipe" });
    if (baseline.exitCode === 0) writeFileSync(join(directory, "postil-retained-machines.sha256"),
      `${createHash("sha256").update(baseline.stdout).digest("hex")}  -\n`);
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
      bun() {
        if [[ "$*" == "run scripts/deploy-managed-fleet.ts target" ]]; then
          [[ "\${TEST_TARGET_PROBE_FAIL:-0}" != "1" ]]
          return
        fi
        if [[ "$*" == "run scripts/probe-hosted-release-review.ts" ]]; then
          [[ "\${TEST_ACCEPTANCE_FAIL:-0}" != "1" ]] || return 1
          printf 'accepted=true\\n' >> "$GITHUB_OUTPUT"
          return
        fi
        return 98
      }
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
          "secrets import")
            [[ "$*" == "secrets import --stage --app postil-web" ]] || return 98
            cat > "$RUNNER_TEMP/staged-input"
            printf 'stage-feedback\n' >> "$RUNNER_TEMP/updates"
            if [[ "\${TEST_STAGE_FAILURE:-0}" == "1" ]]; then return 1; fi
            if [[ "\${TEST_IDENTICAL_OFF_STAGE:-0}" == "1" ]]; then return 0; fi
            jq --arg name POSTIL_REVIEW_FEEDBACK_ENABLED \
              'map(select(.name != $name)) + [{name: $name, digest: "feedback-digest", status: "Staged"}]' \
              "$RUNNER_TEMP/secrets.json" > "$RUNNER_TEMP/next-secrets.json"
            mv "$RUNNER_TEMP/next-secrets.json" "$RUNNER_TEMP/secrets.json"
            printf 'staged\n' ;;
          "deploy --remote-only")
            [[ "$*" == *"--only-machines a0,a2"* || "$*" == *"--only-machines a1,a4,a3"* ]] || return 97
            [[ "$*" == *"--max-concurrent 1 --update-only --ha=false"* ]] || return 97
            if [[ -n "\${TARGET_IMAGE:-}" ]]; then [[ "$*" == *"--image $TARGET_IMAGE"* ]] || return 97; fi
            if [[ "\${TEST_RELEASE_COMMAND_FAILURE:-0}" == "1" ]]; then return 1; fi
            printf '%s\\n' "$*" > "$RUNNER_TEMP/deploy-args"
            printf 'deploy' >> "$RUNNER_TEMP/updates" ;;
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
            if [[ "$4" == *'POSTIL_REVIEW_FEEDBACK_ENABLED'* ]]; then
              if jq -e --arg id "$3" '.[] | select(.id == $id and .feedback_runtime_on == true)' "$RUNNER_TEMP/machines.json" >/dev/null; then
                printf 'false'
              else
                printf 'true'
              fi
              return 0
            fi
            jq -er --arg id "$3" '.[] | select(.id == $id and .state != "stopped") | .release' "$RUNNER_TEMP/machines.json" ;;
          "machine status") echo 'Error: unknown flag: --json' >&2; return 64 ;;
          "machine update")
            printf '%s\\n' "$*" >> "$RUNNER_TEMP/updates"
            if [[ "\${TEST_FAIL_UPDATE_ID:-}" == "$3" ]]; then return 1; fi
            jq --arg id "$3" --arg image "$SOURCE_IMAGE" --arg sha "$SOURCE_RELEASE_SHA" --arg unhealthy "\${TEST_LEAVE_UNHEALTHY_ID:-}" '
              map(if .id == $id then .config.image = $image | .image_ref.digest = ($image | split("@")[1]) | .release = $sha | .state = "started" | .host_status = "ok" | (.checks[]?.status) = "passing" |
                if .id == $unhealthy then .checks[0].status = "critical" else . end else . end)
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
        TARGET_RELEASE_SHA: targetSha, ORCHESTRATION_SHA: targetSha, SOURCE_RELEASE_SHA: sourceSha, SOURCE_IMAGE: sourceImage, POSTIL_CLI_TAG: "v0.9.21", MONITOR_VOLUME_ID: "vol_test", TEST_NOW_EPOCH: "1800000000",
        ROLLBACK_DEADLINE_EPOCH: "1800006000", ROLLBACK_TARGET_SHA: targetSha,
        ROLLBACK_SOURCE_SHA: sourceSha, ROLLBACK_SOURCE_IMAGE: sourceImage,
        APPROVED_MACHINE_IDS: JSON.stringify(approvedMachineIds), FIRST_MACHINE_IDS: "a0,a2",
        REMAINING_MACHINE_IDS: "a1,a4,a3", FIRST_WEB_ID: "a0", FIRST_WORKER_ID: "a2",
        FIRST_IMAGE: targetImage, ACCEPTED: "",
        ACCEPTANCE_CONTEXT: JSON.stringify({ repository: "postil-dev/postil", pr: 1, head: targetSha, checkRun: 1 }),
        TARGET_IMAGE: "", ...deadlineEnvironment },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const read = (name: string) => { try { return readFileSync(join(directory, name), "utf8"); } catch { return ""; } };
    return { code: result.exitCode, error: result.stderr.toString(), stdout: result.stdout.toString(), output: read("output"), calls: read("exec-calls"), sleeps: read("sleeps"), updates: read("updates"), deployArgs: read("deploy-args"), stagedInput: read("staged-input"), capturedSecrets: read("postil-source-secrets.json"), observedSecrets: JSON.parse(read("secrets.json")), machines: JSON.parse(read("machines.json")) };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("managed deployment contract", () => {
  test("the single concurrency holder gates source peers on both first-target proofs", () => {
    expect(workflow.concurrency).toMatchObject({ group: "fly-deploy", "cancel-in-progress": false });
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).length).toBeLessThanOrEqual(10);
    expect(workflow.on.workflow_dispatch.inputs.acceptance).toMatchObject({ required: true, type: "string" });
    const ids = steps.map(step => step.id);
    for (const [earlier, later] of [["deploy", "first-proof"], ["first-proof", "hosted-acceptance"],
      ["hosted-acceptance", "deploy-peers"], ["deploy-peers", "verify"], ["verify", "activate"],
      ["activate", "rollback"]]) expect(ids.indexOf(earlier)).toBeLessThan(ids.indexOf(later));
    const rollback = steps.find(step => step.id === "rollback") as any;
    for (const id of ["deploy", "first-proof", "hosted-acceptance", "deploy-peers", "verify", "activate"])
      expect(rollback.if).toContain(`steps.${id}.outcome == 'failure'`);
    expect(rollback.if).toContain("steps.deploy.outputs.attempted == 'true'");
  });

  test("first-phase web, worker and peer phase use disjoint deterministic IDs", () => {
    const first = runStep("deploy");
    expect(first.code, first.error).toBe(0);
    expect(first.deployArgs).toContain("--only-machines a0,a2");
    expect(first.deployArgs).not.toContain("--only-machines a1,a4,a3");
    const peers = runStep("deploy-peers", mixedFleet(), fleet(), deployedSecrets, undefined,
      mixedFleet(), undefined, { ACCEPTED: "true" });
    expect(peers.code, peers.error).toBe(0);
    expect(peers.deployArgs).toContain("--only-machines a1,a4,a3");
    expect(peers.deployArgs).toContain(`--image ${targetImage}`);
  });

  test("peer deployment accepts the unchanged partial feedback-secret deployment after phase one", () => {
    const partialSecrets = [...secretMetadata, { ...stagedFeedback, status: "Partial" }];
    const peers = runStep("deploy-peers", mixedFleet(), fleet(), partialSecrets, undefined,
      mixedFleet(), undefined, { ACCEPTED: "true" });
    expect(peers.code, peers.error).toBe(0);
    expect(peers.deployArgs).toContain("--only-machines a1,a4,a3");
    for (const invalid of [
      [...secretMetadata, { ...stagedFeedback, digest: "changed", status: "Partial" }],
      [{ ...secretMetadata[0]!, status: "Partial" }, { ...stagedFeedback, status: "Partial" }],
    ]) {
      const rejected = runStep("deploy-peers", mixedFleet(), fleet(), invalid, undefined,
        mixedFleet(), undefined, { ACCEPTED: "true" });
      expect(rejected.code).not.toBe(0);
      expect(rejected.updates).toBe("");
    }
    expect(runStep("verify", fleet(), fleet(), partialSecrets).code).not.toBe(0);
  });

  test("no peer replacement follows missing acceptance, dependency failure or mixed-fleet drift", () => {
    const mixed = mixedFleet();
    const first = runStep("first-proof", mixed, fleet(), deployedSecrets);
    expect(first.code, first.error).toBe(0);
    expect(first.output).toContain(`image=${targetImage}`);
    for (const changed of [
      (() => { const value = structuredClone(mixed); value[0]!.image_ref.digest = digest; return value; })(),
      (() => { const value = structuredClone(mixed); value[1]!.image_ref.digest = targetImage.split("@")[1]!; return value; })(),
      (() => { const value = structuredClone(mixed); value[2]!.config.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0"; return value; })(),
    ]) {
      const result = runStep("first-proof", changed, fleet(), deployedSecrets);
      expect(result.code).not.toBe(0);
      expect(result.output).not.toContain("image=");
    }
    const failedProbe = runStep("first-proof", mixed, fleet(), deployedSecrets, undefined,
      mixed, undefined, { TEST_TARGET_PROBE_FAIL: "1" });
    expect(failedProbe.code).not.toBe(0);
    for (const environment of [{}, { ACCEPTED: "false" }, { ACCEPTED: "true", FIRST_IMAGE: sourceImage }] as Record<string, string>[]) {
      const result = runStep("deploy-peers", mixed, fleet(), deployedSecrets, undefined,
        mixed, undefined, environment);
      expect(result.code).not.toBe(0);
      expect(result.updates).toBe("");
    }
  });

  test("a mixed first-phase fleet restores both changed machines under the workflow rollback", () => {
    for (const failedId of ["a0", "a2"]) {
      const failed = runStep("rollback", mixedFleet(), fleet(), deployedSecrets, undefined,
        mixedFleet(), undefined, { TEST_FAIL_UPDATE_ID: failedId });
      expect(failed.code).not.toBe(0);
      const recovered = runStep("rollback", mixedFleet(), fleet(), deployedSecrets);
      expect(recovered.code, recovered.error).toBe(0);
      expect(recovered.updates).toContain("machine update a0");
      expect(recovered.updates).toContain("machine update a2");
      expect(recovered.machines.every((machine: ReturnType<typeof fleet>[number]) => machine.image_ref.digest === digest && machine.release === sourceSha)).toBe(true);
    }
  });

  test("generated mutation and proof failures recover every partial native rolling prefix", () => {
    const updateOrder = ["a0", "a2", "a1", "a4", "a3"];
    for (let boundary = 1; boundary <= updateOrder.length; boundary++) {
      const partial = fleet();
      for (const machine of partial.filter(item => updateOrder.slice(0, boundary).includes(item.id))) {
        machine.image_ref.digest = targetImage.split("@")[1]!;
        machine.config.image = targetImage;
        machine.release = targetSha;
      }
      const recovered = runStep("rollback", partial, fleet(), deployedSecrets);
      expect(recovered.code, `boundary ${boundary}: ${recovered.error}`).toBe(0);
      expect(recovered.machines.every((machine: ReturnType<typeof fleet>[number]) =>
        machine.image_ref.digest === digest && machine.release === sourceSha)).toBe(true);
      for (const changed of updateOrder.slice(0, boundary))
        expect(recovered.updates).toContain(`machine update ${changed}`);
      const failed = runStep("rollback", partial, fleet(), deployedSecrets, undefined, partial, undefined,
        { TEST_FAIL_UPDATE_ID: updateOrder[boundary - 1]! });
      expect(failed.code).not.toBe(0);
      expect(failed.machines.find((machine: ReturnType<typeof fleet>[number]) =>
        machine.id === updateOrder[boundary - 1])?.release).toBe(targetSha);
    }
  });

  test("supplied immutable runtime can differ from the workflow SHA; a build cannot", () => {
    const supplied = runStep("admission", fleet(), fleet(), secretMetadata, undefined,
      fleet(), undefined, { TARGET_IMAGE: targetImage, ORCHESTRATION_SHA: sourceSha }, secretMetadata);
    expect(supplied.code, supplied.error).toBe(0);
    const build = runStep("admission", fleet(), fleet(), secretMetadata, undefined,
      fleet(), undefined, { ORCHESTRATION_SHA: sourceSha }, secretMetadata);
    expect(build.code).not.toBe(0);
  });

  test("deploys the qualified immutable image through the rolling command", () => {
    const result = runStep("deploy", fleet(), fleet(), stagedSecrets, undefined, fleet(), undefined,
      { TARGET_IMAGE: `registry.fly.io/postil-web@sha256:${randomBytes(32).toString("hex")}` });
    expect(result.code, result.error).toBe(0);
    expect(result.updates).toBe("deploy");
  });

  test("source feedback preflight permits a separately qualified target image", () => {
    const result = runStep("feedback-preflight", fleet(), fleet(), stagedSecrets, undefined, fleet(), undefined,
      { TARGET_IMAGE: `registry.fly.io/postil-web@sha256:${randomBytes(32).toString("hex")}` });
    expect(result.code, result.error).toBe(0);
    expect(result.calls.trim().split("\n")).toHaveLength(5);
  });

  test("target verification requires the exact qualified image digest", () => {
    const result = runStep("verify", fleet(), fleet(), deployedSecrets, undefined, fleet(), undefined,
      { TARGET_IMAGE: `registry.fly.io/postil-web@sha256:${randomBytes(32).toString("hex")}` });
    expect(result.code).not.toBe(0);
    expect(result.calls).toBe("");
    expect(result.stdout).toContain("differs from the qualified runtime target");
    const matching = runStep("verify", fleet(), fleet(), deployedSecrets, undefined, fleet(), undefined,
      { TARGET_IMAGE: sourceImage });
    expect(matching.code, matching.error).toBe(0);
  });

  test.each(["registry.fly.io/postil-web:latest", "registry.fly.io/other@sha256:" + "a".repeat(64), "malformed"])(
    "refuses an unbound image %s at admission", image => {
      const result = runStep("admission", fleet(), fleet(), stagedSecrets, undefined, fleet(), undefined, { TARGET_IMAGE: image });
      expect(result.code).not.toBe(0);
      expect(result.updates).toBe("");
      expect(result.calls).toBe("");
    });

  const withRetained = () => {
    const machines = fleet();
    const held = structuredClone(machines[2]!);
    held.id = "b0";
    held.state = "stopped";
    machines.push(held);
    return machines;
  };
  const retainedEnvironment = { RETAINED_MACHINE_IDS: '["b0"]' };

  test("generated fleet histories preserve selection and recover active machines after retained drift", () => {
    for (let seed = 1; seed <= 16; seed++) {
      let state = seed;
      const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
      const before = withRetained();
      before[5]!.image_ref.digest = `sha256:${randomBytes(32).toString("hex")}`;
      before[5]!.config.mounts = [{ volume: `retained_${seed}`, path: "/retained" }];
      for (let index = before.length - 1; index > 0; index--) {
        const other = next() % (index + 1);
        [before[index], before[other]] = [before[other]!, before[index]!];
      }
      const source = runStep("source-fleet", before, before, stagedSecrets, undefined, before, undefined, retainedEnvironment);
      expect(source.code, source.error).toBe(0);
      expect(source.calls.trim().split("\n").sort()).toEqual(approvedMachineIds);
      const admitted = runStep("deploy", before, before, stagedSecrets, undefined, before, undefined, retainedEnvironment);
      expect(admitted.code, admitted.error).toBe(0);
      const changed = structuredClone(before);
      const held = changed.find(machine => machine.id === "b0")!;
      if (seed % 4 === 0) held.state = "started";
      else if (seed % 4 === 1) held.image_ref.digest = `sha256:${randomBytes(32).toString("hex")}`;
      else if (seed % 4 === 2) held.config.mounts[0]!.volume = `changed_${seed}`;
      else changed.splice(changed.indexOf(held), 1);
      const rejected = runStep("deploy", changed, before, stagedSecrets, undefined, changed, undefined, retainedEnvironment);
      expect(rejected.code).not.toBe(0);
      expect(rejected.updates).toBe("");
      const partial = structuredClone(changed);
      const target = partial.find(machine => machine.id === "a0")!;
      target.image_ref.digest = `sha256:${randomBytes(32).toString("hex")}`;
      target.release = targetSha;
      const recovered = runStep("rollback", partial, before, stagedSecrets, undefined, partial, undefined, retainedEnvironment);
      expect(recovered.code, recovered.error).toBe(0);
      expect(recovered.calls.trim().split("\n")).not.toContain("b0");
      expect(recovered.updates).not.toContain("machine update b0");
      expect(recovered.machines.find((machine: ReturnType<typeof fleet>[number]) => machine.id === "b0")).toEqual(seed % 4 === 3 ? undefined : held);
      expect(recovered.machines.filter((machine: ReturnType<typeof fleet>[number]) => machine.id !== "b0")
        .every((machine: ReturnType<typeof fleet>[number]) => machine.image_ref.digest === digest && machine.release === sourceSha)).toBe(true);
    }
  }, 30_000);

  test.each(["verify", "activate"])("%s does not roll back healthy active machines for unrelated retained drift", id => {
    const before = withRetained();
    const changed = structuredClone(before);
    changed[5]!.state = "started";
    changed[5]!.config.mounts = [{ volume: "changed", path: "/retained" }];
    const result = runStep(id, changed, before, deployedSecrets, undefined, changed, undefined, retainedEnvironment);
    expect(result.code, result.error).toBe(0);
    expect(result.calls.trim().split("\n")).not.toContain("b0");
    expect(result.updates).not.toContain("machine update b0");
  });

  test.each(["source-fleet", "feedback-preflight", "stage-feedback", "deploy", "verify", "activate", "rollback"])(
    "%s preserves an explicitly retained stopped worker", (id) => {
      const machines = withRetained();
      const result = runStep(id, machines, structuredClone(machines), id === "verify" ? deployedSecrets : stagedSecrets,
        undefined, structuredClone(machines), undefined, retainedEnvironment);
      expect(result.code, result.error).toBe(0);
      expect(result.calls.trim().split("\n")).not.toContain("b0");
      expect(result.updates).not.toContain("machine update b0");
      expect(result.machines.find((machine: ReturnType<typeof fleet>[number]) => machine.id === "b0")).toEqual(machines.find(machine => machine.id === "b0"));
    });

  test.each(["state", "image", "environment", "mount", "group"])("rejects retained worker %s drift before mutation", (field) => {
    const before = withRetained();
    const machines = structuredClone(before);
    const held = machines[5]!;
    if (field === "state") held.state = "started";
    if (field === "image") held.image_ref.digest = `sha256:${"e".repeat(64)}`;
    if (field === "environment") held.config.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0";
    if (field === "mount") held.config.mounts = [{ volume: "different", path: "/retained" }];
    if (field === "group") held.config.metadata.fly_process_group = "web";
    const result = runStep("deploy", machines, before, stagedSecrets, undefined, machines, undefined, retainedEnvironment);
    expect(result.code).not.toBe(0);
    expect(result.calls).toBe("");
    expect(result.updates).toBe("");
  });

  test.each(['["b0","b0"]', '["a0"]', '["b1"]', 'null', '["invalid-id"]'])(
    "rejects invalid retained membership %s", (retained) => {
      const machines = withRetained();
      const result = runStep("deploy", machines, machines, stagedSecrets, undefined, machines, undefined,
        { RETAINED_MACHINE_IDS: retained });
      expect(result.code).not.toBe(0);
      expect(result.updates).toBe("");
      expect(result.calls).toBe("");
    });

  test.each(["verify", "rollback"])("%s retries transient reads but rejects persistent failure and wrong identity", (id) => {
    const machines = fleet();
    if (id === "rollback") {
      machines[1]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
      machines[1]!.release = targetSha;
    }
    const execute = (environment: Record<string, string>) => runStep(id, structuredClone(machines), fleet(), id === "verify" ? deployedSecrets : stagedSecrets,
      undefined, structuredClone(machines), undefined, environment);
    const recovered = execute({ TEST_EXEC_FAILURES: "2" });
    expect(recovered.code, recovered.error).toBe(0);
    expect(recovered.sleeps.trim().split("\n").every(value => value === "2")).toBe(true);
    expect(recovered.stdout).not.toContain("partial failed output");
    expect(recovered.calls.trim().split("\n").filter(value => value === "a1").length).toBe(4);
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
    const result = runStep("rollback", machines, fleet(), stagedSecrets, undefined, machines, undefined,
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

  test("requires manual runtime-bound admission and never rolls back an unattempted deploy", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    for (const input of ["machine_ids", "rollback_deadline_epoch", "rollback_target_sha", "rollback_source_sha", "rollback_source_image"]) {
      expect(workflow.on.workflow_dispatch.inputs[input]).toMatchObject({ required: true, type: "string" });
    }
    expect(workflow.jobs.deploy.if).toBe("vars.FLY_DEPLOY_ENABLED == 'true' && github.event_name == 'workflow_dispatch'");
    expect(workflow.jobs.deploy.env.ROLLBACK_DEADLINE_EPOCH).toBe("${{ inputs.rollback_deadline_epoch }}");
    expect(workflow.jobs.deploy.env.ROLLBACK_TARGET_SHA).toBe("${{ inputs.rollback_target_sha }}");
    expect(workflow.jobs.deploy.env.ROLLBACK_SOURCE_SHA).toBe("${{ inputs.rollback_source_sha }}");
    expect(workflow.jobs.deploy.env.ROLLBACK_SOURCE_IMAGE).toBe("${{ inputs.rollback_source_image }}");
    expect(workflow.jobs.deploy.env.APPROVED_MACHINE_IDS).toBe("${{ inputs.machine_ids }}");
    expect(workflow.jobs.deploy.steps.find((step: any) => step.id === "rollback").if).toContain("steps.deploy.outputs.attempted == 'true'");
  });

  test("a stale dispatch target fails admission before feedback staging", () => {
    const ids = steps.map(step => step.id);
    expect(ids.indexOf("admission")).toBeLessThan(ids.indexOf("source-fleet"));
    expect(ids.indexOf("admission")).toBeLessThan(ids.indexOf("stage-feedback"));
    expect(runStep("admission").code).toBe(0);
    const result = runStep("admission", fleet(), fleet(), secretMetadata, undefined,
      fleet(), undefined, { ROLLBACK_TARGET_SHA: "b".repeat(40) }, secretMetadata);
    expect(result.code).not.toBe(0);
    expect(result.updates).toBe("");
    expect(result.stagedInput).toBe("");
    expect(result.observedSecrets).toEqual(secretMetadata);
  });

  test("source inputs reject missing and malformed values at admission", () => {
    for (const environment of [
      { ROLLBACK_SOURCE_SHA: "" },
      { ROLLBACK_SOURCE_SHA: sourceSha.toUpperCase() },
      { ROLLBACK_SOURCE_SHA: sourceSha.slice(1) },
      { ROLLBACK_SOURCE_IMAGE: "" },
      { ROLLBACK_SOURCE_IMAGE: sourceImage.replace("@sha256:", ":") },
      { ROLLBACK_SOURCE_IMAGE: sourceImage.toUpperCase() },
    ] as Record<string, string>[]) {
      const result = runStep("admission", fleet(), fleet(), secretMetadata, undefined,
        fleet(), undefined, environment, secretMetadata);
      expect(result.code, result.error).not.toBe(0);
      expect(result.updates).toBe("");
      expect(result.stagedInput).toBe("");
    }
  });

  test("source fleet requires exact dispatch source SHA and image before staging", () => {
    const ids = steps.map(step => step.id);
    expect(ids.indexOf("source-fleet")).toBeLessThan(ids.indexOf("stage-feedback"));
    for (const environment of [
      { ROLLBACK_SOURCE_SHA: targetSha },
      { ROLLBACK_SOURCE_IMAGE: `registry.fly.io/postil-web@sha256:${randomBytes(32).toString("hex")}` },
    ] as Record<string, string>[]) {
      const rejected = runStep("source-fleet", fleet(), fleet(), secretMetadata, undefined,
        fleet(), undefined, environment, secretMetadata);
      expect(rejected.code).not.toBe(0);
      expect(rejected.output).toBe("");
      expect(rejected.updates).toBe("");
      expect(rejected.stagedInput).toBe("");
      expect(rejected.observedSecrets).toEqual(secretMetadata);
    }
  });

  test("source fleet rejects an approved machine with an unknown process group before staging", () => {
    const machines = fleet();
    machines[4]!.config.metadata.fly_process_group = "unexpected";
    const result = runStep("source-fleet", machines, fleet(), secretMetadata, undefined,
      machines, undefined, {}, secretMetadata);
    expect(result.code).not.toBe(0);
    expect(result.updates).toBe("");
    expect(result.stagedInput).toBe("");
    expect(result.observedSecrets).toEqual(secretMetadata);
  });

  test("predeploy accepts omitted checks but rejects a present failing check", () => {
    const machines = fleet();
    delete (machines[2] as Partial<(typeof machines)[number]>).checks;
    delete (machines[3] as Partial<(typeof machines)[number]>).checks;
    const accepted = runStep("deploy", machines, structuredClone(machines));
    expect(accepted.code, accepted.error).toBe(0);
    expect(accepted.updates).toBe("deploy");

    const unhealthy = structuredClone(machines);
    unhealthy[0]!.checks[0]!.status = "critical";
    const rejected = runStep("deploy", unhealthy, structuredClone(unhealthy));
    expect(rejected.code).not.toBe(0);
    expect(rejected.updates).toBe("");
    expect(rejected.output).not.toContain("attempted=true");
  });

  test("deploy revalidates the captured source fleet immediately before replacement", () => {
    const deploy = steps.find((step) => step.id === "deploy")?.run ?? "";
    expect(deploy.indexOf("postil-source-machines.json")).toBeLessThan(deploy.indexOf("attempted=true"));
    expect(deploy.indexOf("machine exec")).toBeLessThan(deploy.indexOf("attempted=true"));
    const source = fleet();
    const changed: Array<(machines: ReturnType<typeof fleet>) => void> = [
      (machines) => { machines[1]!.image_ref.digest = `sha256:${randomBytes(32).toString("hex")}`; },
      (machines) => { machines[1]!.release = targetSha; },
      (machines) => { machines[1]!.state = "stopped"; },
      (machines) => { machines[1]!.host_status = "unknown"; },
      (machines) => { machines[1]!.checks[0]!.status = "critical"; },
      (machines) => { machines[1]!.config.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0"; },
      (machines) => { machines[1]!.config.mounts.push({ volume: "vol_other", path: "/data" }); },
      (machines) => { machines[3]!.config.mounts[0]!.volume = "vol_other"; },
      (machines) => { Object.assign(machines[1]!.config, { init: { cmd: ["other"] } }); },
    ];
    for (const change of changed) {
      const machines = structuredClone(source);
      change(machines);
      const result = runStep("deploy", machines, source);
      expect(result.code, result.error).not.toBe(0);
      expect(result.updates).toBe("");
      expect(result.output).not.toContain("attempted=true");
      expect(result.observedSecrets).toEqual(stagedSecrets);
    }
    const metadata = structuredClone(source);
    Object.assign(metadata[1]!.config.metadata, {
      fly_release_id: "changed", fly_release_version: "changed",
      fly_flyctl_version: "changed", fly_builder_id: "changed",
    });
    const accepted = runStep("deploy", metadata, source);
    expect(accepted.code, accepted.error).toBe(0);
    expect(accepted.updates).toBe("deploy");
    expect(accepted.output).toContain("attempted=true");
  });

  test("admission rejects stale deadlines and invalid approved IDs before staging", () => {
    for (const environment of [
      { ROLLBACK_DEADLINE_EPOCH: "1800002399" },
      { APPROVED_MACHINE_IDS: JSON.stringify(approvedMachineIds.slice(0, 4)) },
    ] as Record<string, string>[]) {
      const result = runStep("admission", fleet(), fleet(), secretMetadata, undefined,
        fleet(), undefined, environment, secretMetadata);
      expect(result.code).not.toBe(0);
      expect(result.updates).toBe("");
      expect(result.stagedInput).toBe("");
    }
  });

  test("preflight elapsed time can expire staging margin after admission", () => {
    const deadline = "1800004800";
    expect(runStep("admission", fleet(), fleet(), secretMetadata, undefined,
      fleet(), undefined, { ROLLBACK_DEADLINE_EPOCH: deadline }, secretMetadata).code).toBe(0);
    expect(runStep("source-fleet").code).toBe(0);
    expect(runStep("feedback-preflight").code).toBe(0);
    const expired = runStep("stage-feedback", fleet(), fleet(), secretMetadata, undefined,
      fleet(), undefined, { ROLLBACK_DEADLINE_EPOCH: deadline, TEST_NOW_EPOCH: "1800000601" }, secretMetadata);
    expect(expired.code).not.toBe(0);
    expect(expired.updates).toBe("");
    expect(expired.stagedInput).toBe("");
    expect(expired.observedSecrets).toEqual(secretMetadata);
  });

  test("feedback staging requires the complete phased release window and exact target", () => {
    for (const offset of [-1, 0, 1]) {
      const result = runStep("stage-feedback", fleet(), fleet(), secretMetadata, undefined,
        fleet(), undefined, { ROLLBACK_DEADLINE_EPOCH: String(1800000000 + 4200 + offset) }, secretMetadata);
      expect(result.code, result.error).toBe(offset < 0 ? 1 : 0);
      expect(result.updates).toBe(offset < 0 ? "" : "stage-feedback\n");
    }
    for (const environment of [
      { ROLLBACK_TARGET_SHA: "b".repeat(40) },
      { ROLLBACK_DEADLINE_EPOCH: "" },
      { TEST_NOW_EPOCH: "invalid" },
    ] as Record<string, string>[]) {
      const result = runStep("stage-feedback", fleet(), fleet(), secretMetadata, undefined,
        fleet(), undefined, environment, secretMetadata);
      expect(result.code).not.toBe(0);
      expect(result.updates).toBe("");
      expect(result.stagedInput).toBe("");
    }
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
      const result = runStep(id, fleet(), fleet(), stagedSecrets, undefined, fleet(), undefined, environment);
      expect(result.code).not.toBe(0);
      expect(result.updates).toBe("");
      expect(result.output).not.toContain("attempted=true");
    }
  });

  test.each([["monitor-volume", 3900], ["deploy", 3600], ["activate", 1200], ["rollback", 900]] as const)("%s enforces its complete boundary", (id, window) => {
    for (const offset of [-1, 0, 1]) {
      const result = runStep(id, fleet(), fleet(), stagedSecrets, undefined, fleet(), undefined,
        { ROLLBACK_DEADLINE_EPOCH: String(1800000000 + window + offset) });
      expect(result.code, result.error).toBe(offset < 0 ? 1 : 0);
      expect(result.updates).toBe(offset >= 0 && ["deploy", "activate"].includes(id) ? id : "");
      if (id === "deploy" && offset >= 0) expect(result.output).toContain("attempted=true");
    }
  });

  test.each([["activate", 1200], ["rollback", 900]] as const)("%s rejects a depleted recovery window", (id, window) => {
    const result = runStep(id, fleet(), fleet(), stagedSecrets, undefined, fleet(), undefined,
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
    const result = runStep("deploy", fleet(), fleet(), stagedSecrets, undefined, fleet(), undefined,
      { ROLLBACK_DEADLINE_EPOCH: "1800004000", TEST_NOW_EPOCH: "1800002000" });
    expect(result.code).toBe(1);
    expect(result.updates).toBe("");
  });

  test.each(["missing", "duplicate"])("rejects a %s captured machine in the fresh list", (failure) => {
    const observed = fleet();
    if (failure === "missing") observed.shift();
    else observed.push(structuredClone(observed[0]!));
    const result = runStep("rollback", fleet(), fleet(), stagedSecrets, undefined, observed);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain("Fleet membership or retained worker state differs from the approved release");
    expect(result.updates).toBe("");
  });

  test.each(["missing", "duplicate"])("rejects a %s restored machine after update", (failure) => {
    const machines = fleet();
    machines[1]!.state = "stopped";
    const observed = fleet();
    if (failure === "missing") observed.splice(1, 1);
    else observed.push(structuredClone(observed[1]!));
    const result = runStep("rollback", machines, fleet(), stagedSecrets, undefined, machines, observed);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain("Fleet membership or retained worker state differs from the approved release");
    expect(result.updates.trim().split("\n")).toHaveLength(1);
  });

  test("binds checkout, build, and verification to the triggering workflow SHA", () => {
    expect(workflow.jobs.deploy.env.ORCHESTRATION_SHA).toBe("${{ github.sha }}");
    expect(workflow.jobs.deploy.env.TARGET_RELEASE_SHA).toBe("${{ inputs.target_image != '' && inputs.rollback_target_sha || github.sha }}");
    const source = readFileSync(".github/workflows/deploy.yml", "utf8");
    expect(source).not.toContain("${GITHUB_SHA}");
    expect(source).not.toContain("--skip-release-command");
    expect(source.match(/flyctl secrets import --stage --app postil-web/g)).toHaveLength(1);
    expect(source).not.toMatch(/flyctl secrets (unset|set)/);
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
        const result = runStep(id, fleet(), fleet(), stagedSecrets, undefined, fleet(), undefined,
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
    expect(deployScript.lastIndexOf("read_deploy_machines")).toBeGreaterThan(deployScript.indexOf("flyctl secrets list"));
    expect(deployScript.lastIndexOf("flyctl machine list")).toBeLessThan(deployScript.indexOf("flyctl deploy"));
  });

  test("stops before Machine updates when the Fly release command fails", () => {
    expect(readFileSync("fly.toml", "utf8"))
      .toContain('release_command = "bun scripts/start-managed-process.ts release"');
    const result = runStep("deploy", fleet(), fleet(), stagedSecrets, undefined, fleet(), undefined,
      { TEST_RELEASE_COMMAND_FAILURE: "1" });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("attempted=true");
    expect(result.updates).toBe("");
  });

  test("source feedback preflight checks every approved running Machine before staging", () => {
    const ids = steps.map((step) => step.id);
    expect(ids.indexOf("source-fleet")).toBeLessThan(ids.indexOf("feedback-preflight"));
    expect(ids.indexOf("feedback-preflight")).toBeLessThan(ids.indexOf("stage-feedback"));
    const accepted = runStep("feedback-preflight");
    expect(accepted.code, accepted.error).toBe(0);
    expect(accepted.calls.trim().split("\n")).toEqual(approvedMachineIds);
    for (const change of [
      (machines: ReturnType<typeof fleet>) => { Object.assign(machines[2]!, { feedback_runtime_on: true }); },
      (machines: ReturnType<typeof fleet>) => { Object.assign(machines[2]!, { exec_unavailable: true }); },
      (machines: ReturnType<typeof fleet>) => { machines[2]!.id = "a5"; },
    ]) {
      const machines = fleet(); change(machines);
      const result = runStep("feedback-preflight", machines);
      expect(result.code).not.toBe(0);
      expect(result.updates).toBe("");
    }
  });

  test("feedback staging revalidates the captured source before importing secrets", () => {
    const stage = steps.find((step) => step.id === "stage-feedback")!.run!;
    expect(stage.indexOf("postil-source-machines.json")).toBeLessThan(stage.indexOf("secrets import"));
    expect(stage.indexOf("machine exec")).toBeLessThan(stage.indexOf("secrets import"));
    const source = fleet();
    const changes: Array<(machines: ReturnType<typeof fleet>) => void> = [
      (machines) => { machines[4]!.config.metadata.fly_process_group = "unexpected"; },
      (machines) => { machines[1]!.config.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0"; },
      (machines) => { machines[1]!.config.mounts.push({ volume: "vol_other", path: "/data" }); },
      (machines) => { machines[1]!.image_ref.digest = `sha256:${randomBytes(32).toString("hex")}`; },
      (machines) => { machines[1]!.release = targetSha; },
      (machines) => { machines[1]!.checks[0]!.status = "critical"; },
    ];
    for (const change of changes) {
      const machines = structuredClone(source);
      change(machines);
      const result = runStep("stage-feedback", machines, source, secretMetadata, undefined,
        machines, undefined, {}, secretMetadata);
      expect(result.code, result.error).not.toBe(0);
      expect(result.updates).toBe("");
      expect(result.stagedInput).toBe("");
      expect(result.observedSecrets).toEqual(secretMetadata);
    }
    const changedProcess = structuredClone(source);
    changedProcess[4]!.config.metadata.fly_process_group = "unexpected";
    expect(runStep("feedback-preflight", changedProcess).code).toBe(0);

    const omittedChecks = structuredClone(source);
    delete (omittedChecks[2] as Partial<(typeof omittedChecks)[number]>).checks;
    const accepted = runStep("stage-feedback", omittedChecks, source, secretMetadata, undefined,
      omittedChecks, undefined, {}, secretMetadata);
    expect(accepted.code, accepted.error).toBe(0);
    expect(accepted.updates).toBe("stage-feedback\n");

    const generatedMetadata = structuredClone(source);
    Object.assign(generatedMetadata[1]!.config.metadata, {
      fly_release_id: "changed", fly_release_version: "changed",
      fly_flyctl_version: "changed", fly_builder_id: "changed",
    });
    expect(runStep("stage-feedback", generatedMetadata, source, secretMetadata, undefined,
      generatedMetadata, undefined, {}, secretMetadata).code).toBe(0);
  });

  test("stages feedback OFF after source fleet verification and before capturing its digest", () => {
    const ids = steps.map((step) => step.id);
    expect(ids.indexOf("source-fleet")).toBeLessThan(ids.indexOf("stage-feedback"));
    expect(ids.indexOf("stage-feedback")).toBeLessThan(ids.indexOf("secret-contract"));
    const staged = runStep("stage-feedback", fleet(), fleet(), secretMetadata);
    expect(staged.code).toBe(0);
    expect(staged.stagedInput).toBe("POSTIL_REVIEW_FEEDBACK_ENABLED=0\n");
    expect(staged.stdout).toBe("");
    expect(staged.observedSecrets).toEqual([...secretMetadata, stagedFeedback]);
    const captured = runStep("secret-contract", fleet(), fleet(), staged.observedSecrets);
    expect(captured.code).toBe(0);
    expect(JSON.parse(captured.capturedSecrets)).toEqual([...secretMetadata, stagedFeedback]);
    const failed = runStep("stage-feedback", fleet(), fleet(), secretMetadata, undefined,
      fleet(), undefined, { TEST_STAGE_FAILURE: "1" }, secretMetadata);
    expect(failed.code).not.toBe(0);
    expect(failed.stagedInput).toBe("POSTIL_REVIEW_FEEDBACK_ENABLED=0\n");
    expect(failed.observedSecrets).toEqual(secretMetadata);
    expect(failed.capturedSecrets).toBe(JSON.stringify(secretMetadata));
  });

  test("an identical OFF stage may remain deployed, with runtime proof required after deploy", () => {
    const staged = runStep("stage-feedback", fleet(), fleet(), deployedSecrets, undefined,
      fleet(), undefined, { TEST_IDENTICAL_OFF_STAGE: "1" }, deployedSecrets);
    expect(staged.code).toBe(0);
    expect(staged.observedSecrets).toEqual(deployedSecrets);
    expect(runStep("secret-contract", fleet(), fleet(), deployedSecrets).code).toBe(0);
    expect(runStep("deploy", fleet(), fleet(), deployedSecrets, undefined, fleet(), undefined, {}, deployedSecrets).updates).toBe("deploy");
    expect(runStep("verify", fleet(), fleet(), deployedSecrets, undefined, fleet(), undefined, {}, deployedSecrets).code).toBe(0);
    const enabled = fleet(); Object.assign(enabled[3]!, { feedback_runtime_on: true });
    const rejected = runStep("verify", enabled, fleet(), deployedSecrets, undefined, enabled, undefined, {}, deployedSecrets);
    expect(rejected.code).not.toBe(0);
  });

  test("captures deployed secret metadata and rejects staged, partial, unknown, or missing proof", () => {
    expect(runStep("secret-contract").code).toBe(0);
    expect(runStep("secret-contract", fleet(), fleet(), [...secretMetadata, stagedFeedback]).code).toBe(0);
    for (const secrets of [
      secretMetadata,
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

  test("verification and activation reject deployed Machine identity drift", () => {
    const changed = fleet(); changed[4]!.id = "a5";
    for (const id of ["verify", "activate"]) {
      const result = runStep(id, changed, fleet(), deployedSecrets);
      expect(result.code).not.toBe(0);
      expect(result.calls).toBe("");
      expect(result.error).toContain("Fleet membership or retained worker state differs from the approved release");
      expect(result.updates).toBe("");
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
    const result = runStep("rollback", fleet(), fleet(), stagedSecrets, undefined, changedAfterList);
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

  test("recovers both unhealthy peers in each group one at a time", () => {
    const machines = fleet();
    for (const machine of machines.filter(machine => machine.config.metadata.fly_process_group !== "monitor")) {
      machine.state = "stopped";
      machine.image_ref.digest = `sha256:${"c".repeat(64)}`;
      machine.config.image = `registry.fly.io/postil-web@${machine.image_ref.digest}`;
      machine.release = targetSha;
    }
    const result = runStep("rollback", machines);
    expect(result.code, result.error).toBe(0);
    expect(result.updates.trim().split("\n")).toEqual(["a0", "a1", "a2", "a4"].map(id =>
      `machine update ${id} --app postil-web --image ${sourceImage} --wait-timeout 120 --yes`));
    expect(result.machines).toEqual(fleet());

    for (const environment of [{ TEST_FAIL_UPDATE_ID: "a0" }, { TEST_LEAVE_UNHEALTHY_ID: "a0" }] as Record<string, string>[]) {
      const failed = runStep("rollback", structuredClone(machines), fleet(), stagedSecrets, undefined,
        structuredClone(machines), undefined, environment);
      expect(failed.code).not.toBe(0);
      expect(failed.updates.trim().split("\n")).toEqual([
        `machine update a0 --app postil-web --image ${sourceImage} --wait-timeout 120 --yes`,
      ]);
    }

    const unauthorized = structuredClone(machines);
    unauthorized.push({ ...structuredClone(unauthorized[0]!), id: "a5" });
    const rejected = runStep("rollback", unauthorized);
    expect(rejected.code).not.toBe(0);
    expect(rejected.updates).toBe("");
  });

  test("does not replace a healthy machine without a healthy same-group peer", () => {
    const machines = fleet();
    machines[0]!.image_ref.digest = `sha256:${"c".repeat(64)}`;
    machines[0]!.config.image = `registry.fly.io/postil-web@${machines[0]!.image_ref.digest}`;
    machines[0]!.release = targetSha;
    machines[1]!.state = "stopped";
    const result = runStep("rollback", machines);
    expect(result.code).not.toBe(0);
    expect(result.updates).toBe("");
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
