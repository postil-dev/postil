import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold">404</h1>
      <p className="text-muted-foreground">That page does not exist.</p>
      <Link href="/" className="underline">
        Return home
      </Link>
    </main>
  );
}
