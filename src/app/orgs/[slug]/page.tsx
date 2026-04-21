import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function OrgPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // TODO(postil): replace with real org lookup from Drizzle once auth + session wiring is in.
  if (!slug) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 p-8 sm:p-16">
      <header className="flex flex-col gap-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">Organization</span>
        <h1 className="text-3xl font-semibold">{slug}</h1>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Installation</CardTitle>
            <CardDescription>GitHub App status</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">Not installed yet.</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Reviews</CardTitle>
            <CardDescription>Last 30 days</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">0</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Plan</CardTitle>
            <CardDescription>via Polar</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">Free</CardContent>
        </Card>
      </section>
    </main>
  );
}
