import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "postil",
    version: process.env.POSTIL_CLI_REV ?? "dev",
    time: new Date().toISOString(),
  });
}
