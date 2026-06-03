import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter, Source_Serif_4 } from "next/font/google";
import { PostHogProvider } from "@/components/providers/posthog-provider";
import { ReactGrabDev } from "@/components/react-grab-dev";
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
    "Postil is a low-noise review gate for agent-speed development. It catches merge-relevant bugs, security issues, and intent mismatches without review theater.",
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
        <PostHogProvider>
          {children}
          <ReactGrabDev />
        </PostHogProvider>
      </body>
    </html>
  );
}
