import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter, Source_Serif_4 } from "next/font/google";
import { Suspense } from "react";

import { CodeCopyEnhancer } from "@/components/code-copy-enhancer";
import { PostHogPageview } from "@/components/posthog-pageview";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import {
  BYOK_ACTIVE_AUTHOR_MONTHLY_USD,
  HOSTED_ACTIVE_AUTHOR_MONTHLY_USD,
} from "@/lib/pricing-policy";

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
    default: "Postil: AI review that can block a merge.",
    template: "%s | Postil",
  },
  description:
    "Postil is a low-noise pull-request review gate: silent on clean PRs, a hard CI gate on findings that matter.",
  openGraph: {
    type: "website",
    title: "Postil: AI review that can block a merge.",
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
  operatingSystem: "Linux, macOS",
  description:
    "Postil is a low-noise pull-request review gate. It reviews every non-draft pull request in enabled repositories, comments only when it can affect the merge, and stays silent on clean PRs.",
  offers: [
    {
      "@type": "Offer",
      name: "Public repositories",
      price: "0",
      priceCurrency: "USD",
    },
    {
      "@type": "Offer",
      name: "BYOK",
      price: String(BYOK_ACTIVE_AUTHOR_MONTHLY_USD),
      priceCurrency: "USD",
      description:
        "Per active private-PR author per month; provider usage billed directly",
    },
    {
      "@type": "Offer",
      name: "Hosted",
      price: String(HOSTED_ACTIVE_AUTHOR_MONTHLY_USD),
      priceCurrency: "USD",
      description:
        "Thirty-day trial without a card, then per active private-PR author per month",
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
        <main id="main-content" tabIndex={-1} className="flex-1">
          {children}
        </main>
        <Suspense fallback={null}>
          <PostHogPageview />
        </Suspense>
        <CodeCopyEnhancer />
        <SiteFooter />
      </body>
    </html>
  );
}
