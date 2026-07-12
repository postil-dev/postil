"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { saveOrgSettings } from "./actions";

interface SettingsFormProps {
  slug: string;
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
        escalationEmail: string | null;
      }
    | undefined;
}

export function SettingsForm({ slug, settings }: SettingsFormProps) {
  const [state, formAction, pending] = useActionState(saveOrgSettings, null);
  const [bringOwnKey, setBringOwnKey] = useState(settings?.hasKey ?? false);
  const [apiKey, setApiKey] = useState("");
  const [additionalAuth, setAdditionalAuth] = useState(settings?.hasAdditionalAuth ?? false);
  const [apiAuthHeader, setApiAuthHeader] = useState("");
  const [apiAuthValue, setApiAuthValue] = useState("");
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
        <div className="rounded-card border border-stone/80 p-4">
          <p className="font-medium">Inference</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer items-center gap-3 rounded-card border border-stone/70 px-3 py-2 text-sm">
              <input
                type="radio"
                name="providerMode"
                value="hosted"
                checked={!bringOwnKey}
                onChange={() => setBringOwnKey(false)}
                className="h-4 w-4 accent-[#2F6F4E]"
              />
              <span>
                <span className="block font-medium">Hosted by Postil</span>
                <span className="text-xs text-charcoal/55">Postil chooses and operates the models.</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-3 rounded-card border border-stone/70 px-3 py-2 text-sm">
              <input
                type="radio"
                name="providerMode"
                value="byok"
                checked={bringOwnKey}
                onChange={() => setBringOwnKey(true)}
                className="h-4 w-4 accent-[#2F6F4E]"
              />
              <span>
                <span className="block font-medium">Use your provider</span>
                <span className="text-xs text-charcoal/55">Connect your API, models, and key.</span>
              </span>
            </label>
          </div>
          {bringOwnKey && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="font-medium">API format</span>
                <select
                  name="apiFormat"
                  defaultValue={settings?.apiFormat ?? "openai-compatible"}
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
                  placeholder="https://api.anthropic.com/v1"
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
          )}
          <p className="mt-3 text-xs text-charcoal/50">
            Stored encrypted and never shown again.
          </p>
        </div>
      </div>

      <div className="border-t border-stone/60 pt-5">
        <p className="font-medium">Human escalation notifications</p>
        <p className="mt-1 text-xs text-charcoal/70">
          Postil emails this organization-owned address when a new calibrated{" "}
          <code>humanEscalation</code> finding requires human attention.
        </p>
        <label className="mt-3 block text-sm">
          <span className="font-medium">Notification email</span>
          <input
            type="email"
            name="escalationEmail"
            defaultValue={settings?.escalationEmail ?? ""}
            placeholder="code-owners@example.com"
            autoComplete="email"
            className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
          />
        </label>
      </div>

      <div className="border-t border-stone/60 pt-5">
        <p className="font-medium">Hosted review configuration</p>
        <p className="mt-1 text-xs text-charcoal/70">
          Used only when a repository does not provide the matching file. See the{" "}
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
