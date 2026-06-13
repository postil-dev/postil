"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the error to the browser console for debugging; no PII is logged.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col items-start px-6 py-24 md:py-32">
      <p className="eyebrow">Error</p>
      <h1 className="serif-display mt-4 max-w-2xl text-4xl md:text-5xl">
        Something failed, so we are failing closed.
      </h1>
      <p className="mt-6 max-w-xl text-lg text-ink-soft">
        This page hit an unexpected error. The same principle Postil applies to
        a review applies here: when we cannot be sure, we say so instead of
        pretending everything is fine.
      </p>
      <div className="mt-8 flex flex-wrap gap-4">
        <button type="button" onClick={() => reset()} className="btn-primary">
          Try again
        </button>
        <Link href="/" className="btn-secondary">
          Back to home
        </Link>
      </div>
      {error.digest && (
        <p className="rule mt-12 w-full max-w-xl pt-6 font-mono text-xs text-charcoal/70">
          Reference: {error.digest}
        </p>
      )}
    </div>
  );
}
