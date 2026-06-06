import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { assertAuthSecretConfigured, auth } from "@/auth";
import { reportViewerFromSession, type ReportViewer } from "@/lib/reports";

type OrganizationListApi = {
  listOrganizations?: (input: { headers: Headers }) => Promise<Array<{ id?: unknown }>>;
};

export async function requireReportSession(nextPath: string): Promise<ReportViewer> {
  assertAuthSecretConfigured();
  const requestHeaders = await headers();
  const session = await auth.api.getSession({
    headers: requestHeaders,
  });

  if (!session) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  const viewer = reportViewerFromSession(session);
  if (!viewer) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  const listOrganizations = (auth.api as OrganizationListApi).listOrganizations;
  const organizations = listOrganizations ? await listOrganizations({ headers: requestHeaders }) : [];
  const isMember = organizations.some((organization) => organization.id === viewer.organizationId);
  if (!isMember) {
    redirect("/reports");
  }

  return viewer;
}
