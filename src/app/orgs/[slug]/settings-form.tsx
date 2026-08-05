"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";

import {
  saveOrgConfigFallbacks,
  saveOrgInferenceSettings,
  setOrgGateEnabled,
  setOrgSharedConfigEnabled,
  type OrgSettingsActionState,
} from "./actions";
import { ConfigYamlEditor } from "./config-yaml-editor";

interface SettingsFormProps {
  slug: string;
  billedMode: "hosted" | "byok" | null;
  managedReviewsPaused: boolean;
  hostedInferenceAvailable: boolean;
  trialCanSwitchProvider: boolean;
  settings:
    | {
        apiBase: string | null;
        apiFormat: string;
        model: string | null;
        modelCascade: string | null;
        hasKey: boolean;
        hasAdditionalAuth: boolean;
        configYaml: string | null;
        guardrailsMd: string | null;
        contentPolicyMd: string | null;
        sharedConfigEnabled: boolean;
        gateEnabled: boolean;
      }
    | undefined;
  sharedSnapshot:
    | {
        sourceFullName: string;
        visibility: string;
        defaultBranch: string;
        commitSha: string;
        files: string[];
        stale: boolean;
        lastError: string | null;
      }
    | undefined;
  sharedSourceFullName: string;
  sharedSourceInstalled: boolean;
}

type SaveStatus =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; message: string }
  | { state: "error"; message: string };

function SaveStatusLine({ status }: { status: SaveStatus }) {
  if (status.state === "idle") return null;
  if (status.state === "saving") {
    return <p className="text-xs text-charcoal/55" role="status">Saving...</p>;
  }
  return (
    <p
      role={status.state === "error" ? "alert" : "status"}
      className={`text-xs ${status.state === "error" ? "text-rust" : "text-gate"}`}
    >
      {status.message}
    </p>
  );
}

/**
 * A checkbox that saves on change. The optimistic state reverts when the save
 * fails, so the control never shows a state the server rejected.
 */
function AutoSaveToggle({
  slug,
  name,
  action,
  defaultChecked,
  title,
  description,
  onSaved,
}: {
  slug: string;
  name: string;
  action: (
    previousState: OrgSettingsActionState | null,
    formData: FormData,
  ) => Promise<OrgSettingsActionState>;
  defaultChecked: boolean;
  title: string;
  description: React.ReactNode;
  onSaved?: (checked: boolean) => void;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(defaultChecked);
  const [status, setStatus] = useState<SaveStatus>({ state: "idle" });
  const [, startTransition] = useTransition();
  // Rapid toggling overlaps saves; only the latest save may report its outcome
  // or revert the optimistic state, so an early response cannot clobber it.
  const saveSequence = useRef(0);

  const save = (next: boolean) => {
    const sequence = ++saveSequence.current;
    setChecked(next);
    setStatus({ state: "saving" });
    startTransition(async () => {
      const form = new FormData();
      form.set("slug", slug);
      form.set(name, next ? "on" : "off");
      try {
        const result = await action(null, form);
        if (sequence !== saveSequence.current) return;
        if (result.status === "error") {
          setChecked(!next);
          setStatus({ state: "error", message: result.message });
          return;
        }
        setStatus({ state: "saved", message: result.message });
        onSaved?.(next);
        router.refresh();
      } catch {
        if (sequence !== saveSequence.current) return;
        setChecked(!next);
        setStatus({ state: "error", message: "Could not save. Try again." });
      }
    });
  };

  return (
    <div className="rounded-card border border-stone/80 p-4">
      <label className="flex items-start justify-between gap-4">
        <span>
          <span className="font-medium">{title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-charcoal/60">
            {description}
          </span>
        </span>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => save(event.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-[#2F6F4E]"
        />
      </label>
      <div className="mt-2 min-h-4">
        <SaveStatusLine status={status} />
      </div>
    </div>
  );
}

const CONFIG_FALLBACKS_SAVE_DEBOUNCE_MS = 1200;

export function SettingsForm({
  slug,
  settings,
  billedMode,
  managedReviewsPaused,
  hostedInferenceAvailable,
  trialCanSwitchProvider,
  sharedSnapshot,
  sharedSourceFullName,
  sharedSourceInstalled,
}: SettingsFormProps) {
  const [inferenceState, inferenceAction, inferencePending] = useActionState(
    saveOrgInferenceSettings,
    null,
  );
  const [bringOwnKey, setBringOwnKey] = useState(billedMode !== "hosted");
  const [apiKey, setApiKey] = useState("");
  const [apiFormat, setApiFormat] = useState(settings?.apiFormat ?? "openai-compatible");
  const [additionalAuth, setAdditionalAuth] = useState(settings?.hasAdditionalAuth ?? false);
  const [apiAuthHeader, setApiAuthHeader] = useState("");
  const [apiAuthValue, setApiAuthValue] = useState("");
  const [sharedConfigEnabled, setSharedConfigEnabled] = useState(
    settings?.sharedConfigEnabled ?? true,
  );

  const [configYaml, setConfigYaml] = useState(settings?.configYaml ?? "");
  const [guardrailsMd, setGuardrailsMd] = useState(settings?.guardrailsMd ?? "");
  const [contentPolicyMd, setContentPolicyMd] = useState(settings?.contentPolicyMd ?? "");
  const [fallbacksStatus, setFallbacksStatus] = useState<SaveStatus>({ state: "idle" });
  const fallbacksDirty = useRef(false);
  const [, startFallbacksTransition] = useTransition();

  // Debounced save for the fallback texts. Only edits mark the state dirty, so
  // the initial render never saves; the server rejects invalid YAML and the
  // error stays on screen until the next edit resolves it.
  useEffect(() => {
    if (!fallbacksDirty.current) return;
    const timer = setTimeout(() => {
      setFallbacksStatus({ state: "saving" });
      startFallbacksTransition(async () => {
        const form = new FormData();
        form.set("slug", slug);
        form.set("configYaml", configYaml);
        form.set("guardrailsMd", guardrailsMd);
        form.set("contentPolicyMd", contentPolicyMd);
        try {
          const result = await saveOrgConfigFallbacks(null, form);
          setFallbacksStatus(
            result.status === "error"
              ? { state: "error", message: result.message }
              : { state: "saved", message: "Saved." },
          );
        } catch {
          setFallbacksStatus({ state: "error", message: "Could not save. Try again." });
        }
      });
    }, CONFIG_FALLBACKS_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [slug, configYaml, guardrailsMd, contentPolicyMd]);
  const editFallback = (setter: (value: string) => void) => (value: string) => {
    fallbacksDirty.current = true;
    setter(value);
  };

  const textareaClass =
    "mt-1 min-h-36 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs leading-relaxed focus:border-gate focus:outline-none";
  const apiKeyAction = bringOwnKey ? (apiKey ? "replace" : "keep") : "remove";
  const apiAuthAction = !bringOwnKey || !additionalAuth
    ? "remove"
    : apiAuthHeader || apiAuthValue
      ? "replace"
      : "keep";

  return (
    <div className="card mt-3 space-y-5 p-5">
      <div className="space-y-4">
        <AutoSaveToggle
          slug={slug}
          name="gateEnabled"
          action={setOrgGateEnabled}
          defaultChecked={settings?.gateEnabled ?? false}
          title="Merge gate"
          description={
            <>
              Fail <code>postil/gate</code> on blocking findings. GitHub blocks merges only when
              repository rules require that check. Turn this off for advisory reviews. See the{" "}
              <Link href="/docs/gate" className="text-rust hover:underline">gate guide</Link>.
            </>
          }
        />
        <form action={inferenceAction} className="rounded-card border border-stone/80 p-4">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="apiKeyAction" value={apiKeyAction} />
          <input type="hidden" name="apiAuthAction" value={apiAuthAction} />
          <p className="font-medium">Inference</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer items-center gap-3 rounded-card border border-stone/70 px-3 py-2 text-sm">
              <input
                type="radio"
                name="providerMode"
                value="hosted"
                checked={!bringOwnKey}
                disabled={
                  !hostedInferenceAvailable ||
                  (billedMode !== "hosted" && !trialCanSwitchProvider)
                }
                onChange={() => setBringOwnKey(false)}
                className="h-4 w-4 accent-[#2F6F4E]"
              />
              <span>
                <span className="block font-medium">
                  Hosted by Postil
                  {!hostedInferenceAvailable ||
                  managedReviewsPaused ||
                  (billedMode !== "hosted" && !trialCanSwitchProvider)
                    ? " (paused)"
                    : ""}
                </span>
                <span className="text-xs text-charcoal/70">
                  {!hostedInferenceAvailable
                    ? "Hosted inference is paused."
                    : managedReviewsPaused
                    ? "Managed reviews are paused."
                    : billedMode === "hosted" || trialCanSwitchProvider
                    ? "Postil chooses and operates the models."
                    : "New hosted inference setup is unavailable."}
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-3 rounded-card border border-stone/70 px-3 py-2 text-sm">
              <input
                type="radio"
                name="providerMode"
                value="byok"
                checked={bringOwnKey}
                disabled={billedMode === "hosted" && !trialCanSwitchProvider}
                onChange={() => setBringOwnKey(true)}
                className="h-4 w-4 accent-[#2F6F4E]"
              />
              <span>
                <span className="block font-medium">Use your provider</span>
                <span className="text-xs text-charcoal/70">Connect your API, models, and key.</span>
              </span>
            </label>
          </div>
          <p className="mt-3 text-xs text-charcoal/60">
            {trialCanSwitchProvider ? (
              <>
                {hostedInferenceAvailable
                  ? "Choose hosted inference or your provider during the free trial."
                  : "Use your provider during the free trial. Hosted inference is paused."}{" "}
                <Link href={`/orgs/${slug}/billing`} className="text-rust hover:underline">
                  View trial.
                </Link>
              </>
            ) : billedMode ? (
              <>
                Your private-repository plan uses {billedMode === "byok" ? "BYOK" : "hosted inference"}.{" "}
                <Link href={`/orgs/${slug}/billing`} className="text-rust hover:underline">
                  View billing.
                </Link>
              </>
            ) : (
              <>
                You can stage inference settings before subscribing. Private repositories remain inactive until a matching plan is enabled on{" "}
                <Link href={`/orgs/${slug}/billing`} className="text-rust hover:underline">Billing</Link>.
              </>
            )}
          </p>
          {bringOwnKey && (
            <>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="font-medium">API format</span>
                <select
                  name="apiFormat"
                  value={apiFormat}
                  onChange={(event) => setApiFormat(event.target.value)}
                  className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 text-sm focus:border-gate focus:outline-none"
                >
                  <option value="openai-compatible">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic</option>
                </select>
                <span className="mt-1 block text-xs text-charcoal/55">
                  Choose the request format your API accepts.
                </span>
              </label>
              <label className="block text-sm">
                <span className="font-medium">API URL</span>
                <input
                  type="url"
                  name="apiBase"
                  required
                  defaultValue={settings?.apiBase ?? ""}
                  placeholder={
                    apiFormat === "anthropic"
                      ? "https://api.anthropic.com/v1"
                      : "https://provider.example/v1"
                  }
                  className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
                />
              </label>
              <label className="block text-sm">
                <span className="font-medium">Provider key</span>
                <input
                  type="password"
                  name="apiKey"
                  required={!settings?.hasKey}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="off"
                  placeholder={settings?.hasKey ? "Leave blank to keep stored key" : "Provider key"}
                  className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
                />
              </label>
              <label className="block text-sm">
                <span className="font-medium">Primary model</span>
                <input
                  type="text"
                  name="model"
                  required
                  defaultValue={settings?.model ?? ""}
                  placeholder="model identifier"
                  className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
                />
              </label>
              <label className="block text-sm sm:col-span-2">
                <span className="font-medium">Fallback models</span>
                <input
                  type="text"
                  name="modelCascade"
                  defaultValue={settings?.modelCascade ?? ""}
                  placeholder="optional, comma-separated"
                  className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
                />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-card border border-stone/70 px-3 py-2 text-sm sm:col-span-2">
                <span>
                  <span className="block font-medium">Additional API authentication</span>
                  <span className="text-xs text-charcoal/55">For a private gateway in front of the provider.</span>
                </span>
                <input
                  type="checkbox"
                  checked={additionalAuth}
                  onChange={(event) => setAdditionalAuth(event.target.checked)}
                  className="h-4 w-4 accent-[#2F6F4E]"
                />
              </label>
              {additionalAuth && (
                <>
                  <label className="block text-sm">
                    <span className="font-medium">Auth header</span>
                    <input
                      type="text"
                      name="apiAuthHeader"
                      required={!settings?.hasAdditionalAuth || Boolean(apiAuthValue)}
                      value={apiAuthHeader}
                      onChange={(event) => setApiAuthHeader(event.target.value)}
                      placeholder={settings?.hasAdditionalAuth ? "Leave blank to keep stored auth" : "X-Gateway-Key"}
                      autoComplete="off"
                      className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="font-medium">Auth value</span>
                    <input
                      type="password"
                      name="apiAuthValue"
                      required={!settings?.hasAdditionalAuth || Boolean(apiAuthHeader)}
                      value={apiAuthValue}
                      onChange={(event) => setApiAuthValue(event.target.value)}
                      placeholder={settings?.hasAdditionalAuth ? "Leave blank to keep stored auth" : "Credential"}
                      autoComplete="off"
                      className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
                    />
                  </label>
                </>
              )}
              </div>
              <p className="mt-3 text-xs text-charcoal/50">
                Provider credentials are stored encrypted and never shown again.
              </p>
              <p className="mt-2 text-xs font-medium leading-relaxed text-charcoal/80">
                Postil sends review input, including private code, to this
                endpoint. Use only a provider you trust with that code.
              </p>
            </>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button
              type="submit"
              disabled={inferencePending}
              className="btn-primary text-sm disabled:opacity-60"
            >
              {inferencePending ? "Saving..." : "Save inference settings"}
            </button>
            {inferenceState && (
              <p
                role={inferenceState.status === "error" ? "alert" : "status"}
                className={`text-sm ${inferenceState.status === "error" ? "text-rust" : "text-gate"}`}
              >
                {inferenceState.message}
              </p>
            )}
          </div>
        </form>
      </div>

      <div className="border-t border-stone/60 pt-5">
        <AutoSaveToggle
          slug={slug}
          name="sharedConfigEnabled"
          action={setOrgSharedConfigEnabled}
          defaultChecked={settings?.sharedConfigEnabled ?? true}
          title="Shared owner configuration"
          description={
            <>
              Read <code>.postil.yaml</code>, <code>.postil/guardrails.md</code>, and{" "}
              <code>.postil/content-policy.md</code> from the default branch of the installed{" "}
              <code>{sharedSourceFullName}</code> repository.
            </>
          }
          onSaved={setSharedConfigEnabled}
        />
        <p className="mt-2 text-xs leading-relaxed text-charcoal/55">
          Repository files win per path. Shared files then override the form fallbacks below.
          The GitHub App must have access to the <code>.github</code> repository. Files in a
          public repository are public; files in a private or internal repository are visible to
          people with repository access. Add the repository to the App installation after creating
          it. Policy text cannot be treated as secret because review output can reveal its effect.
          Anyone who can merge to this repository can change policy for every inheriting
          repository. Protect its default branch with CODEOWNERS, a ruleset, and required review.
        </p>
        {sharedSnapshot && (
          <div className="mt-3 rounded-card border border-stone/70 bg-ivory px-3 py-2 text-xs">
            <p className="font-mono text-[11px] text-charcoal">
              {sharedSnapshot.sourceFullName} · {sharedSnapshot.visibility} ·{" "}
              {sharedSnapshot.defaultBranch}@{sharedSnapshot.commitSha.slice(0, 7)}
            </p>
            <p className={`mt-1 ${sharedSnapshot.stale ? "text-rust" : "text-charcoal/55"}`}>
              {!sharedConfigEnabled
                ? "Shared owner configuration is disabled. The stored snapshot is not used."
                : !sharedSourceInstalled
                ? `The App installation does not include ${sharedSourceFullName}. The stored snapshot is not used.`
                : sharedSnapshot.stale
                ? `Using the last known good snapshot because GitHub is ${sharedSnapshot.lastError ?? "unavailable"}.`
                : sharedSnapshot.files.length > 0
                  ? `${sharedSnapshot.files.length} shared file${sharedSnapshot.files.length === 1 ? "" : "s"} active.`
                  : "The source repository has no shared Postil files."}
            </p>
          </div>
        )}
        {!sharedSnapshot && sharedConfigEnabled && (
          <p className="mt-3 rounded-card border border-stone/70 bg-ivory px-3 py-2 text-xs text-charcoal/60">
            {sharedSourceInstalled
              ? "No verified shared snapshot is available. Postil checks the source during reviews."
              : `The App installation does not include ${sharedSourceFullName}.`}
          </p>
        )}
      </div>

      <div className="border-t border-stone/60 pt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="font-medium">Form fallbacks</p>
          <SaveStatusLine status={fallbacksStatus} />
        </div>
        <p className="mt-1 text-xs text-charcoal/70">
          Used only when neither the repository nor shared owner configuration provides the
          matching file. Changes save automatically. See the{" "}
          <Link href="/docs/config" className="text-rust hover:underline">
            configuration reference
          </Link>
          .
        </p>
      </div>
      <div className="block text-sm">
        <span className="font-medium">.postil.yaml</span>
        <span className="mt-1 block text-xs text-charcoal/60">
          Sets review, gate, and integration options for repositories without a root
          Postil config file. Hosted model selection is managed by Postil.
        </span>
        <ConfigYamlEditor value={configYaml} onChange={editFallback(setConfigYaml)} />
        <textarea
          name="configYaml"
          aria-label=".postil.yaml source"
          value={configYaml}
          onChange={(event) => editFallback(setConfigYaml)(event.target.value)}
          placeholder={"review:\n  minConfidence: 0.8"}
          spellCheck={false}
          className={textareaClass}
        />
      </div>
      <label className="block text-sm">
        <span className="font-medium">.postil/guardrails.md</span>
        <span className="mt-1 block text-xs text-charcoal/60">
          Defines organization review rules when the repository has no guardrails file.
        </span>
        <textarea
          name="guardrailsMd"
          value={guardrailsMd}
          onChange={(event) => editFallback(setGuardrailsMd)(event.target.value)}
          placeholder="No new production dependencies without approval."
          spellCheck={false}
          className={textareaClass}
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium">.postil/content-policy.md</span>
        <span className="mt-1 block text-xs text-charcoal/60">
          Defines organization content rules when the repository has no content policy.
        </span>
        <textarea
          name="contentPolicyMd"
          value={contentPolicyMd}
          onChange={(event) => editFallback(setContentPolicyMd)(event.target.value)}
          placeholder="Avoid unsupported performance claims."
          spellCheck={false}
          className={textareaClass}
        />
      </label>
    </div>
  );
}
