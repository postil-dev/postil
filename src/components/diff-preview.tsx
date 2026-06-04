type DiffLine = {
  id: string;
  kind: "add" | "remove" | "context";
  text: string;
};

export function DiffPreview({
  removed,
  added,
}: {
  removed: string;
  added: string;
}) {
  const lines: DiffLine[] = [];
  let sequence = 0;
  for (const text of removed.split("\n")) {
    lines.push({ id: `remove-${sequence}-${text}`, kind: "remove", text });
    sequence += 1;
  }
  for (const text of added.split("\n")) {
    lines.push({ id: `add-${sequence}-${text}`, kind: "add", text });
    sequence += 1;
  }

  return (
    <pre className="max-w-full overflow-x-auto bg-[#1b2329] p-4 font-mono text-xs leading-6 text-[#f7f5f1]">
      <code className="block min-w-full w-max">
        {lines.map((line) => (
          <span
            key={line.id}
            className={[
              "block min-w-full px-3",
              line.kind === "remove" ? "bg-[rgba(212,106,106,0.35)]" : "",
              line.kind === "add" ? "bg-[rgba(100,116,92,0.35)]" : "",
            ].join(" ")}
          >
            {line.kind === "remove" ? "- " : "+ "}
            {line.text || " "}
          </span>
        ))}
      </code>
    </pre>
  );
}
