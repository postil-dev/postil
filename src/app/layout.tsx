import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter, Source_Serif_4 } from "next/font/google";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import "./globals.css";

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-source-serif",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://postil.dev"),
  title: {
    default: "Postil — Trust the merge, not the speed.",
    template: "%s — Postil",
  },
  description:
    "Postil is a low-noise pull-request review gate. We say less. What we say is right.",
  openGraph: {
    type: "website",
    title: "Postil — Trust the merge, not the speed.",
    description:
      "A low-noise review gate for teams shipping at agent speed. Silent on clean PRs, hard gate on what matters.",
    url: "https://postil.dev",
    siteName: "Postil",
    locale: "en_US",
    images: ["/opengraph-image"],
  },
  // Only the card type: title, description, and image are derived per page
  // from its own metadata instead of inheriting the homepage's verbatim.
  twitter: {
    card: "summary_large_image",
  },
};

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Postil",
  url: "https://postil.dev",
  logo: "https://postil.dev/brand/postil-mark.svg",
  sameAs: [
    "https://github.com/postil-dev/postil",
    "https://github.com/postil-dev/postil-cli",
  ],
};

const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Postil",
  url: "https://postil.dev",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Linux, macOS, Windows",
  description:
    "Postil is a low-noise pull-request review gate. It reviews every pull request, comments only when it can affect the merge, and stays silent on clean PRs.",
  offers: [
    {
      "@type": "Offer",
      name: "Public repositories",
      price: "0",
      priceCurrency: "USD",
    },
    {
      "@type": "Offer",
      name: "Team",
      price: "10",
      priceCurrency: "USD",
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${sourceSerif.variable} ${inter.variable} ${plexMono.variable}`}
    >
      <body className="flex min-h-screen flex-col">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(organizationJsonLd),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(softwareApplicationJsonLd),
          }}
        />
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main-content" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
