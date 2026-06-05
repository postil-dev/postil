import { toNextJsHandler } from "better-auth/next-js";
import { assertAuthSecretConfigured, auth } from "@/auth";

const handler = toNextJsHandler(auth.handler);

export async function GET(request: Request) {
  assertAuthSecretConfigured();
  return handler.GET(request);
}

export async function POST(request: Request) {
  assertAuthSecretConfigured();
  return handler.POST(request);
}
