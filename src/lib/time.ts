const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatRelativeTime(value: string, now: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "n/a";

  const elapsed = now - timestamp;
  const future = elapsed < 0;
  const absoluteElapsed = Math.abs(elapsed);

  if (absoluteElapsed < MINUTE_MS) return "just now";

  const [amount, suffix] =
    absoluteElapsed < HOUR_MS
      ? [Math.floor(absoluteElapsed / MINUTE_MS), "m"]
      : absoluteElapsed < DAY_MS
        ? [Math.floor(absoluteElapsed / HOUR_MS), "h"]
        : [Math.floor(absoluteElapsed / DAY_MS), "d"];

  return future ? `in ${amount}${suffix}` : `${amount}${suffix} ago`;
}

export function formatAbsoluteTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return "n/a";
  return timestamp.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}
