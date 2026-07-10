"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Session-aware auth links for the site header. Marketing pages stay static;
 * this probes /api/auth/session from the client and swaps "Sign in" for
 * "Reports" + "Sign out" when a session exists.
 */
export function AuthNav() {
  const [login, setLogin] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { login?: string };
        if (!cancelled && data.login) setLogin(data.login);
      })
      .catch(() => {
        // Signed-out rendering is the correct fallback on any failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="hidden shrink-0 items-center justify-end gap-5 whitespace-nowrap lg:flex lg:w-36">
      {login === null ? (
        <Link
          href="/login"
          className="text-[15px] text-charcoal/80 hover:text-charcoal"
        >
          Sign in
        </Link>
      ) : (
        <>
          <Link
            href="/reports"
            className="text-[15px] text-charcoal/80 hover:text-charcoal"
          >
            Reports
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
  );
}
