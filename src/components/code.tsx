export function Code({ children }: { children: string }) {
  return (
    <pre className="panel-quiet p-4 text-sm font-mono leading-relaxed overflow-x-auto">
      <code>{children}</code>
    </pre>
  );
}
