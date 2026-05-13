import Link from "next/link";

export const metadata = {
  title: "Sign in",
  description: "Sign in to Postil with GitHub.",
};

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-3xl font-semibold">Sign in</h1>
      <p className="text-muted-foreground">
        Postil uses GitHub OAuth as its only sign-in path. We never ask for a
        password directly.
      </p>
      <Link
        href="/install"
        className="inline-flex items-center justify-center rounded-lg border border-transparent bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/80"
      >
        Continue with GitHub
      </Link>
      <Link href="/" className="text-sm underline">
        Return home
      </Link>
    </main>
  );
}
