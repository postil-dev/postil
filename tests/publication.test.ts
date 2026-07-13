import { describe, expect, test } from "bun:test";

import {
  PublicationValidationError,
  validateRespondPublication,
} from "@/lib/publication";

function rejected(reply: string, prompt = "@postil explain this"): void {
  expect(() => validateRespondPublication(reply, prompt)).toThrow(PublicationValidationError);
}

describe("validateRespondPublication", () => {
  test("accepts a compact grounded answer and normalizes line endings", () => {
    const reply = "`src/auth.ts:41` passes unsanitized input to the query.\r\n\r\nParameterize it before merging.";
    expect(validateRespondPublication(reply, "@postil is this safe?")).toBe(
      "`src/auth.ts:41` passes unsanitized input to the query.\n\nParameterize it before merging.",
    );
  });

  test("rejects article-sized and report-shaped output", () => {
    rejected("x".repeat(2_401));
    rejected(Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n"));
    for (const heading of ["Analysis", "Recommendations", "Overview", "Summary"]) {
      rejected(`# ${heading}\nLong-form report prose.`);
    }
    rejected(Array.from({ length: 4 }, (_, index) => `${index + 1}. item`).join("\n"));
  });

  test("rejects active mentions, HTML, tables, and images", () => {
    rejected("Ask @maintainer to approve this.");
    rejected("<details><summary>More</summary>hidden</details>");
    rejected("<!-- unterminated comment");
    rejected("A | B\n--- | ---\n1 | 2");
    rejected("![diagram](https://example.test/image.png)");
    expect(validateRespondPublication("Email dev@example.test.", "@postil help")).toBe(
      "Email dev@example.test.",
    );
  });

  test("rejects Mermaid even when the maintainer requests it", () => {
    const reply = "The request passes through one queue.\n\n```mermaid\nflowchart TD\n  A[Webhook] --> B[Queue]\n```";
    rejected(reply, "@postil diagram the flow");
    rejected(reply, "@postil explain the worker");
    rejected("flowchart TD\nA --> B", "@postil diagram the flow");
    rejected("sequenceDiagram\nA->>B: hi", "@postil show the sequence");
    for (const declaration of [
      "graph TD\nA --> B",
      "sequenceDiagram",
      "stateDiagram",
      "stateDiagram-v2",
      "classDiagram\nclass A",
      "stateDiagram-v2\n[*] --> A",
      "erDiagram\nA ||--o{ B : has",
      "journey",
      "gantt",
      "pie showData",
      "mindmap\n root((Postil))",
      "timeline",
      'gitGraph {"showBranches": true}',
      "quadrantChart",
      "xychart-beta",
      "block-beta columns 3",
      "packet-beta",
      "architecture-beta\nservice api(server)",
      "kanban",
      "sankey-beta",
    ]) {
      rejected(declaration, "@postil explain the flow");
    }
  });

  test("does not mistake ordinary prose for a Mermaid declaration", () => {
    for (const reply of [
      "Graph construction is linear in the number of edges.",
      "A timeline helps explain the retry sequence.",
      "Pie is not relevant to this handler.",
      "The journey continues through the queue.",
      "Kanban boards are outside this change.",
    ]) {
      expect(validateRespondPublication(reply, "@postil explain this")).toBe(reply);
    }
  });

  test("masks code before publication-shape checks", () => {
    const reply = [
      "The parser treats these as data:",
      "",
      "   ~~~~text",
      "@maintainer <details> ![image][ref]",
      "A | B",
      "--- | ---",
      "# Verdict",
      "1) one",
      "2. two",
      "3) three",
      "4. four",
      "5) five",
      "6. six",
      "   ~~~~",
      "",
      "Inline `@person <img> ![image] | --- | # Summary` is code too.",
    ].join("\n");
    expect(validateRespondPublication(reply, "@postil explain the parser")).toBe(reply);
    expect(validateRespondPublication("    @maintainer <details> ![image]", "@postil help")).toBe(
      "    @maintainer <details> ![image]",
    );
    rejected("Paragraph text\n    @maintainer");
  });

  test("does not mask invalid fences or unmatched code spans", () => {
    rejected("``` text`\n@victim\n```");
    rejected("`@victim``");
  });

  test("rejects all Markdown image forms outside code", () => {
    for (const image of [
      "![inline](https://example.test/image.png)",
      "![full reference][image-id]",
      "![collapsed][]",
      "![shortcut]",
      "![hello\nworld](https://example.test/image.png)",
    ]) {
      rejected(image);
    }
  });

  test("counts both ordered-list marker forms", () => {
    rejected("1) one\n2. two\n3) three\n4. four\n5) five\n6. six");
  });

  test("rejects report sections outside code", () => {
    rejected("# What this PR does\nA long assessment follows.");
    rejected("## Verdict\nShip it.");
    rejected("# Summary:\nA long assessment follows.");
    rejected("Summary\n=======\nA long assessment follows.");
  });
});
