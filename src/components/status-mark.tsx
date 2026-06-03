import Image from "next/image";

export type StatusKind = "error" | "warn" | "info" | "pass";

const statusLabel: Record<StatusKind, string> = {
  error: "Error status",
  warn: "Warning status",
  info: "Info status",
  pass: "Passing status",
};

export function StatusMark({ kind, size = 18 }: { kind: StatusKind; size?: number }) {
  return (
    <Image
      src={`/status/${kind}.svg`}
      alt={statusLabel[kind]}
      width={size}
      height={size}
      className="inline-block align-[-3px]"
    />
  );
}
