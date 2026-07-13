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
    rejected("# Summary\n## Correctness\n### Verdict\nText");
    rejected(Array.from({ length: 6 }, (_, index) => `${index + 1}. item`).join("\n"));
  });

  test("rejects active mentions, HTML, tables, and images", () => {
    rejected("Ask @maintainer to approve this.");
    rejected("<details><summary>More</summary>hidden</details>");
    rejected("A | B\n--- | ---\n1 | 2");
    rejected("![diagram](https://example.test/image.png)");
    expect(validateRespondPublication("Email dev@example.test.", "@postil help")).toBe(
      "Email dev@example.test.",
    );
  });

  test("allows one bounded requested Mermaid diagram", () => {
    const reply = "The request passes through one queue.\n\n```mermaid\nflowchart TD\n  A[Webhook] --> B[Queue]\n```";
    expect(validateRespondPublication(reply, "@postil diagram the flow")).toBe(reply);
    rejected(reply, "@postil explain the worker");
    rejected(
      "```mermaid\nflowchart TD\n  A --> B\n```\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```",
      "@postil show a diagram",
    );
  });

  test("rejects unsafe or unbounded Mermaid", () => {
    rejected(
      "```mermaid\nflowchart TD\n  A --> B\n  click A https://example.test\n```",
      "@postil diagram the flow",
    );
    rejected(
      `\`\`\`mermaid\nflowchart TD\n${Array.from({ length: 17 }, (_, i) => `  A${i} --> A${i + 1}`).join("\n")}\n\`\`\``,
      "@postil diagram the flow",
    );
    rejected("flowchart TD\nA --> B", "@postil diagram the flow");
  });
});
