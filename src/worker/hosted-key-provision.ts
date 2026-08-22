import { getDb } from "@/lib/db";
import { provisionHostedProviderKey } from "@/lib/hosted-provider-keys";
import type { HostedKeyProvisionJobPayload } from "@/lib/queue";

export async function runHostedKeyProvisionJob(
  payload: HostedKeyProvisionJobPayload,
): Promise<void> {
  if (!Number.isSafeInteger(payload.orgId) || payload.orgId <= 0) {
    throw new Error("hosted key provision job payload is malformed");
  }
  await provisionHostedProviderKey(getDb(), payload.orgId);
}
