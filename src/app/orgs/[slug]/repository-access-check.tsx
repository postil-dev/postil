"use client";

import { useActionState } from "react";

import {
  checkRepositoryAccess,
  type RepositoryAccessCheckState,
} from "./actions";

const INITIAL_STATE: RepositoryAccessCheckState = { status: "idle" };

export function RepositoryAccessCheck({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(checkRepositoryAccess, INITIAL_STATE);

  return (
    <section aria-labelledby="repository-access-heading">
      <p id="repository-access-heading" className="eyebrow">
        Repository access
      </p>
      <div className="card mt-3 p-4">
        <p className="text-sm text-charcoal/70">
          Check whether a repository is selected for this GitHub App installation.
        </p>
        <form action={action} className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <input type="hidden" name="slug" value={slug} />
          <label className="grid gap-1 text-xs font-medium text-charcoal/75">
            Owner
            <input
              name="owner"
              required
              autoComplete="off"
              placeholder="organization"
              className="w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs"
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-charcoal/75">
            Repository
            <input
              name="name"
              required
              autoComplete="off"
              placeholder="repository"
              className="w-full rounded-card border border-stone bg-ivory px-3 py-2 font-mono text-xs"
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="btn-secondary min-w-36 disabled:cursor-wait disabled:opacity-70"
          >
            {pending ? "Checking…" : "Check repository access"}
          </button>
        </form>
        <RepositoryAccessCheckResult state={state} />
      </div>
    </section>
  );
}

export function RepositoryAccessCheckResult({
  state,
}: {
  state: RepositoryAccessCheckState;
}) {
  if (state.status === "idle") return null;
  const isUnknown = state.status === "unknown";
  return (
    <div
      className={`mt-3 flex flex-wrap items-center justify-between gap-3 rounded-card border px-3 py-2 text-sm ${
        state.status === "selected"
          ? "border-gate/50 bg-gate/5 text-charcoal"
          : state.status === "not_selected"
            ? "border-rust/50 bg-rust/5 text-charcoal"
            : "border-stone/70 bg-paper text-charcoal/75"
      }`}
      role={isUnknown ? "alert" : "status"}
    >
      <p>{state.message}</p>
      {state.settingsUrl && (
        <a href={state.settingsUrl} className="btn-secondary text-xs">
          Manage repository access on GitHub
        </a>
      )}
    </div>
  );
}
