import type { Metadata } from "next";
import { DM_Sans, DM_Serif_Display, JetBrains_Mono } from "next/font/google";
import { PostHogProvider } from "@/components/providers/posthog-provider";
import "./globals.css";

const body = DM_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600"],
});

const display = DM_Serif_Display({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400"],
});

const mono = JetBrains_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://postil.dev"),
  title: {
    default: "Postil — AI pull request reviews",
    template: "%s · Postil",
  },
  description:
    "Postil reads every pull request, flags the things that matter, stays out of the way on the rest. Managed at postil.dev, or self-host under Apache-2.0.",
  applicationName: "Postil",
  openGraph: {
    type: "website",
    siteName: "Postil",
    title: "Postil — AI pull request reviews",
    description:
      "Reviews that ship with the PR. Managed SaaS or self-host under Apache-2.0.",
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
