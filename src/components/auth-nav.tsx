"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { MobileNav, type NavItem } from "@/components/mobile-nav";

interface AuthSession {
  login: string;
  dashboardHref: string;
}

/**
 * Session-aware actions for the site header. Marketing pages stay static;
 * this probes /api/auth/session from the client and passes the authenticated
 * dashboard destination through to both desktop and mobile navigation.
 */
export function HeaderActions({ items }: { items: readonly NavItem[] }) {
  const [session, setSession] = useState<AuthSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as Partial<AuthSession>;
        if (!cancelled && data.login && data.dashboardHref) {
          setSession({ login: data.login, dashboardHref: data.dashboardHref });
        }
      })
      .catch(() => {
        // Signed-out rendering is the correct fallback on any failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="hidden shrink-0 items-center justify-end gap-5 whitespace-nowrap lg:flex lg:w-40">
        {session === null ? (
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
      <Link
        href="/install"
        className="btn-primary hidden whitespace-nowrap text-sm sm:inline-block"
      >
        Install the App
      </Link>
      <MobileNav items={items} session={session} />
    </>
  );
}
