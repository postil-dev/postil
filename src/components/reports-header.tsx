export function ReportsHeader({
  login,
  addAccountUrl,
}: {
  login: string;
  addAccountUrl?: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="eyebrow">Reports</p>
        <h1 className="serif-display mt-2 text-3xl">Recent reviews, {login}</h1>
      </div>
      {addAccountUrl && (
        <a href={addAccountUrl} className="btn-secondary text-sm">
          Add GitHub account
        </a>
      )}
    </div>
  );
}
