"use client";

export function OptOutButton() {
  return (
    <button
      type="button"
      className="rounded-md border border-border bg-background px-4 py-2 text-sm hover:bg-muted"
      onClick={() => {
        const ph = (window as unknown as { posthog?: { opt_out_capturing: () => void } }).posthog;
        if (ph) {
          ph.opt_out_capturing();
          alert("You have opted out of PostHog analytics on postil.dev.");
        } else {
          alert("Analytics not loaded yet. Please try again in a moment.");
        }
      }}
    >
      Opt out of analytics
    </button>
  );
}
