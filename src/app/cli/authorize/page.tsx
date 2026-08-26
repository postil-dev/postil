import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { and, asc, eq } from "drizzle-orm";

import {
  findDeviceAuthorizationByUserCode,
  formatUserCode,
  normalizeUserCodeInput,
} from "@/lib/cli-auth";
import { getDb, schema } from "@/lib/db";
import { getVerifiedSessionUser, loginRedirectPath } from "@/lib/session";
import { approveDeviceAuthorizationAction, denyDeviceAuthorizationAction } from "./actions";
import { OrganizationAuthorizationFields } from "./organization-authorization-fields";

export const metadata: Metadata = {
  title: "Authorize CLI login",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function CliAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; result?: string }>;
}) {
  const params = await searchParams;

  // Belt-and-suspenders: the middleware already redirects unauthenticated
  // requests, but only checks the signed cookie. This checks the session row
  // and GitHub organization membership, same as every other account page.
  const verification = await getVerifiedSessionUser();
  if (!verification.ok) {
    redirect(
      await loginRedirectPath(
        verification.reason === "verification_unavailable"
          ? "membership_verification"
          : undefined,
      ),
    );
  }
  const user = verification.user;

  if (params.result === "approved") {
    return (
      <StatusCard
        title="Login approved"
        body="The command line will finish signing in on its own. You can return to your terminal."
      />
    );
  }
  if (params.result === "denied") {
    return (
      <StatusCard
        title="Login denied"
        body="The command line will report that this login was denied. You can return to your terminal."
      />
    );
  }

  if (!params.code) return <CodeEntryForm />;

  const code = normalizeUserCodeInput(params.code);
  const db = getDb();
  const row = await findDeviceAuthorizationByUserCode(db, code);

  if (!row) {
    return (
      <StatusCard
        title="Invalid code"
        body="Check the code shown in your terminal and try again."
        isError
      />
    );
  }
  if (row.status === "expired") {
    return (
      <StatusCard
        title="Code expired"
        body="Run `postil login` again to get a new code."
        isError
      />
    );
  }
  if (row.status === "claimed") {
    return <StatusCard title="Already used" body="This code has already been redeemed." />;
  }
  if (row.status === "denied") {
    return <StatusCard title="Already denied" body="This login was already denied." />;
  }
  if (row.status === "approved") {
    return <StatusCard title="Already approved" body="This login was already approved." />;
  }

  const adminOrgs = await db
    .select({ slug: schema.organizations.slug, name: schema.organizations.name })
    .from(schema.orgMembers)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgMembers.orgId))
    .where(and(eq(schema.orgMembers.userId, user.id), eq(schema.orgMembers.role, "admin")))
    .orderBy(asc(schema.organizations.name));

  if (adminOrgs.length === 0) {
    return (
      <StatusCard
        title="No organizations to authorize"
        body="You must administer a Postil organization to approve a CLI login."
        isError
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl justify-center px-6 py-24">
      <div className="card w-full max-w-md p-10">
        <p className="eyebrow">CLI login</p>
        <h1 className="serif-display mt-2 text-3xl">Authorize this device</h1>
        <p className="mt-4 text-center font-mono text-2xl tracking-widest">
          {formatUserCode(code)}
        </p>
        <p className="mt-6 text-sm text-ink-soft">
          A command line is requesting access to the selected
          organization&apos;s hosted review budget. Access tokens rotate every 12
          hours. The CLI remains signed in while it is used, and the renewable
          session expires after 180 days without a successful refresh.
        </p>
        <form className="mt-8 space-y-4">
          <input type="hidden" name="code" value={code} />
          <OrganizationAuthorizationFields organizations={adminOrgs} />
          <div className="flex gap-3">
            <button formAction={approveDeviceAuthorizationAction} className="btn-primary flex-1">
              Approve
            </button>
            <button formAction={denyDeviceAuthorizationAction} className="btn-secondary flex-1">
              Deny
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CodeEntryForm() {
  return (
    <div className="mx-auto flex max-w-6xl justify-center px-6 py-24">
      <div className="card w-full max-w-md p-10 text-center">
        <p className="eyebrow">CLI login</p>
        <h1 className="serif-display mt-2 text-3xl">Enter your code</h1>
        <p className="mt-3 text-sm text-ink-soft">
          Enter the code shown by <code>postil login</code> in your terminal.
        </p>
        <form method="get" action="/cli/authorize" className="mt-6 flex gap-2">
          <label htmlFor="device-code" className="sr-only">
            Device authorization code
          </label>
          <input
            id="device-code"
            type="text"
            name="code"
            placeholder="WDJF-3K9Q"
            autoCapitalize="characters"
            autoComplete="off"
            required
            className="flex-1 rounded-card border border-stone bg-white/60 px-3 py-2 font-mono text-sm tracking-widest"
          />
          <button type="submit" className="btn-primary">
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}

function StatusCard({
  title,
  body,
  isError = false,
}: {
  title: string;
  body: string;
  isError?: boolean;
}) {
  return (
    <div className="mx-auto flex max-w-6xl justify-center px-6 py-24">
      <div className="card w-full max-w-md p-10 text-center">
        <p className="eyebrow">CLI login</p>
        <h1 className="serif-display mt-2 text-3xl">{title}</h1>
        <p
          className={
            isError
              ? "mt-4 rounded-card border border-softred bg-softred/10 px-4 py-2 text-sm text-rust"
              : "mt-4 text-sm text-ink-soft"
          }
        >
          {body}
        </p>
      </div>
    </div>
  );
}
