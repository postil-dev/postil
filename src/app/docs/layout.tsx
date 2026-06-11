import { DocsNav } from "@/components/docs-nav";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-6xl gap-12 px-6 py-14">
      <aside className="hidden w-56 shrink-0 lg:block">
        <p className="eyebrow">Documentation</p>
        <DocsNav />
      </aside>
      <article className="min-w-0 flex-1">{children}</article>
    </div>
  );
}
