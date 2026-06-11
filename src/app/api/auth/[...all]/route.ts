import { toNextJsHandler } from "better-auth/next-js";
import { assertAuthSecretConfigured, getAuth } from "@/auth";

type AuthRouteContext = {
  params: Promise<{ all: string[] }>;
};

type AuthHandler = {
  GET: (request: Request, context: AuthRouteContext) => Response | Promise<Response>;
  POST: (request: Request, context: AuthRouteContext) => Response | Promise<Response>;
};

function getHandler(): AuthHandler {
  return toNextJsHandler(getAuth().handler) as AuthHandler;
}

export async function GET(request: Request, context: AuthRouteContext) {
  assertAuthSecretConfigured();
  return getHandler().GET(request, context);
}

export async function POST(request: Request, context: AuthRouteContext) {
  assertAuthSecretConfigured();
  return getHandler().POST(request, context);
}
