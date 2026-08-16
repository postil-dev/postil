import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";

import { safeReturnTarget } from "@/lib/oauth";
import { getSessionUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Postil with GitHub.",
  alternates: { canonical: "/login" },
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  oauth_state: "The sign-in attempt expired or was tampered with. Try again.",
  token_exchange: "GitHub did not accept the sign-in. Try again.",
  profile: "Could not load your GitHub profile. Try again.",
  organization_memberships: "GitHub did not return your organizations. Try signing in again.",
  membership_verification:
    "GitHub could not verify your organization access. Try again in a moment.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    next?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const returnTo =
    typeof params.next === "string" ? safeReturnTarget(params.next) : undefined;
  if (await getSessionUser()) redirect(returnTo ?? "/reports");

  const error = typeof params.error === "string"
    ? (ERROR_MESSAGES[params.error] ?? "Sign-in failed. Try again.")
    : null;
  const loginHref = returnTo
    ? `/api/auth/login?next=${encodeURIComponent(returnTo)}`
    : "/api/auth/login";

  return (
    <div className="mx-auto flex max-w-6xl justify-center px-6 py-24">
      <div className="card w-full max-w-md p-10 text-center">
        <Image
          src="/brand/postil-mark.svg"
          alt=""
          width={40}
          height={54}
          className="mx-auto"
        />
        <h1 className="serif-display mt-6 text-3xl">Sign in to Postil</h1>
        <p className="mt-3 text-sm text-ink-soft">
          Your dashboard: silence rate, confidence distribution, and every
          review across your organizations.
        </p>
        {error && (
          <p className="mt-4 rounded-card border border-softred bg-softred/10 px-4 py-2 text-sm text-rust">
            {error}
          </p>
        )}
        <a href={loginHref} className="btn-primary mt-8 block w-full">
          Continue with GitHub
        </a>
        <p className="mt-4 font-mono text-xs text-charcoal/50">
          OAuth scopes: read:user, user:email, read:org
        </p>
      </div>
    </div>
  );
}
