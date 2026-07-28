import { githubAppSlug } from "@/lib/github-app";

/** Match the portable Postil handle and the configured GitHub App slug. */
function handlePattern(): string {
  const handles = new Set(["postil", githubAppSlug().toLowerCase()]);
  return `(?:${[...handles].map(escapeRegExp).join("|")})`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a Postil mention as a whole handle, case-insensitively.
 *
 * The canonical `@postil` handle remains portable across forges. GitHub also
 * displays the configured App slug, so that exact handle is accepted as an
 * alias. A following slash identifies an organization team mention and does
 * not summon Postil. Mentions inside code are documentation, not requests.
 */
export function mentionsPostil(text: string | undefined | null): boolean {
  if (!text) return false;
  const prose = stripCode(text);
  return new RegExp(
    `(^|[^a-z0-9_-])@${handlePattern()}($|[^a-z0-9_\\/-])`,
    "i",
  ).test(prose);
}

/** Remove canonical and configured App handles before classifying a request. */
export function removePostilMentions(text: string): string {
  return text.replace(
    new RegExp(`(^|[^\\w])@${handlePattern()}(?=$|[^\\w/-])`, "giu"),
    "$1",
  );
}

/**
 * An exact request to run the structured pull-request reviewer.
 *
 * Keep this grammar deliberately narrow. A question which happens to contain
 * "review" belongs to the bounded interactive-answer path. A leading,
 * standalone review command starts another review; a later sentence may
 * explain why the review was requested.
 */
export function isPostilReviewCommand(text: string | undefined | null): boolean {
  if (!text) return false;
  const prose = stripCode(text)
    .trim()
    .replace(/\s+/g, " ");
  const boundary = prose.search(/[.!?]\s+/u);
  const firstSentence = (boundary === -1 ? prose : prose.slice(0, boundary + 1)).replace(
    /[.!?]+$/,
    "",
  );
  const explanation = boundary === -1 ? "" : prose.slice(boundary + 1).trim();
  if (explanation && !isReviewFailureExplanation(explanation)) return false;
  return new RegExp(
    `^@${handlePattern()}\\s+(?:(?:please|can you(?: please)?)\\s+)?(?:re-?review(?:\\s+(?:this|this pr|the pull request|the current head|current head))?|re-?run(?:\\s+the)?\\s+review(?:\\s+for\\s+(?:the\\s+)?current\\s+head)?|review(?:\\s+(?:this|this pr|the pull request|the current head|current head))?)$`,
    "i",
  ).test(firstSentence);
}

function isReviewFailureExplanation(text: string): boolean {
  return /^(?:the )?(?:previous|last) (?:hosted )?(?:review|run) (?:(?:ended without|produced no) (?:a )?(?:review )?verdict|(?:did not|didn't) (?:finish|post (?:a )?(?:review|verdict)|produce (?:a )?(?:review|verdict))|(?:failed|timed out|stopped)(?: before (?:posting|producing) (?:a )?(?:review|verdict))?)\.$/i.test(
    text,
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
  const handle = handlePattern();
  if (!new RegExp(`^@${handle}(?:\\s|$)`, "i").test(prose)) return null;
  if (!new RegExp(`^@${handle}\\s+approve(?:\\s|$)`, "i").test(prose)) return null;

  const match = prose.match(
    new RegExp(`^@${handle}\\s+approve\\s+(\\S+)\\s+--\\s*([\\s\\S]*)$`, "i"),
  );
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
