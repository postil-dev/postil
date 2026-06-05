"use client";

import { useState } from "react";

export function SignInButton({ callbackUrl }: { callbackUrl: string }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: callbackUrl,
          errorCallbackURL: "/login",
        }),
      });
      const body = (await response.json()) as { url?: string };

      if (!response.ok || !body.url) {
        throw new Error("GitHub sign-in is not available.");
      }

      window.location.href = body.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub sign-in is not available.");
      setIsLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        className="inline-flex items-center justify-center rounded-lg border border-transparent bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-70"
        type="button"
        onClick={signIn}
        disabled={isLoading}
      >
        {isLoading ? "Starting sign-in" : "Continue with GitHub"}
      </button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
