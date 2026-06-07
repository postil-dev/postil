export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({
    ok: true,
    service: "postil",
    commit: process.env.POSTIL_COMMIT_SHA ?? "unknown",
    buildTime: process.env.POSTIL_BUILD_TIME ?? "unknown",
  });
}
