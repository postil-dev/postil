"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { saveOrgSettings } from "./actions";

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
  const [state, formAction, pending] = useActionState(saveOrgSettings, null);
  const [bringOwnKey, setBringOwnKey] = useState(billedMode !== "hosted");
  const [apiKey, setApiKey] = useState("");
  const [apiFormat, setApiFormat] = useState(settings?.apiFormat ?? "openai-compatible");
  const [additionalAuth, setAdditionalAuth] = useState(settings?.hasAdditionalAuth ?? false);
  const [apiAuthHeader, setApiAuthHeader] = useState("");
  const [apiAuthValue, setApiAuthValue] = useState("");
  const sharedConfigEnabled = settings?.sharedConfigEnabled ?? true;
  const textareaClass =
    "mt-1 min-h-36 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs leading-relaxed focus:border-gate focus:outline-none";
  const apiKeyAction = bringOwnKey ? (apiKey ? "replace" : "keep") : "remove";
  const apiAuthAction = !bringOwnKey || !additionalAuth
    ? "remove"
    : apiAuthHeader || apiAuthValue
      ? "replace"
      : "keep";

  return (
    <form action={formAction} className="card mt-3 space-y-5 p-5">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="apiKeyAction" value={apiKeyAction} />
      <input type="hidden" name="apiAuthAction" value={apiAuthAction} />

      <div className="space-y-4">
        <label className="flex items-start justify-between gap-4 rounded-card border border-stone/80 p-4">
          <span>
            <span className="font-medium">Merge gate</span>
            <span className="mt-1 block text-xs leading-relaxed text-charcoal/60">
              Fail <code>postil/gate</code> on blocking findings. GitHub blocks merges only when
              repository rules require that check. Turn this off for advisory reviews. See the{" "}
              <Link href="/docs/gate" className="text-rust hover:underline">gate guide</Link>.
            </span>
          </span>
          <input type="hidden" name="gateEnabled" value="off" />
          <input
            type="checkbox"
            name="gateEnabled"
            defaultChecked={settings?.gateEnabled ?? false}
            value="on"
            className="mt-1 h-4 w-4 shrink-0 accent-[#2F6F4E]"
          />
        </label>
        <div className="rounded-card border border-stone/80 p-4">
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
        </div>
      </div>

      <div className="border-t border-stone/60 pt-5">
        <label
          className={`flex items-start justify-between gap-4 rounded-card border p-4 ${
            sharedSourceInstalled ? "border-stone/80" : "border-stone/60"
          }`}
        >
          <span className={sharedSourceInstalled ? undefined : "opacity-70"}>
            <span className="font-medium">Shared owner configuration</span>
            <span className="mt-1 block text-xs leading-relaxed text-charcoal/60">
              Read <code>.postil.yaml</code>, <code>.postil/guardrails.md</code>, and{" "}
              <code>.postil/content-policy.md</code> from the default branch of the installed{" "}
              <code>{sharedSourceFullName}</code> repository.
            </span>
            {!sharedSourceInstalled && (
              <span className="mt-2 block text-xs leading-relaxed text-rust">
                Requires the <code>{sharedSourceFullName}</code> repository, which the App
                installation does not include. Create it, add it to the App installation,
                and this setting takes effect on the next review.
              </span>
            )}
          </span>
          <input
            type="hidden"
            name="sharedConfigEnabled"
            value="off"
          />
          <input
            type="checkbox"
            name="sharedConfigEnabled"
            defaultChecked={sharedConfigEnabled}
            value="on"
            className="mt-1 h-4 w-4 shrink-0 accent-[#2F6F4E]"
          />
        </label>
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
        {!sharedSnapshot && sharedConfigEnabled && sharedSourceInstalled && (
          <p className="mt-3 rounded-card border border-stone/70 bg-ivory px-3 py-2 text-xs text-charcoal/60">
            No verified shared snapshot is available. Postil checks the source during reviews.
          </p>
        )}
      </div>

      <div className="border-t border-stone/60 pt-5">
        <p className="font-medium">Form fallbacks</p>
        <p className="mt-1 text-xs text-charcoal/70">
          Used only when neither the repository nor shared owner configuration provides the
          matching file. See the{" "}
          <Link href="/docs/config" className="text-rust hover:underline">
            configuration reference
          </Link>
          .
        </p>
      </div>
      <label className="block text-sm">
        <span className="font-medium">.postil.yaml</span>
        <span className="mt-1 block text-xs text-charcoal/60">
          Sets review, gate, and integration options for repositories without a root
          Postil config file. Hosted model selection is managed by Postil.
        </span>
        <textarea
          name="configYaml"
          defaultValue={settings?.configYaml ?? ""}
          placeholder={"review:\n  minConfidence: 0.8"}
          spellCheck={false}
          className={textareaClass}
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium">.postil/guardrails.md</span>
        <span className="mt-1 block text-xs text-charcoal/60">
          Defines organization review rules when the repository has no guardrails file.
        </span>
        <textarea
          name="guardrailsMd"
          defaultValue={settings?.guardrailsMd ?? ""}
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
          defaultValue={settings?.contentPolicyMd ?? ""}
          placeholder="Avoid unsupported performance claims."
          spellCheck={false}
          className={textareaClass}
        />
      </label>

      {state && (
        <p
          role={state.status === "error" ? "alert" : "status"}
          className={`text-sm ${state.status === "error" ? "text-rust" : "text-gate"}`}
        >
          {state.message}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="btn-primary text-sm disabled:opacity-60"
      >
        {pending ? "Saving..." : "Save settings"}
      </button>
    </form>
  );
}
