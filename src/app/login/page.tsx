import Link from "next/link";
import type { Metadata } from "next";
import { SignInButton } from "./sign-in-button";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Postil with GitHub.",
  alternates: { canonical: "/login" },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const callbackUrl = next?.startsWith("/") ? next : "/reports";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-3xl font-semibold">Sign in</h1>
      <p className="text-muted-foreground">
        Postil uses GitHub OAuth as its only sign-in path. We never ask for a password directly.
      </p>
      <SignInButton callbackUrl={callbackUrl} />
      <Link href="/" className="text-sm underline">
        Return home
      </Link>
    </main>
  );
}
