"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    posthog.capture("$exception", {
      $exception_message: error.message,
      $exception_type: error.name,
      ...(error.digest ? { digest: error.digest } : {}),
    });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 p-8">
          <h1 className="text-2xl font-semibold">Something went wrong.</h1>
          {error.digest ? (
            <p className="text-xs text-muted-foreground">ref {error.digest}</p>
          ) : null}
          <button
            type="button"
            className="rounded border px-3 py-1 text-sm"
            onClick={reset}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
