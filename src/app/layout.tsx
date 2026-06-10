import type { Metadata } from "next";
import { Inter, Source_Serif_4, IBM_Plex_Mono } from "next/font/google";

import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const serif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono-ibm",
  display: "swap",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://postil.dev"),
  title: {
    default: "Postil — Trust the merge, not the speed.",
    template: "%s · Postil",
  },
  description:
    "Postil is a low-noise pull-request review gate for agent-speed development. Comment only when the comment can affect merge. Silence is a feature.",
  openGraph: {
    title: "Postil — Trust the merge, not the speed.",
    description:
      "A low-noise PR review gate. Stays silent on clean PRs. Names the risk when it matters.",
    type: "website",
    url: "https://postil.dev",
    images: [{ url: "/brand/postil-mark.svg", width: 1200, height: 630, alt: "Postil" }],
  },
  twitter: { card: "summary_large_image", title: "Postil" },
  icons: { icon: "/brand/postil-mark.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${serif.variable} ${mono.variable}`}>
      <body className="min-h-screen flex flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
