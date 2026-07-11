import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Contact Postil for help with the product, installation, billing, or your account.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: "Contact Postil",
    description:
      "Reach the person who builds and operates Postil. We reply within 1–2 business days.",
    url: "https://postil.dev/contact",
    images: ["/opengraph-image"],
  },
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
      <p className="eyebrow">Contact</p>
      <h1 className="serif-display mt-4 max-w-3xl text-4xl md:text-5xl">
        Talk to a real person.
      </h1>
      <div className="mt-6 max-w-2xl space-y-4 text-lg text-ink-soft">
        <p>
          Questions about Postil, installation, billing, or your account? Email{" "}
          <a
            href="mailto:hello@postil.dev"
            className="text-rust underline"
          >
            hello@postil.dev
          </a>
          . The person who builds and operates Postil reads every message.
        </p>
        <p>
          We reply within 1–2 business days. The inbox is monitored on business
          days, not staffed in real time.
        </p>
      </div>
    </div>
  );
}
