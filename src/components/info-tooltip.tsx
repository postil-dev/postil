import type { ReactNode } from "react";

interface InfoTooltipProps {
  children: ReactNode;
  id: string;
  label: string;
}

export function InfoTooltip({ children, id, label }: InfoTooltipProps) {
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-describedby={id}
        aria-label={label}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-charcoal/35 font-mono text-[11px] leading-none text-charcoal/65 hover:border-charcoal/60 hover:text-charcoal"
      >
        i
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-20 mb-2 w-64 -translate-x-1/2 rounded-card bg-charcoal px-3 py-2 text-left text-xs font-normal leading-relaxed text-ivory opacity-0 shadow-card transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {children}
      </span>
    </span>
  );
}
