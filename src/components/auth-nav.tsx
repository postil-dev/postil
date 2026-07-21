"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  installNavigationAction,
  MobileNav,
  type NavItem,
} from "@/components/mobile-nav";

export interface AuthSession {
  login: string;
  dashboardHref: string;
  hasActiveInstallation: boolean;
}

export function shouldRefreshSessionAfterPageShow(
  event: Pick<PageTransitionEvent, "persisted">,
): boolean {
  return event.persisted;
}

/**
 * Session-aware actions for the site header. Marketing pages stay static;
 * this probes /api/auth/session from the client and passes the authenticated
 * dashboard destination through to both desktop and mobile navigation.
 */
export function HeaderActions({ items }: { items: readonly NavItem[] }) {
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;

    function loadSession() {
      const activeRequest = ++requestId;
      fetch("/api/auth/session", { cache: "no-store" })
        .then(async (res) => {
          if (cancelled || activeRequest !== requestId) return;
          if (res.status === 401) {
            setSession(null);
            return;
          }
          if (!res.ok) {
            // A temporary verification or network failure is not evidence that
            // the visitor signed out. Retain the neutral loading state rather
            // than flashing anonymous actions into an authenticated shell.
            return;
          }
          const data = (await res.json()) as Partial<AuthSession>;
          if (cancelled || activeRequest !== requestId) return;
          setSession(
            data.login && data.dashboardHref
              ? {
                  login: data.login,
                  dashboardHref: data.dashboardHref,
                  hasActiveInstallation: data.hasActiveInstallation === true,
                }
              : undefined,
          );
        })
        .catch(() => undefined);
    }

    function refreshRestoredPage(event: PageTransitionEvent) {
      if (!shouldRefreshSessionAfterPageShow(event)) return;
      setSession(undefined);
      loadSession();
    }

    loadSession();
    window.addEventListener("pageshow", refreshRestoredPage);
    return () => {
      cancelled = true;
      window.removeEventListener("pageshow", refreshRestoredPage);
    };
  }, []);

  const installAction = installNavigationAction(session);

  return (
    <>
      <div className="hidden shrink-0 items-center justify-end gap-5 whitespace-nowrap lg:flex lg:w-40">
        <DesktopSessionActions session={session} />
      </div>
      {installAction && (
        <Link
          href="/install"
          className={`${
            installAction.variant === "primary" ? "btn-primary" : "btn-secondary"
          } hidden whitespace-nowrap text-sm sm:inline-block`}
        >
          {installAction.label}
        </Link>
      )}
      <MobileNav items={items} session={session} />
    </>
  );
}

export function DesktopSessionActions({
  session,
}: {
  session: AuthSession | null | undefined;
}) {
  if (session === undefined) {
    return (
      <span
        role="status"
        aria-busy="true"
        className="h-5 w-24 rounded bg-stone/70"
      >
        <span className="sr-only">Checking account status</span>
      </span>
    );
  }

  return session === null ? (
    <Link
      href="/login"
      className="text-[15px] text-charcoal/80 hover:text-charcoal"
    >
      Sign in
    </Link>
  ) : (
    <>
      <Link
        href={session.dashboardHref}
        className="text-[15px] text-charcoal/80 hover:text-charcoal"
      >
        Dashboard
      </Link>
      <form action="/api/auth/logout" method="post">
        <button
          type="submit"
          className="text-[15px] text-charcoal/80 hover:text-charcoal"
        >
          Sign out
        </button>
      </form>
    </>
  );
}
