import type { Metadata } from "next";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Postil with GitHub.",
};

const ERROR_MESSAGES: Record<string, string> = {
  oauth_state: "The sign-in attempt expired or was tampered with. Try again.",
  token_exchange: "GitHub did not accept the sign-in. Try again.",
  profile: "Could not load your GitHub profile. Try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const error = params.error ? (ERROR_MESSAGES[params.error] ?? "Sign-in failed. Try again.") : null;

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
        <a href="/api/auth/login" className="btn-primary mt-8 block w-full">
          Continue with GitHub
        </a>
        <p className="mt-4 font-mono text-xs text-charcoal/50">
          OAuth scopes: read:user, user:email, read:org
        </p>
      </div>
    </div>
  );
}
