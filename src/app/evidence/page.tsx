import type { Metadata } from "next";

import { EvidenceViewer } from "@/components/evidence-viewer";
import { EVIDENCE_CASES } from "@/data/evidence";

export const metadata: Metadata = {
  title: "See it run — real Postil output",
  description:
    "Three real, unmocked runs of the Postil CLI: it catches a security regression and a subtle logic bug, and stays silent on a clean change. With token counts and the model used.",
  alternates: { canonical: "/evidence" },
  openGraph: {
    title: "See it run — real Postil output",
    description:
      "Catch the regression, catch the subtle bug, stay quiet on everything else. Real reviewer output with token counts.",
    url: "/evidence",
    images: ["/opengraph-image"],
  },
};

export default function EvidencePage() {
  return <EvidenceViewer cases={EVIDENCE_CASES} />;
}
