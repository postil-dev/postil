const MAX_RESPOND_CHARACTERS = 2_400;
const MAX_RESPOND_NONBLANK_LINES = 24;
const MAX_RESPOND_HEADINGS = 2;
const MAX_RESPOND_LIST_ITEMS = 5;

const ACTIVE_MENTION = /(^|[^a-z0-9_-])@[a-z0-9][a-z0-9-]{0,38}(?=$|[^a-z0-9_-])/i;
const RAW_HTML = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/i;
const MARKDOWN_IMAGE = /!\[[^\]\n]*\](?:\([^\n)]*\)|\[[^\]\n]*\])?/;
const MERMAID = /(?:```|~~~)\s*mermaid\b|^\s*(?:flowchart\s+(?:TB|TD|BT|RL|LR)|sequenceDiagram)\b/im;
const REPORT_HEADING = /^\s{0,3}#{1,6}\s+(?:what this (?:pr|pull request) does|summary|correctness|issues?(?: and risks?)?|risks?|verdict|assessment|review metadata)\s*$/im;

export class PublicationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationValidationError";
  }
}

/** Validate model-authored respond output immediately before durable delivery. */
export function validateRespondPublication(reply: string, _maintainerMessage: string): string {
  const normalized = reply.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new PublicationValidationError("reply is empty");
  if ([...normalized].length > MAX_RESPOND_CHARACTERS) {
    throw new PublicationValidationError("reply exceeds the character limit");
  }

  const lines = normalized.split("\n");
  const nonblankLines = lines.filter((line) => line.trim().length > 0);
  if (nonblankLines.length > MAX_RESPOND_NONBLANK_LINES) {
    throw new PublicationValidationError("reply exceeds the line limit");
  }
  if (MERMAID.test(normalized)) {
    throw new PublicationValidationError("reply contains Mermaid");
  }

  const masked = maskCode(normalized);
  const visibleLines = masked.split("\n");
  const visibleNonblankLines = visibleLines.filter((line) => line.trim().length > 0);
  const headings = visibleNonblankLines.filter((line) => /^\s{0,3}#{1,6}\s+\S/.test(line));
  if (headings.length > MAX_RESPOND_HEADINGS) {
    throw new PublicationValidationError("reply has too many headings");
  }
  const listItems = visibleNonblankLines.filter((line) =>
    /^\s*(?:[-+*]|\d+[.)])\s+\S/.test(line),
  );
  if (listItems.length > MAX_RESPOND_LIST_ITEMS) {
    throw new PublicationValidationError("reply has too many list items");
  }
  if (ACTIVE_MENTION.test(masked)) {
    throw new PublicationValidationError("reply contains an active mention");
  }
  if (RAW_HTML.test(masked)) {
    throw new PublicationValidationError("reply contains raw HTML");
  }
  if (MARKDOWN_IMAGE.test(masked)) {
    throw new PublicationValidationError("reply contains an image");
  }
  if (containsMarkdownTable(visibleLines)) {
    throw new PublicationValidationError("reply contains a table");
  }
  if (REPORT_HEADING.test(masked)) {
    throw new PublicationValidationError("reply is formatted as a report");
  }
  return normalized;
}

/** Replace code content with spaces while preserving line and character positions. */
function maskCode(value: string): string {
  let fence: { character: "`" | "~"; length: number } | null = null;
  return value
    .split("\n")
    .map((line) => {
      const indentation = line.length - line.trimStart().length;
      const candidate = indentation <= 3 ? line.trimStart() : "";
      const marker = candidate.match(/^(`{3,}|~{3,})/u)?.[1];

      if (fence) {
        if (
          marker &&
          marker[0] === fence.character &&
          marker.length >= fence.length &&
          candidate.slice(marker.length).trim().length === 0
        ) {
          fence = null;
        }
        return " ".repeat(line.length);
      }

      if (marker) {
        fence = { character: marker[0] as "`" | "~", length: marker.length };
        return " ".repeat(line.length);
      }

      return line.replace(/(`+)([^\n]*?)\1/g, (span) => " ".repeat(span.length));
    })
    .join("\n");
}

function containsMarkdownTable(lines: string[]): boolean {
  for (let index = 1; index < lines.length; index += 1) {
    const delimiter = lines[index]!.trim();
    const previous = lines[index - 1]!.trim();
    if (
      previous.includes("|") &&
      /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(delimiter)
    ) {
      return true;
    }
  }
  return false;
}
