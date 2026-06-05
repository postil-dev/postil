export function safeReportsCallbackPath(next: string | undefined): string {
  if (!next?.startsWith("/") || next.startsWith("//")) return "/reports";

  const url = new URL(next, "https://postil.local");
  if (url.origin !== "https://postil.local") return "/reports";
  if (url.pathname !== "/reports" && !url.pathname.startsWith("/reports/")) return "/reports";

  return `${url.pathname}${url.search}`;
}
