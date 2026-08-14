import { MembershipVerificationUnavailableError } from "@/lib/auth-navigation";

export const dynamic = "force-dynamic";

let retryAttempts = 0;
const RETRY_DELAY_MS = 4_000;

export default async function Page({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  if (path[0] === "retry-once") {
    retryAttempts += 1;
    if (retryAttempts > 1) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      return <p data-membership-recovered>Organization access verified.</p>;
    }
  }
  throw new MembershipVerificationUnavailableError(
    Date.now() + RETRY_DELAY_MS,
  );
}
