"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  MobileNav,
  shouldShowInstallApp,
  type NavItem,
} from "@/components/mobile-nav";

interface AuthSession {
  login: string;
  dashboardHref: string;
  hasActiveInstallation: boolean;
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
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setSession(null);
          return;
        }
        const data = (await res.json()) as Partial<AuthSession>;
        if (!cancelled) {
          setSession(
            data.login && data.dashboardHref
              ? {
                  login: data.login,
                  dashboardHref: data.dashboardHref,
                  hasActiveInstallation: data.hasActiveInstallation === true,
                }
              : null,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="hidden shrink-0 items-center justify-end gap-5 whitespace-nowrap lg:flex lg:w-40">
        {session === undefined ? null : session === null ? (
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
        )}
      </div>
      {shouldShowInstallApp(session) && (
        <Link
          href="/install"
          className="btn-primary hidden whitespace-nowrap text-sm sm:inline-block"
        >
          Install the App
        </Link>
      )}
      <MobileNav items={items} session={session} />
    </>
  );
}
