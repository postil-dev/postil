import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Thin entry point: bounce the user to GitHub's App install page.
// If the App slug isn't configured, fall back to a human-readable landing.
export default function InstallPage() {
  const slug = env.GITHUB_APP_SLUG;
  if (slug) redirect(`https://github.com/apps/${slug}/installations/new`);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-3xl font-semibold">Add the GitHub App</h1>
      <p className="text-muted-foreground">
        The GitHub App isn&apos;t configured yet. Check back shortly.
      </p>
      <a className="underline" href="/">
        Return home
      </a>
    </main>
  );
}
