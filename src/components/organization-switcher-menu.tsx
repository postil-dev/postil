"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

interface OrganizationOption {
  slug: string;
  name: string;
}

export function nextOrganizationFocusIndex(
  current: number,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
  count: number,
): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return (current + 1 + count) % count;
  return (current - 1 + count) % count;
}

export function OrganizationSwitcherMenu({
  currentSlug,
  organizations,
}: {
  currentSlug: string;
  organizations: OrganizationOption[];
}) {
  const [open, setOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const menuId = useId();
  const matchingIndex = organizations.findIndex(
    (organization) => organization.slug === currentSlug,
  );
  const currentIndex = Math.max(0, matchingIndex);
  const current = matchingIndex >= 0 ? organizations[matchingIndex] : undefined;
  const itemCount = organizations.length + 1;

  useEffect(() => {
    if (!open || focusOnOpen === null) return;
    itemRefs.current[focusOnOpen]?.focus();
    setFocusOnOpen(null);
  }, [focusOnOpen, open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  function openAndFocus(index: number) {
    setFocusOnOpen(index);
    setOpen(true);
  }

  function closeAndRestoreFocus() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function handleButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openAndFocus(event.key === "ArrowDown" ? currentIndex : itemCount - 1);
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const activeIndex = itemRefs.current.findIndex(
      (item) => item === document.activeElement,
    );
    const nextIndex = nextOrganizationFocusIndex(
      activeIndex < 0 ? currentIndex : activeIndex,
      event.key as "ArrowDown" | "ArrowUp" | "Home" | "End",
      itemCount,
    );
    itemRefs.current[nextIndex]?.focus();
  }

  return (
    <div ref={rootRef} className="relative z-30">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Switch GitHub account. Current account: ${current?.name ?? currentSlug}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleButtonKeyDown}
        className="btn-secondary min-h-11 cursor-pointer whitespace-nowrap text-xs"
      >
        {current?.name ?? "Switch account"}
        <svg
          aria-hidden="true"
          className={`ml-2 inline h-3 w-3 transition-transform motion-reduce:transition-none ${
            open ? "rotate-180" : ""
          }`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m2.5 4 3.5 3.5L9.5 4" />
        </svg>
      </button>
      <div
        id={menuId}
        role="menu"
        aria-label="GitHub accounts"
        hidden={!open}
        onKeyDown={handleMenuKeyDown}
        className="absolute right-0 z-50 mt-2 w-[min(18rem,calc(100vw-3rem))] overflow-hidden rounded-card border border-stone bg-paper p-2 text-charcoal shadow-lg"
      >
        <div className="max-h-72 overflow-y-auto overscroll-contain">
          {organizations.map((organization, index) => (
            <Link
              key={organization.slug}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              role="menuitem"
              href={`/orgs/${encodeURIComponent(organization.slug)}`}
              aria-current={organization.slug === currentSlug ? "page" : undefined}
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center justify-between gap-4 rounded px-3 py-2 text-sm text-charcoal hover:bg-stone/65 aria-[current=page]:font-medium aria-[current=page]:text-rust"
            >
              <span className="truncate">{organization.name}</span>
              {organization.slug === currentSlug && (
                <svg
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-gate"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m3.5 8.5 3 3 6-7" />
                </svg>
              )}
            </Link>
          ))}
        </div>
        <Link
          ref={(node) => {
            itemRefs.current[organizations.length] = node;
          }}
          role="menuitem"
          href="/reports"
          onClick={() => setOpen(false)}
          className="mt-1 flex min-h-11 items-center border-t border-stone px-3 py-2 text-xs font-medium text-ink-soft hover:text-rust"
        >
          All accounts
        </Link>
      </div>
    </div>
  );
}
