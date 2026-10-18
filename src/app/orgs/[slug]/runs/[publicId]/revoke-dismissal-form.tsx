"use client";

import { useActionState } from "react";

import {
  revokeFindingDismissalWithState,
  type DismissFindingActionState,
} from "../../actions";

const INITIAL_STATE: DismissFindingActionState = { status: "idle", message: "" };

export function RevokeDismissalForm({
  slug,
  publicId,
  findingId,
}: {
  slug: string;
  publicId: string;
  findingId: string;
}) {
  const [state, action, pending] = useActionState(
    revokeFindingDismissalWithState,
    INITIAL_STATE,
  );
  return (
    <form action={action} className="mt-4 grid gap-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="publicId" value={publicId} />
      <input type="hidden" name="findingId" value={findingId} />
      <label className="flex items-start gap-2 text-xs text-charcoal/75">
        <input type="checkbox" required disabled={pending} className="mt-0.5" />
        Revoke this dismissal and restore the finding's gate effect.
      </label>
      <button
        disabled={pending}
        className="w-fit rounded-md border border-rust/40 px-4 py-2 text-sm font-semibold text-rust hover:bg-rust/5 disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "Revoking..." : "Revoke dismissal"}
      </button>
      <p aria-live="polite" className={state.status === "error" ? "text-xs text-rust" : "text-xs text-charcoal/70"}>
        {state.message}
      </p>
    </form>
  );
}
