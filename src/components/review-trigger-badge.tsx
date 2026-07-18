import {
  reviewTriggerDescription,
  reviewTriggerLabel,
  type ReviewTriggerSource,
} from "@/lib/review-trigger";

export function ReviewTriggerBadge({ source }: { source: ReviewTriggerSource }) {
  return (
    <span
      className="inline-flex rounded-full border border-stone px-2 py-0.5 font-mono text-[10px] text-charcoal/70"
      title={reviewTriggerDescription(source)}
    >
      {reviewTriggerLabel(source)}
    </span>
  );
}
