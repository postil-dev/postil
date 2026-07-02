import type { Metadata } from "next";

import { EvidenceViewer } from "@/components/evidence-viewer";
import { EVIDENCE_CASES } from "@/data/evidence";

export const metadata: Metadata = {
  title: "See it run — real Postil output",
  description:
    "Representative Postil review evidence across security, correctness, payments, API contracts, concurrency, CI secrets, and clean changes, with token counts and model cost context.",
  alternates: { canonical: "/evidence" },
  openGraph: {
    title: "See it run — real Postil output",
    description:
      "Catch tenant-boundary regressions, replayable payments, subtle logic bugs, and CI leaks while staying quiet on clean changes.",
    url: "/evidence",
    images: ["/opengraph-image"],
  },
};

export default function EvidencePage() {
  return <EvidenceViewer cases={EVIDENCE_CASES} />;
}
