import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://postil.dev"),
  title: {
    default: "Postil — AI pull request reviews",
    template: "%s · Postil",
  },
  description:
    "Postil is an open-source AI pull request reviewer. Managed SaaS at postil.dev or self-host under Apache-2.0.",
  applicationName: "Postil",
  authors: [{ name: "Postil", url: "https://postil.dev" }],
  openGraph: {
    type: "website",
    siteName: "Postil",
    title: "Postil — AI pull request reviews",
    description:
      "Open-source AI PR reviewer. Managed SaaS at postil.dev or self-host under Apache-2.0.",
    url: "https://postil.dev",
  },
  twitter: {
    card: "summary",
    title: "Postil",
    description: "Open-source AI PR reviewer.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
