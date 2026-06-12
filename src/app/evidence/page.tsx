import type { Metadata } from "next";

import { EvidenceViewer } from "@/components/evidence-viewer";
import { EVIDENCE_CASES } from "@/data/evidence";

export const metadata: Metadata = {
  title: "Evidence — real Postil output",
  description:
    "Real, unmocked output from the Postil CLI: it catches a security regression and a subtle logic bug, and stays silent on a clean change. With token counts and the model used.",
  alternates: { canonical: "/evidence" },
  openGraph: {
    title: "Evidence — real Postil output",
    description:
      "Catch the regression, catch the subtle bug, stay quiet on everything else. Real reviewer output with token counts.",
    url: "/evidence",
  },
};

export default function EvidencePage() {
  return <EvidenceViewer cases={EVIDENCE_CASES} />;
}
