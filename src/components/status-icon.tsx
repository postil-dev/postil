import Image from "next/image";

export type StatusKind = "pass" | "warn" | "error" | "info";

const ALT: Record<StatusKind, string> = {
  pass: "pass",
  warn: "warning",
  error: "error",
  info: "info",
};

/** Status iconography from public/status/*.svg (brand set). */
export function StatusIcon({
  kind,
  size = 18,
  className,
}: {
  kind: StatusKind;
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src={`/status/${kind}.svg`}
      alt={ALT[kind]}
      width={size}
      height={size}
      className={className}
    />
  );
}
