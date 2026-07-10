"use client";

import Link from "next/link";
import { useActionState } from "react";

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
      }
    | undefined;
}

export function SettingsForm({ slug, settings }: SettingsFormProps) {
  const [state, formAction, pending] = useActionState(saveOrgSettings, null);
  const textareaClass =
    "mt-1 min-h-36 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs leading-relaxed focus:border-gate focus:outline-none";

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
        <label className="block text-sm">
          <span className="font-medium">Model</span>
          <input
            type="text"
            name="model"
            defaultValue={settings?.model ?? ""}
            placeholder="deepseek/deepseek-v4-pro"
            className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Model cascade</span>
          <input
            type="text"
            name="modelCascade"
            defaultValue={settings?.modelCascade ?? ""}
            placeholder="qwen/qwen3-coder"
            className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="flex items-center justify-between font-medium">
            <span>API key</span>
            {settings?.hasKey && (
              <span className="font-mono text-[11px] text-gate">
                a key is stored (write-only)
              </span>
            )}
          </span>
          <input
            type="password"
            name="apiKey"
            autoComplete="off"
            placeholder={settings?.hasKey ? "leave blank to keep current key" : "sk-..."}
            className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs focus:border-gate focus:outline-none"
          />
        </label>
        {settings?.hasKey && (
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" name="removeKey" className="accent-[#C24A2A]" />
            Remove the stored key (fall back to the hosted default)
          </label>
        )}
        <p className="text-xs text-charcoal/50">
          Keys are sealed with AES-256-GCM before storage and can never be read back from
          this form. BYOK review calls use this key under your provider account; leave
          it unset to use the hosted default.
        </p>
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
      <button type="submit" disabled={pending} className="btn-primary text-sm disabled:opacity-60">
        {pending ? "Saving..." : "Save settings"}
      </button>
    </form>
  );
}
