"use client";

import { useActionState } from "react";

import { saveNotificationPreferences } from "../actions";

export function NotificationPreferencesForm({
  slug,
  billingSummaryEmail,
  serviceSummaryEmail,
}: {
  slug: string;
  billingSummaryEmail: boolean;
  serviceSummaryEmail: boolean;
}) {
  const [state, action, pending] = useActionState(
    saveNotificationPreferences,
    null,
  );

  return (
    <form action={action} className="mt-5 border-t border-stone/60 pt-4">
      <input type="hidden" name="slug" value={slug} />
      <fieldset>
        <legend className="text-sm font-medium">Email preferences</legend>
        <p className="mt-1 text-xs leading-relaxed text-charcoal/60">
          Optional email is addressed only to the verified billing contact.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Preference
            name="billingSummaryEmail"
            title="Billing summaries"
            description="Allow routine account and usage summaries."
            defaultChecked={billingSummaryEmail}
          />
          <Preference
            name="serviceSummaryEmail"
            title="Service summaries"
            description="Allow periodic review-health summaries."
            defaultChecked={serviceSummaryEmail}
          />
        </div>
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-charcoal/55">
          These preferences do not apply to security, verification, payment failure,
          trial expiry, or service-incident email.
        </p>
        <button
          type="submit"
          disabled={pending}
          className="btn-secondary text-xs disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save email preferences"}
        </button>
      </div>
      {state && (
        <p
          role={state.status === "error" ? "alert" : "status"}
          className={`mt-2 text-xs ${state.status === "error" ? "text-rust" : "text-gate"}`}
        >
          {state.message}
        </p>
      )}
    </form>
  );
}

function Preference({
  name,
  title,
  description,
  defaultChecked,
}: {
  name: string;
  title: string;
  description: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-card border border-stone/70 px-3 py-3 text-sm">
      <span>
        <span className="block font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-charcoal/60">
          {description}
        </span>
      </span>
      <input type="hidden" name={name} value="off" />
      <input
        type="checkbox"
        name={name}
        value="on"
        defaultChecked={defaultChecked}
        className="mt-1 h-4 w-4 shrink-0 accent-[#2F6F4E]"
      />
    </label>
  );
}
