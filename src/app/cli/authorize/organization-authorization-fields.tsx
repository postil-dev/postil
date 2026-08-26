export function OrganizationAuthorizationFields({
  organizations,
}: {
  organizations: Array<{ slug: string; name: string }>;
}) {
  if (organizations.length === 1) {
    const organization = organizations[0]!;
    return (
      <div className="rounded-card border border-stone bg-white/40 px-4 py-3 text-sm">
        <input type="hidden" name="orgSlug" value={organization.slug} />
        <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">
          Review budget
        </p>
        <p className="mt-1 font-medium text-ink">{organization.name}</p>
      </div>
    );
  }

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Use review budget from</legend>
      <div className="grid gap-2">
        {organizations.map((organization, index) => (
          <label
            key={organization.slug}
            className="group flex min-h-12 cursor-pointer items-center gap-3 rounded-card border border-stone bg-white/40 px-4 py-3 text-sm transition-colors hover:border-ink-soft focus-within:ring-2 focus-within:ring-rust/30 has-[:checked]:border-rust has-[:checked]:bg-softred/10"
          >
            <input
              type="radio"
              name="orgSlug"
              value={organization.slug}
              defaultChecked={index === 0}
              required
              className="h-4 w-4 shrink-0 accent-rust"
            />
            <span className="min-w-0">
              <span className="block truncate font-medium text-ink">
                {organization.name}
              </span>
              <span className="block truncate font-mono text-xs text-ink-soft">
                {organization.slug}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
