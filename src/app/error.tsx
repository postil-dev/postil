"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import { membershipRetryDelayFromDigest } from "@/lib/auth-navigation";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryStartedRef = useRef(false);
  const [retryPending, startRetry] = useTransition();
  const retryDelayMs = useMemo(
    () => membershipRetryDelayFromDigest(error.digest),
    [error.digest],
  );
  const [countdown, setCountdown] = useState(() => ({
    error,
    remainingMs: retryDelayMs ?? 0,
  }));

  useEffect(() => {
    // Surface the error to the browser console for debugging; no PII is logged.
    console.error(error);
    headingRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (retryDelayMs === undefined) return;
    const startedAt = window.performance.now();
    setCountdown({ error, remainingMs: retryDelayMs });
    const updateCountdown = () => {
      const elapsed = window.performance.now() - startedAt;
      const remainingMs = Math.max(0, retryDelayMs - elapsed);
      setCountdown({ error, remainingMs });
      if (remainingMs === 0) window.clearInterval(interval);
    };
    const interval = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(interval);
  }, [error, retryDelayMs]);

  useEffect(() => {
    if (!retryPending) retryStartedRef.current = false;
  }, [retryPending]);

  const retryRemainingMs =
    countdown.error === error
      ? countdown.remainingMs
      : (retryDelayMs ?? 0);
  const membershipVerificationUnavailable = retryDelayMs !== undefined;
  const retryReady =
    retryDelayMs === undefined || retryRemainingMs === 0;

  function retry(): void {
    if (!retryReady || retryPending || retryStartedRef.current) return;
    document.getElementById("main-content")?.focus({ preventScroll: true });
    retryStartedRef.current = true;
    startRetry(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <ErrorContent
      digest={error.digest}
      headingRef={headingRef}
      membershipVerificationUnavailable={membershipVerificationUnavailable}
      onRetry={retry}
      retryRemainingMs={retryDelayMs === undefined ? undefined : retryRemainingMs}
      retryPending={retryPending}
    />
  );
}

export function ErrorContent({
  digest,
  headingRef,
  membershipVerificationUnavailable,
  onRetry,
  retryRemainingMs,
  retryPending,
}: {
  digest?: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  membershipVerificationUnavailable: boolean;
  onRetry: () => void;
  retryRemainingMs?: number;
  retryPending: boolean;
}) {
  const title = membershipVerificationUnavailable
    ? "Organization access could not be verified."
    : "Something failed, so we are failing closed.";
  const description = membershipVerificationUnavailable
    ? "GitHub membership verification is temporarily unavailable. Your current page is preserved while you wait to try again."
    : "This page hit an unexpected error. The same principle Postil applies to a review applies here: when we cannot be sure, we say so instead of pretending everything is fine.";
  const retryReady = retryRemainingMs === undefined || retryRemainingMs === 0;
  const retryDisabled = retryPending || !retryReady;
  const retryStatus = retryStatusMessage({
    membershipVerificationUnavailable,
    retryRemainingMs,
    retryPending,
  });
  const retryAnnouncement = retryAnnouncementMessage({
    membershipVerificationUnavailable,
    retryRemainingMs,
    retryPending,
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col items-start px-6 py-24 md:py-32">
      <div>
        <p className="eyebrow">
          {membershipVerificationUnavailable ? "Service unavailable" : "Error"}
        </p>
        <h1
          id="membership-error-heading"
          ref={headingRef}
          tabIndex={-1}
          className="serif-display mt-4 max-w-2xl text-4xl md:text-5xl"
        >
          {title}
        </h1>
        <p className="mt-6 max-w-xl text-lg text-ink-soft">{description}</p>
      </div>
      <div className="mt-8 flex flex-wrap gap-4">
        <button
          type="button"
          onClick={onRetry}
          disabled={retryDisabled}
          aria-busy={retryPending}
          aria-describedby={retryStatus ? "membership-retry-status" : undefined}
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-60"
          suppressHydrationWarning
        >
          {retryPending ? "Trying again..." : "Try again"}
        </button>
        <Link href="/" className="btn-secondary">
          Back to home
        </Link>
      </div>
      <p
        id="membership-retry-status"
        className="mt-4 text-sm text-ink-soft"
        suppressHydrationWarning
      >
        {retryStatus}
      </p>
      <p
        id="membership-retry-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {retryAnnouncement}
      </p>
      {digest && (
        <p className="rule mt-12 w-full max-w-xl pt-6 font-mono text-xs text-charcoal/70">
          Reference: {digest}
        </p>
      )}
    </div>
  );
}

function retryStatusMessage({
  membershipVerificationUnavailable,
  retryRemainingMs,
  retryPending,
}: {
  membershipVerificationUnavailable: boolean;
  retryRemainingMs?: number;
  retryPending: boolean;
}): string {
  if (retryPending) {
    return membershipVerificationUnavailable
      ? "Checking organization access."
      : "Retrying this page.";
  }
  if (retryRemainingMs === undefined) return "";
  const remainingSeconds = Math.ceil(retryRemainingMs / 1_000);
  if (remainingSeconds <= 0) return "You can try again now.";
  if (remainingSeconds === 1) return "Retry available in 1 second.";
  if (remainingSeconds < 60) {
    return `Retry available in ${remainingSeconds} seconds.`;
  }
  const remainingMinutes = Math.ceil(remainingSeconds / 60);
  return remainingMinutes === 1
    ? "Retry available in 1 minute."
    : `Retry available in ${remainingMinutes} minutes.`;
}

function retryAnnouncementMessage({
  membershipVerificationUnavailable,
  retryRemainingMs,
  retryPending,
}: {
  membershipVerificationUnavailable: boolean;
  retryRemainingMs?: number;
  retryPending: boolean;
}): string {
  if (retryPending) {
    return membershipVerificationUnavailable
      ? "Checking organization access."
      : "Retrying this page.";
  }
  if (retryRemainingMs !== undefined && retryRemainingMs <= 0) {
    return "You can try again now.";
  }
  return "";
}
