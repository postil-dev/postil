import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const configuredBootProbe = process.env.POSTIL_BOOT_PROBE;
  const bootProbe =
    configuredBootProbe &&
    process.env.POSTIL_BOOT_PROBE_READY === configuredBootProbe
      ? configuredBootProbe
      : undefined;
  return NextResponse.json(
    { ok: true, service: "web" },
    bootProbe ? { headers: { "x-postil-boot-probe": bootProbe } } : undefined,
  );
}
