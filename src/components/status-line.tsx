import { StatusMark, type StatusKind } from "@/components/status-mark";

export type { StatusKind };

export function StatusLine({
  label,
  marks,
  className,
}: {
  label?: string;
  marks: StatusKind[];
  className?: string;
}) {
  const seen: Partial<Record<StatusKind, number>> = {};

  return (
    <div className={["flex items-center gap-1 font-mono", className].filter(Boolean).join(" ")}>
      {label ? <span className="mr-1">{label}</span> : null}
      {marks.map((mark) => {
        seen[mark] = (seen[mark] ?? 0) + 1;
        return <StatusMark key={`${mark}-${seen[mark]}`} kind={mark} />;
      })}
    </div>
  );
}
