import type { NextRequest } from "next/server";

import { env } from "./env";

/** Compare a request's `Authorization: Bearer <X>` to a server-side secret. */
export function requireBearer(req: NextRequest, secretEnvKey: "METRICS_API_KEY" | "WORKER_TOKEN") {
  const expected = env()[secretEnvKey];
  if (!expected) {
    return new Response(`${secretEnvKey} not configured`, { status: 503 });
  }
  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (provided.length === 0 || !timingSafeEqual(provided, expected)) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
