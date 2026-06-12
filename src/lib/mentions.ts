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

/** Remove fenced code blocks (```...``` / ~~~...~~~) and inline `code` spans. */
function stripCode(text: string): string {
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, " ")
    // An unterminated fence renders as code to the end of the comment.
    .replace(/^(```|~~~)[\s\S]*$/m, " ")
    .replace(/`+[^`]*`+/g, " ");
}
