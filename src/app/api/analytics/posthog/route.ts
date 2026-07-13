import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (
    process.env.POSTHOG_CLIENT_CAPTURE === "0" ||
    request.headers.get("sec-gpc") === "1" ||
    request.headers.get("dnt") === "1"
  ) {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? process.env.POSTHOG_PROJECT_TOKEN;
  if (!key) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  return NextResponse.json(
    {
      key,
      apiHost: "/relay",
      uiHost: posthogUiHost(process.env.NEXT_PUBLIC_POSTHOG_HOST),
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

function posthogUiHost(ingestionHost: string | undefined): string {
  const host = ingestionHost ?? "https://eu.i.posthog.com";
  if (host.includes("eu.i.posthog.com")) return "https://eu.posthog.com";
  if (host.includes("us.i.posthog.com")) return "https://us.posthog.com";
  return host.replace(/\/+$/, "");
}
