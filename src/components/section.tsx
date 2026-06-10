interface SectionProps {
  number?: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  className?: string;
}

/** Editorial numbered section: mono eyebrow, serif title, hairline rule. */
export function Section({ number, eyebrow, title, children, className }: SectionProps) {
  return (
    <section className={`mx-auto max-w-6xl px-6 py-16 md:py-20 ${className ?? ""}`}>
      <div className="rule pt-8">
        <p className="eyebrow">
          {number ? `${number} — ` : ""}
          {eyebrow}
        </p>
        <h2 className="serif-display mt-3 max-w-3xl text-3xl md:text-4xl">{title}</h2>
        <div className="mt-8">{children}</div>
      </div>
    </section>
  );
}
