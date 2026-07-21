import { githubAppBotLogin } from "@/lib/github-app";

const MAX_CONVERSATION_REQUEST_CHARS = 2_000;

const GRATITUDE_ONLY =
  /^(?:(?:many\s+)?thanks(?:\s+(?:a\s+lot|again))?|thank\s+you(?:\s+(?:very\s+much|again))?|ty|thx|cheers|got\s+it|makes\s+sense|perfect|great|nice|helpful|appreciated|(?:👍|🙏|❤️|❤|🎉)+)(?:[\s,.!]*(?:👍|🙏|❤️|❤|🎉))*[\s.!]*$/iu;

const CLARIFICATION_PREFIX =
  /^(?:(?:please\s+)?(?:explain|clarify|show|tell)|can|could|would|will|do|does|did|is|are|was|were|why|what|when|where|which|who|how)\b/iu;

/** Remove the bot handle before classifying a short conversational request. */
export function withoutPostilMention(value: string): string {
  return value.replace(/(^|[^\w])@postil(?=$|[^\w-])/giu, "$1").trim();
}

export function isAcceptableConversationRequest(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_CONVERSATION_REQUEST_CHARS;
}

/** Gratitude receives a reaction and never spends a model call. */
export function isGratitudeOnly(value: string): boolean {
  const text = withoutPostilMention(value);
  return text.length > 0 && GRATITUDE_ONLY.test(text);
}

/** Admit only plainly interrogative unmentioned replies to a Postil thread. */
export function isClarificationRequest(value: string): boolean {
  const text = withoutPostilMention(value);
  if (!isAcceptableConversationRequest(text) || isGratitudeOnly(text)) return false;
  return text.includes("?") || CLARIFICATION_PREFIX.test(text);
}

export function isPostilBotLogin(login: string | undefined): boolean {
  return login?.toLowerCase() === githubAppBotLogin().toLowerCase();
}

/** Bound trusted thread context before it enters a respond-job payload. */
export function boundedThreadContext(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const marker = "<!-- postil-";
  const withoutMarker = value.includes(marker) ? value.slice(0, value.indexOf(marker)) : value;
  const trimmed = withoutMarker.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 4_000);
}
