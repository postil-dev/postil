import { NextResponse } from "next/server";

export async function GET() {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? process.env.POSTHOG_PROJECT_TOKEN;
  if (!key) return new Response(null, { status: 204 });
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
