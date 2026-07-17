import {
  MODEL_CATALOG_CAPTURE_DATE,
  MODELS,
  type CatalogModel,
} from "@/data/models";

type ModelPrice = CatalogModel["pricePerToken"];

function dollarsPerMillion(pricePerToken: number): string {
  return (pricePerToken * 1_000_000).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });
}

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const digits = tokens % 1_000_000 === 0 ? 0 : 1;
    return (tokens / 1_000_000).toFixed(digits) + "M ctx";
  }
  if (tokens >= 1_000) return Math.round(tokens / 1000) + "K ctx";
  return tokens + " ctx";
}

function Badge({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "accent" | "muted";
}) {
  const toneClass =
    tone === "accent"
      ? "border-gate text-gate"
      : tone === "muted"
        ? "border-stone text-charcoal/60"
        : "border-stone text-charcoal/80";
  return (
    <span
      className={"inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] whitespace-nowrap " + toneClass}
    >
      {children}
    </span>
  );
}

function ModelBadges({ model }: { model: CatalogModel }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      <Badge>{contextLabel(model.contextLength)}</Badge>
      {model.vision && <Badge tone="accent">vision</Badge>}
      <Badge tone={model.openWeights ? "accent" : "muted"}>
        {model.openWeights ? "open-weights" : "proprietary"}
      </Badge>
      {model.paramClass !== "unknown" && (
        <Badge tone={model.locallyRunnable ? "accent" : "default"}>
          {model.paramClass}
          {model.locallyRunnable ? " · locally runnable" : ""}
        </Badge>
      )}
      <Badge tone={model.tested ? "accent" : "muted"}>
        {model.tested ? "bench-tested" : "untested"}
      </Badge>
    </div>
  );
}

function PriceCell({ price }: { price: ModelPrice }) {
  return (
    <span className="font-mono text-[13px]">
      {dollarsPerMillion(price.input)} in / {dollarsPerMillion(price.output)} out
    </span>
  );
}

export function ModelCatalog() {
  const captureDate = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${MODEL_CATALOG_CAPTURE_DATE}T00:00:00Z`));

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
              Model
            </th>
            <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
              Capabilities
            </th>
            <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
              Price / 1M tokens
            </th>
          </tr>
        </thead>
        <tbody>
          {MODELS.map((model) => (
            <tr key={model.id}>
              <td className="border-b border-stone py-3 pr-3 align-top">
                <a
                  href={"https://openrouter.ai/" + model.id}
                  rel="noopener noreferrer"
                  className="font-medium text-rust underline underline-offset-2"
                >
                  {model.name}
                </a>
                <br />
                <code className="text-xs text-charcoal/70">{model.id}</code>
              </td>
              <td className="border-b border-stone py-3 pr-3 align-top">
                <ModelBadges model={model} />
              </td>
              <td className="border-b border-stone py-3 pr-3 align-top">
                <PriceCell price={model.pricePerToken} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-charcoal/60">
        Price values are a committed public snapshot from the{" "}
        <a href="https://openrouter.ai/models" rel="noopener noreferrer" className="text-rust underline">
          OpenRouter catalog
        </a>
        , captured {captureDate}. Re-check provider pricing before committing to
        a procurement number. Capability badges are maintained in this repo.
      </p>
    </div>
  );
}
