const MAX_RESPOND_CHARACTERS = 2_400;
const MAX_RESPOND_NONBLANK_LINES = 24;
const MAX_RESPOND_HEADINGS = 2;
const MAX_RESPOND_LIST_ITEMS = 5;

const ACTIVE_MENTION = /(^|[^a-z0-9_-])@[a-z0-9][a-z0-9-]{0,38}(?=$|[^a-z0-9_-])/i;
const RAW_HTML = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?/;
const MERMAID = /(?:```|~~~)\s*mermaid\b|^\s*(?:flowchart\s+(?:TB|TD|BT|RL|LR)|sequenceDiagram)\b/im;
const REPORT_HEADINGS = new Set([
  "what this pr does",
  "what this pull request does",
  "summary",
  "correctness",
  "issue",
  "issues",
  "issue and risk",
  "issue and risks",
  "issues and risk",
  "issues and risks",
  "risk",
  "risks",
  "verdict",
  "assessment",
  "review metadata",
]);

export class PublicationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationValidationError";
  }
}

/** Validate model-authored respond output immediately before durable delivery. */
export function validateRespondPublication(reply: string, _maintainerMessage: string): string {
  const normalized = trimOuterBlankLines(reply.replace(/\r\n?/g, "\n"));
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
  const headings = markdownHeadingNames(visibleLines);
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
  if (headings.some((heading) => REPORT_HEADINGS.has(heading))) {
    throw new PublicationValidationError("reply is formatted as a report");
  }
  return normalized;
}

function trimOuterBlankLines(value: string): string {
  const lines = value.split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  return lines.join("\n");
}

/** Replace code content with spaces while preserving line and character positions. */
function maskCode(value: string): string {
  let fence: { character: "`" | "~"; length: number } | null = null;
  let inIndentedBlock = false;
  const lines = value.split("\n");
  return value
    .split("\n")
    .map((line, index) => {
      if (fence) {
        const closing = closingFence(line);
        if (
          closing &&
          closing.character === fence.character &&
          closing.length >= fence.length
        ) {
          fence = null;
        }
        return " ".repeat(line.length);
      }

      const opening = openingFence(line);
      if (opening) {
        fence = opening;
        inIndentedBlock = false;
        return " ".repeat(line.length);
      }

      const blank = line.trim().length === 0;
      const indented = /^(?: {4}|\t)/u.test(line);
      if (indented && (inIndentedBlock || index === 0 || lines[index - 1]!.trim() === "")) {
        inIndentedBlock = true;
        return " ".repeat(line.length);
      }
      if (inIndentedBlock && blank) return " ".repeat(line.length);
      inIndentedBlock = false;

      return maskInlineCode(line);
    })
    .join("\n");
}

function openingFence(line: string): { character: "`" | "~"; length: number } | null {
  const candidate = line.match(/^ {0,3}((`{3,}|~{3,})(.*))$/u);
  const marker = candidate?.[2];
  const info = candidate?.[3] ?? "";
  if (!marker || (marker[0] === "`" && info.includes("`"))) return null;
  return { character: marker[0] as "`" | "~", length: marker.length };
}

function closingFence(line: string): { character: "`" | "~"; length: number } | null {
  const marker = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1];
  return marker
    ? { character: marker[0] as "`" | "~", length: marker.length }
    : null;
}

/** Mask only code spans with a closing delimiter run of exactly the same size. */
function maskInlineCode(line: string): string {
  const masked = line.split("");
  let cursor = 0;
  while (cursor < line.length) {
    const openingStart = line.indexOf("`", cursor);
    if (openingStart === -1) break;
    const openingLength = backtickRunLength(line, openingStart);
    let candidate = openingStart + openingLength;
    let closingStart = -1;
    while (candidate < line.length) {
      candidate = line.indexOf("`", candidate);
      if (candidate === -1) break;
      const candidateLength = backtickRunLength(line, candidate);
      if (candidateLength === openingLength) {
        closingStart = candidate;
        break;
      }
      candidate += candidateLength;
    }
    if (closingStart === -1) {
      cursor = openingStart + openingLength;
      continue;
    }
    const closingEnd = closingStart + openingLength;
    for (let index = openingStart; index < closingEnd; index += 1) masked[index] = " ";
    cursor = closingEnd;
  }
  return masked.join("");
}

function backtickRunLength(value: string, start: number): number {
  let end = start;
  while (value[end] === "`") end += 1;
  return end - start;
}

function markdownHeadingNames(lines: string[]): string[] {
  const headings: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const atx = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)\s*$/u)?.[1];
    if (atx) {
      headings.push(normalizeHeading(atx.replace(/[ \t]+#+[ \t]*$/u, "")));
      continue;
    }
    if (/^ {0,3}(?:=+|-+)[ \t]*$/u.test(line) && index > 0) {
      const previous = lines[index - 1]!.trim();
      if (previous) headings.push(normalizeHeading(previous));
    }
  }
  return headings;
}

function normalizeHeading(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+$/u, "");
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
