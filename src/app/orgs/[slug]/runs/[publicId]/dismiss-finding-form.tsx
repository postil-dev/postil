"use client";

import { useActionState } from "react";

import {
  dismissFindingWithState,
  type DismissFindingActionState,
} from "../../actions";

const INITIAL_STATE: DismissFindingActionState = { status: "idle", message: "" };

export function DismissFindingForm({
  slug,
  publicId,
  findingId,
}: {
  slug: string;
  publicId: string;
  findingId: string;
}) {
  const [state, action, pending] = useActionState(dismissFindingWithState, INITIAL_STATE);
  const reasonDescriptionId = `dismiss-reasons-${findingId}`;
  return (
    <>
      <form action={action} className="mt-3 grid gap-3 sm:grid-cols-[auto_1fr_auto]">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="publicId" value={publicId} />
        <input type="hidden" name="findingId" value={findingId} />
        <label className="grid gap-1 text-xs font-medium text-charcoal/75">
          Reason
          <select
            name="reasonTag"
            required
            defaultValue=""
            aria-describedby={reasonDescriptionId}
            disabled={pending}
            className="rounded-md border border-stone bg-ivory px-3 py-2 text-sm text-charcoal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rust"
          >
            <option value="" disabled>Select a reason</option>
            <option value="false-positive">false-positive</option>
            <option value="accepted-risk">accepted-risk</option>
            <option value="out-of-scope">out-of-scope</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium text-charcoal/75">
          Rationale
          <textarea
            name="rationale"
            required
            minLength={1}
            rows={2}
            disabled={pending}
            className="min-h-16 rounded-md border border-stone bg-ivory px-3 py-2 text-sm text-charcoal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rust"
            placeholder="Why this finding does not block this commit"
          />
        </label>
        <button
          disabled={pending}
          className="rounded-md bg-charcoal px-4 py-2 text-sm font-semibold text-ivory hover:bg-rust disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? "Recording..." : "Dismiss finding"}
        </button>
      </form>
      <p id={reasonDescriptionId} className="mt-2 text-xs text-charcoal/70">
        False positive means the finding is incorrect. Accepted risk means the organization accepts the identified risk. Out of scope means this commit does not own the required change.
      </p>
      <p
        aria-live="polite"
        className={state.status === "error" ? "mt-2 text-xs text-rust" : "mt-2 text-xs text-charcoal/70"}
      >
        {state.message}
      </p>
    </>
  );
}
