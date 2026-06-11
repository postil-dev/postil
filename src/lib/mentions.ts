/** A mention of the bot. Matches @postil as a whole word, case-insensitive. */
export function mentionsPostil(text: string | undefined | null): boolean {
  if (!text) return false;
  return /(^|[^a-z0-9_])@postil($|[^a-z0-9_])/i.test(text);
}
