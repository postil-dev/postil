import { MembershipVerificationUnavailableError } from "@/lib/auth-navigation";

export const dynamic = "force-dynamic";

export default function Page(): never {
  throw new MembershipVerificationUnavailableError();
}
