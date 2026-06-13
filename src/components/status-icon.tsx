import Image from "next/image";

export type StatusKind = "pass" | "warn" | "error" | "info";

/**
 * Status iconography from public/status/*.svg (brand set).
 *
 * Decorative by default (`alt=""`): every current call site pairs the icon with
 * a visible text label, so a non-empty alt would make a screen reader announce
 * the status twice. Pass an explicit `alt` only where the icon is the sole
 * carrier of meaning.
 */
export function StatusIcon({
  kind,
  size = 18,
  className,
  alt = "",
}: {
  kind: StatusKind;
  size?: number;
  className?: string;
  alt?: string;
}) {
  return (
    <Image
      src={`/status/${kind}.svg`}
      alt={alt}
      width={size}
      height={size}
      className={className}
    />
  );
}
