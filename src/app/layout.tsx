import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter, Source_Serif_4 } from "next/font/google";
import { PostHogProvider } from "@/components/providers/posthog-provider";
import "./globals.css";

const body = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600"],
});

const display = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400", "600", "700"],
});

const mono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://postil.dev"),
  alternates: {
    canonical: "/",
  },
  title: {
    default: "Postil — AI pull request reviews",
    template: "%s · Postil",
  },
  description:
    "Postil reviews pull requests for bugs that need code context: auth checks, unsafe deletes, migrations, race windows, and clean PRs that need no bot recap.",
  applicationName: "Postil",
  openGraph: {
    type: "website",
    siteName: "Postil",
    title: "Postil — AI pull request reviews",
    description:
      "A calm review gate for agent-speed development. Managed beta or self-host under Apache-2.0.",
    url: "https://postil.dev",
  },
  twitter: {
    card: "summary",
    title: "Postil",
    description: "AI pull request reviews that ship with the PR.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable} ${mono.variable}`}>
      <body>
        <PostHogProvider>{children}</PostHogProvider>
      </body>
    </html>
  );
}
