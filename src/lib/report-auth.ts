import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { assertAuthSecretConfigured, auth } from "@/auth";

export async function requireReportSession(nextPath: string) {
  assertAuthSecretConfigured();
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  return session;
}
