interface TerminalProps {
  title?: string;
  children: React.ReactNode;
  className?: string;
}

/** Charcoal terminal block with a title bar, IBM Plex Mono body. */
export function Terminal({ title = "postil", children, className }: TerminalProps) {
  return (
    <div className={`terminal max-w-full ${className ?? ""}`}>
      <div className="flex items-center gap-2 border-b border-[#2c363d] px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#3d464d]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#3d464d]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#3d464d]" />
        <span className="t-dim ml-2 text-xs">{title}</span>
      </div>
      <pre className="overflow-x-auto px-4 py-4">{children}</pre>
    </div>
  );
}
