"use client";

import { useActionState } from "react";

import {
  resendBillingContactVerification,
  saveBillingContact,
} from "../actions";

export function BillingContactForm({
  slug,
  activeEmail,
  pendingEmail,
  verified,
}: {
  slug: string;
  activeEmail: string | null;
  pendingEmail: string | null;
  verified: boolean;
}) {
  const [state, saveAction, saving] = useActionState(saveBillingContact, null);
  const [resendState, resendAction, resending] = useActionState(
    resendBillingContactVerification,
    null,
  );
  return (
    <div className="mt-5 border-t border-stone/60 pt-4">
      <form action={saveAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="slug" value={slug} />
        <label className="min-w-64 flex-1 text-xs">
          <span className="flex items-center gap-2 font-medium">
            Billing email
            {verified && (
              <span className="rounded-full border border-gate px-2 py-0.5 font-mono text-[10px] text-gate">
                verified
              </span>
            )}
          </span>
          <input
            type="email"
            name="billingContact"
            defaultValue={pendingEmail ?? activeEmail ?? ""}
            placeholder="billing@example.com"
            autoComplete="email"
            className="mt-1 w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs"
          />
        </label>
        <button type="submit" disabled={saving} className="btn-secondary text-xs disabled:opacity-60">
          {saving ? "Saving..." : "Save billing contact"}
        </button>
      </form>
      {pendingEmail && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-charcoal/60">
          <span>
            Check {pendingEmail} for the verification link.
            {activeEmail && " The verified contact remains active until replacement."}
          </span>
          <form action={resendAction}>
            <input type="hidden" name="slug" value={slug} />
            <button type="submit" disabled={resending} className="font-medium text-rust hover:underline disabled:opacity-60">
              {resending ? "Sending..." : "Resend"}
            </button>
          </form>
        </div>
      )}
      {[state, resendState].filter(Boolean).map((result, index) => (
        <p
          key={index}
          role={result!.status === "error" ? "alert" : "status"}
          className={`mt-2 text-xs ${result!.status === "error" ? "text-rust" : "text-gate"}`}
        >
          {result!.message}
        </p>
      ))}
    </div>
  );
}
