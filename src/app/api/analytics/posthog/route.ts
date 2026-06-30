import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? process.env.POSTHOG_PROJECT_TOKEN;
  if (!key) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  return NextResponse.json(
    {
      key,
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com",
    },
    {
      headers: {
        "cache-control": "public, max-age=300",
      },
    },
  );
}
