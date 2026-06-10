import Image from "next/image";

type Variant = "pass" | "info" | "warn" | "error";

const labelFor: Record<Variant, string> = {
  pass: "no findings",
  info: "info",
  warn: "warn",
  error: "error",
};

export function StatusLine({
  variant,
  children,
}: {
  variant: Variant;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-2 font-mono text-sm">
      <Image src={`/status/${variant}.svg`} alt="" width={18} height={18} />
      <span className="uppercase tracking-wide text-xs text-[color:var(--color-charcoal-soft)] w-20">
        {labelFor[variant]}
      </span>
      <span>{children}</span>
    </div>
  );
}
