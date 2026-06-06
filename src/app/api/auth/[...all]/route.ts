import { toNextJsHandler } from "better-auth/next-js";
import { assertAuthSecretConfigured, auth } from "@/auth";

type AuthRouteContext = {
  params: Promise<{ all: string[] }>;
};

const handler = toNextJsHandler(auth.handler) as {
  GET: (request: Request, context: AuthRouteContext) => Response | Promise<Response>;
  POST: (request: Request, context: AuthRouteContext) => Response | Promise<Response>;
};

export async function GET(request: Request, context: AuthRouteContext) {
  assertAuthSecretConfigured();
  return handler.GET(request, context);
}

export async function POST(request: Request, context: AuthRouteContext) {
  assertAuthSecretConfigured();
  return handler.POST(request, context);
}
