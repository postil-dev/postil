import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (
    process.env.POSTHOG_CLIENT_CAPTURE !== "1" ||
    request.headers.get("sec-gpc") === "1" ||
    request.headers.get("dnt") === "1"
  ) {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? process.env.POSTHOG_PROJECT_TOKEN;
  if (!key) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  const apiHost = posthogIngestionHost(process.env.NEXT_PUBLIC_POSTHOG_HOST);
  if (!apiHost) {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json(
    {
      key,
      apiHost,
      uiHost: posthogUiHost(apiHost),
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

function posthogIngestionHost(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? "https://eu.i.posthog.com");
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(process.env.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)))
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function posthogUiHost(host: string): string {
  if (host.includes("eu.i.posthog.com")) return "https://eu.posthog.com";
  if (host.includes("us.i.posthog.com")) return "https://us.posthog.com";
  return host.replace(/\/+$/, "");
}
