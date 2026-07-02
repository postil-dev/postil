import type { Metadata } from "next";

import { EvidenceViewer } from "@/components/evidence-viewer";
import { EVIDENCE_CASES } from "@/data/evidence";

export const metadata: Metadata = {
  title: "See it run — real Postil output",
  description:
    "Real, linked catches from Postil's own public repos: a migration that would fail against production duplicates, swapped commit SHAs in docs, a Rust panic on non-ASCII input, an uninstalled CI dependency, and a finding that asks a human to confirm instead of guessing.",
  alternates: { canonical: "/evidence" },
  openGraph: {
    title: "See it run — real Postil output",
    description:
      "Every case here links to the public pull request it came from. No invented bugs.",
    url: "/evidence",
    images: ["/opengraph-image"],
  },
};

export default function EvidencePage() {
  return <EvidenceViewer cases={EVIDENCE_CASES} />;
}
