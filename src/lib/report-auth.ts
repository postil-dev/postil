import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

export async function requireReportSession(nextPath: string) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  return session;
}
