const MAX_RESPOND_CHARACTERS = 2_400;
const MAX_RESPOND_NONBLANK_LINES = 24;
const MAX_RESPOND_HEADINGS = 2;
const MAX_RESPOND_LIST_ITEMS = 5;
const MAX_MERMAID_LINES = 16;
const MAX_MERMAID_CHARACTERS = 1_200;

const ACTIVE_MENTION = /(^|[^a-z0-9_-])@[a-z0-9][a-z0-9-]{0,38}(?=$|[^a-z0-9_-])/i;
const RAW_HTML = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\s*\(/;
const DIAGRAM_REQUEST = /\b(?:diagram|flow(?:chart)?|mermaid|sequence|architecture)\b/i;
const MERMAID_DIRECTIVE = /\b(?:click|href|classDef|linkStyle|style)\b|%%\{|https?:\/\//i;

export class PublicationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationValidationError";
  }
}

/** Validate model-authored respond output immediately before durable delivery. */
export function validateRespondPublication(reply: string, maintainerMessage: string): string {
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
  const headings = nonblankLines.filter((line) => /^\s{0,3}#{1,6}\s+\S/.test(line));
  if (headings.length > MAX_RESPOND_HEADINGS) {
    throw new PublicationValidationError("reply has too many headings");
  }
  const listItems = nonblankLines.filter((line) => /^\s*(?:[-+*]|\d+[.)])\s+\S/.test(line));
  if (listItems.length > MAX_RESPOND_LIST_ITEMS) {
    throw new PublicationValidationError("reply has too many list items");
  }
  if (ACTIVE_MENTION.test(normalized)) {
    throw new PublicationValidationError("reply contains an active mention");
  }
  if (RAW_HTML.test(normalized)) {
    throw new PublicationValidationError("reply contains raw HTML");
  }
  if (MARKDOWN_IMAGE.test(normalized)) {
    throw new PublicationValidationError("reply contains an image");
  }
  if (containsMarkdownTable(lines)) {
    throw new PublicationValidationError("reply contains a table");
  }

  validateMermaid(normalized, maintainerMessage);
  return normalized;
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

function validateMermaid(reply: string, maintainerMessage: string): void {
  const blocks = [...reply.matchAll(/(^|\n)(```|~~~)mermaid\s*\n([\s\S]*?)\n\2(?=\n|$)/gi)];
  const mentionsMermaid = /(?:```|~~~)mermaid\b|\b(?:flowchart|sequenceDiagram)\b/i.test(reply);
  if (!mentionsMermaid) return;
  if (blocks.length !== 1) {
    throw new PublicationValidationError("reply must contain one fenced Mermaid diagram");
  }
  if (!DIAGRAM_REQUEST.test(maintainerMessage)) {
    throw new PublicationValidationError("reply contains an unrequested Mermaid diagram");
  }
  const diagram = blocks[0]![3]!.trim();
  const diagramLines = diagram.split("\n").filter((line) => line.trim().length > 0);
  if (
    [...diagram].length > MAX_MERMAID_CHARACTERS ||
    diagramLines.length > MAX_MERMAID_LINES
  ) {
    throw new PublicationValidationError("Mermaid diagram exceeds its size limit");
  }
  if (!/^(?:flowchart\s+(?:TB|TD|BT|RL|LR)|sequenceDiagram)\b/.test(diagram)) {
    throw new PublicationValidationError("Mermaid diagram type is not allowed");
  }
  if (MERMAID_DIRECTIVE.test(diagram) || RAW_HTML.test(diagram)) {
    throw new PublicationValidationError("Mermaid diagram contains a disallowed directive");
  }
}
