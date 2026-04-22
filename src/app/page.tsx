import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 p-8 sm:p-16">
      <header className="flex flex-col gap-3">
        <span className="inline-flex w-fit rounded-full border px-3 py-1 text-xs uppercase tracking-wider text-muted-foreground">
          Postil · bootstrap
        </span>
        <h1 className="text-4xl font-semibold tracking-tight">AI pull request reviews that ship with the PR.</h1>
        <p className="text-muted-foreground">
          Open-source, self-hostable reviewer. Managed service at postil.dev.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Install the GitHub App</CardTitle>
            <CardDescription>Get reviews on your next PR in under a minute.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/api/auth/sign-in" className={buttonVariants()}>
              Continue with GitHub
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Self-host</CardTitle>
            <CardDescription>
              Apache-2.0 license; pluggable sandbox drivers. Fly, E2B, or Docker.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="https://github.com/postil-dev/postil"
              className={buttonVariants({ variant: "outline" })}
            >
              GitHub
            </Link>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
