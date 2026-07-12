"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { saveOrgSettings } from "./actions";

interface SettingsFormProps {
  slug: string;
  settings:
    | {
        apiBase: string | null;
        model: string | null;
        modelCascade: string | null;
        hasKey: boolean;
        configYaml: string | null;
        guardrailsMd: string | null;
        contentPolicyMd: string | null;
        escalationEmail: string | null;
      }
    | undefined;
}

const HOSTED_DEFAULT_MODEL_CHAIN = [
  "mistralai/mistral-small-3.2-24b-instruct",
  "google/gemma-3-27b-it",
  "qwen/qwen3-32b",
] as const;

function modelChain(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

export function SettingsForm({ slug, settings }: SettingsFormProps) {
  const [state, formAction, pending] = useActionState(saveOrgSettings, null);
  const [bringOwnKey, setBringOwnKey] = useState(false);
  const textareaClass =
    "mt-1 min-h-36 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs leading-relaxed focus:border-gate focus:outline-none";
  const configuredModelChain = modelChain(settings?.modelCascade);
  const visibleModelChain =
    configuredModelChain.length > 0 ? configuredModelChain : [...HOSTED_DEFAULT_MODEL_CHAIN];

  return (
    <form action={formAction} className="card mt-3 space-y-5 p-5">
      <input type="hidden" name="slug" value={slug} />

      <div className="space-y-4">
        <p className="font-medium">LLM provider</p>
        <label className="block text-sm">
          <span className="font-medium">API base</span>
          <input
            type="url"
            name="apiBase"
            defaultValue={settings?.apiBase ?? ""}
            placeholder="https://openrouter.ai/api/v1"
            className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
          />
        </label>
        <div className="block text-sm">
          <span className="font-medium">Model</span>
          <input
            type="text"
            name="model"
            defaultValue={settings?.model ?? ""}
            placeholder="deepseek/deepseek-v4-pro"
            className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
          />
          <div className="mt-3 rounded-card border border-stone/80 bg-paper p-3">
            <div className="flex flex-wrap items-center gap-2">
              {visibleModelChain.map((model, index) => (
                <div key={`${model}-${index}`} className="flex items-center gap-2">
                  {index > 0 && <span className="font-mono text-xs text-charcoal/35">→</span>}
                  <span className="rounded-card border border-stone bg-ivory px-2.5 py-1 font-mono text-[11px] text-charcoal">
                    {model}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 inline-flex max-w-full items-start gap-2 rounded-card border border-gate/30 bg-gate/5 px-3 py-2 text-xs text-charcoal/70">
              <span className="mt-0.5 rounded-full border border-gate px-1.5 font-mono text-[10px] text-gate">
                info
              </span>
              <span>
                Models are tried in order. A later model is only used if an earlier one
                fails.
              </span>
            </div>
            {configuredModelChain.length === 0 && (
              <p className="mt-2 text-xs text-charcoal/55">
                Empty uses the hosted default of {HOSTED_DEFAULT_MODEL_CHAIN.join(" → ")}.
              </p>
            )}
          </div>
        </div>
        <label className="block text-sm">
          <span className="font-medium">Fallback models</span>
          <input
            type="text"
            name="modelCascade"
            defaultValue={settings?.modelCascade ?? ""}
            placeholder={HOSTED_DEFAULT_MODEL_CHAIN.join(", ")}
            className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
          />
          <span className="mt-1 block text-xs text-charcoal/60">
            Comma-separated fallback chain after the primary model.
          </span>
        </label>
        <div className="rounded-card border border-stone/80 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-medium">API key</p>
              <p className="mt-1 text-sm text-ink-soft">
                {settings?.hasKey
                  ? "Using your own API key."
                  : "Using Postil's hosted inference."}
              </p>
            </div>
            <span
              className={
                settings?.hasKey
                  ? "rounded-full border border-gate px-2.5 py-0.5 font-mono text-[11px] text-gate"
                  : "rounded-full border border-stone px-2.5 py-0.5 font-mono text-[11px] text-charcoal/60"
              }
            >
              {settings?.hasKey ? "BYOK" : "hosted"}
            </span>
          </div>
          {settings?.hasKey ? (
            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="flex items-center justify-between font-medium">
                  <span>Update key</span>
                  <span className="font-mono text-[11px] text-gate">
                    stored key cannot be read back
                  </span>
                </span>
                <input
                  type="password"
                  name="apiKey"
                  autoComplete="off"
                  placeholder="new provider key"
                  className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  name="apiKeyAction"
                  value="replace"
                  disabled={pending}
                  className="btn-secondary text-xs disabled:opacity-60"
                >
                  Update key
                </button>
                <button
                  type="submit"
                  name="apiKeyAction"
                  value="remove"
                  disabled={pending}
                  className="rounded-card border border-rust px-4 py-2 text-sm font-medium text-rust transition-colors hover:bg-rust hover:text-ivory disabled:opacity-60"
                >
                  Remove key
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <label className="flex items-center justify-between gap-3 rounded-card border border-stone/70 px-3 py-2 text-sm">
                <span className="font-medium">Bring your own key</span>
                <input
                  type="checkbox"
                  checked={bringOwnKey}
                  onChange={(event) => setBringOwnKey(event.target.checked)}
                  className="h-4 w-4 accent-[#2F6F4E]"
                />
              </label>
              {bringOwnKey && (
                <label className="block text-sm">
                  <span className="font-medium">Provider key</span>
                  <input
                    type="password"
                    name="apiKey"
                    autoComplete="off"
                    placeholder="sk-..."
                    className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
                  />
                </label>
              )}
              <input
                type="hidden"
                name="apiKeyAction"
                value={bringOwnKey ? "replace" : "keep"}
              />
            </div>
          )}
          <p className="mt-3 text-xs text-charcoal/50">
            Keys are sealed with AES-256-GCM before storage and can never be read
            back from this form. BYOK review calls use this key under your provider
            account.
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
          Sets review, gate, model, and integration options for repositories without a
          root Postil config file.
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
        name="apiKeyAction"
        value="keep"
        disabled={pending}
        className="btn-primary text-sm disabled:opacity-60"
      >
        {pending ? "Saving..." : "Save settings"}
      </button>
    </form>
  );
}
