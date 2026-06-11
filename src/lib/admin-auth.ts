import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";

export interface AdminViewer {
  email: string;
  name: string | null;
}

export function configuredAdminEmails(value = env.POSTIL_ADMIN_EMAILS): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function adminViewerFromSession(
  session: unknown,
  adminEmails = configuredAdminEmails(),
): AdminViewer | null {
  if (!session || typeof session !== "object") return null;
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") return null;

  const email = (user as { email?: unknown }).email;
  if (typeof email !== "string" || !email.trim()) return null;

  const normalizedEmail = email.trim().toLowerCase();
  if (!adminEmails.has(normalizedEmail)) return null;

  const name = (user as { name?: unknown }).name;
  return {
    email: normalizedEmail,
    name: typeof name === "string" && name.trim() ? name.trim() : null,
  };
}

export async function requireAdminSession(nextPath: string): Promise<AdminViewer> {
  const { assertAuthSecretConfigured, auth } = await import("@/auth");
  assertAuthSecretConfigured();
  const requestHeaders = await headers();
  const session = await auth.api.getSession({
    headers: requestHeaders,
  });

  if (!session) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  const viewer = adminViewerFromSession(session);
  if (!viewer) {
    redirect("/reports");
  }

  return viewer;
}
