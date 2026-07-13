/**
 * A mention of the bot. Matches @postil as a whole handle, case-insensitive.
 *
 * GitHub handles may contain hyphens, so `-` must count as part of a handle,
 * not a boundary: @postil-dev (the org), @postil-cli, @postil-action are
 * different accounts and must not summon the bot. Mentions quoted inside
 * fenced code blocks or inline code spans are documentation, not requests,
 * and are stripped before matching.
 */
export function mentionsPostil(text: string | undefined | null): boolean {
  if (!text) return false;
  const prose = stripCode(text);
  return /(^|[^a-z0-9_-])@postil($|[^a-z0-9_-])/i.test(prose);
}

/**
 * An exact request to run the structured pull-request reviewer.
 *
 * Keep this grammar deliberately narrow. A question which happens to contain
 * "review" belongs to the bounded interactive-answer path; only a whole
 * comment whose post-mention text is a review command starts another review.
 */
export function isPostilReviewCommand(text: string | undefined | null): boolean {
  if (!text) return false;
  const prose = stripCode(text)
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");
  return /^@postil\s+(?:(?:please|can you(?: please)?)\s+)?(?:re-?review(?:\s+(?:this|this pr|the pull request|the current head|current head))?|re-?run(?:\s+the)?\s+review|review(?:\s+(?:this|this pr|the pull request|the current head|current head))?)$/i.test(
    prose,
  );
}

export type PostilApproveCommand =
  | { ok: true; findingId: string; rationale: string }
  | { ok: false; error: string };

export function parsePostilApproveCommand(
  text: string | undefined | null,
): PostilApproveCommand | null {
  if (!text) return null;
  const prose = stripCode(text).trim();
  if (!/^@postil(?:\s|$)/i.test(prose)) return null;
  if (!/^@postil\s+approve(?:\s|$)/i.test(prose)) return null;

  const match = prose.match(/^@postil\s+approve\s+(\S+)\s+--\s*([\s\S]*)$/i);
  if (!match) {
    return { ok: false, error: "Use `@postil approve <finding-id> -- <reason>`." };
  }
  const findingId = match[1]?.trim();
  const rationale = match[2]?.trim();
  if (!findingId) return { ok: false, error: "Approval requires a finding id." };
  if (!rationale) return { ok: false, error: "Approval requires a non-empty rationale." };
  return { ok: true, findingId, rationale };
}

/** Remove fenced code blocks (```...``` / ~~~...~~~) and inline `code` spans. */
function stripCode(text: string): string {
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, " ")
    // An unterminated fence renders as code to the end of the comment.
    .replace(/^(```|~~~)[\s\S]*$/m, " ")
    .replace(/`+[^`]*`+/g, " ");
}
