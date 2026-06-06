export function safeReportsCallbackPath(next: string | undefined): string {
  if (!next?.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return "/reports";
  }

  try {
    const url = new URL(next, "https://postil.local");
    if (url.origin !== "https://postil.local") return "/reports";
    if (url.pathname !== "/reports" && !url.pathname.startsWith("/reports/")) return "/reports";
    if (/%2f|%5c/i.test(url.pathname)) return "/reports";

    return `${url.pathname}${url.search}`;
  } catch {
    return "/reports";
  }
}
