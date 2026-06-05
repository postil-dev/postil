import { toNextJsHandler } from "better-auth/next-js";
import { assertAuthSecretConfigured, auth } from "@/auth";

assertAuthSecretConfigured();

export const { GET, POST } = toNextJsHandler(auth.handler);
