"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export interface NavItem {
  href: string;
  label: string;
}

export interface AuthSession {
  dashboardHref: string;
  hasActiveInstallation: boolean;
}

export interface InstallNavigationAction {
  label: "Install the App" | "Add account";
  variant: "primary" | "secondary";
}

export function installNavigationAction(
  session: AuthSession | null | undefined,
): InstallNavigationAction | null {
  if (session === undefined) return null;
  return session?.hasActiveInstallation
    ? { label: "Add account", variant: "secondary" }
    : { label: "Install the App", variant: "primary" };
}

/**
 * Accessible disclosure menu for viewports below `lg`. Toggles with a
 * hamburger button, traps nothing but closes on Escape, outside click,
 * route change, and viewport widening.
 */
export function MobileNav({
  items,
  session,
}: {
  items: readonly NavItem[];
  session: AuthSession | null | undefined;
}) {
  const installAction = installNavigationAction(session);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="-mr-2 inline-flex h-10 w-10 items-center justify-center rounded text-charcoal"
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          {open ? (
            <>
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </>
          ) : (
            <>
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </>
          )}
        </svg>
      </button>

      {open && (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-full z-40 h-screen bg-charcoal/25"
        />
      )}
      {open && (
        <div
          id="mobile-nav-panel"
          ref={panelRef}
          className="absolute inset-x-0 top-full z-50 border-b border-charcoal/10 bg-ivory shadow-lg"
        >
          <nav className="mx-auto flex max-w-6xl flex-col px-6 py-3 text-[15px]">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="border-b border-stone/60 py-3 text-charcoal/80 last:border-b-0 hover:text-charcoal"
              >
                {item.label}
              </Link>
            ))}
            <div className="mt-3 flex items-center gap-3 pb-1">
              {session === undefined ? null : session === null ? (
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className="btn-secondary flex-1 text-center text-sm"
                >
                  Sign in
                </Link>
              ) : (
                <>
                  <Link
                    href={session.dashboardHref}
                    onClick={() => setOpen(false)}
                    className="btn-secondary flex-1 text-center text-sm"
                  >
                    Dashboard
                  </Link>
                  <form
                    action="/api/auth/logout"
                    method="post"
                    className="flex-1"
                  >
                    <button
                      type="submit"
                      className="btn-secondary w-full text-sm"
                    >
                      Sign out
                    </button>
                  </form>
                </>
              )}
              {installAction && (
                <Link
                  href="/install"
                  onClick={() => setOpen(false)}
                  className={`${
                    installAction.variant === "primary" ? "btn-primary" : "btn-secondary"
                  } flex-1 text-center text-sm`}
                >
                  {installAction.label}
                </Link>
              )}
            </div>
          </nav>
        </div>
      )}
    </div>
  );
}
