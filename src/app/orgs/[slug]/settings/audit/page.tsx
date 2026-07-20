import type { Metadata } from "next";
import Link from "next/link";

import { sql } from "drizzle-orm";

import { formatDateTime } from "@/lib/billing-usage";
import { schema } from "@/lib/db";
import { requireOrgMembership } from "@/lib/org-access";

export const metadata: Metadata = {
  title: "Organization audit log",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const AUDIT_PAGE_SIZE = 50;

interface AuditEventRow {
  eventId: string;
  occurredAt: Date;
  eventType: "repository" | "setting";
  value: string;
  subject: string | null;
  repositoryPrivate: boolean | null;
  source: string;
  actorLogin: string | null;
}

interface RawAuditEventRow extends Omit<AuditEventRow, "occurredAt"> {
  occurredAt: Date | string;
}

export default async function OrganizationAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ after?: string }>;
}) {
  const { slug } = await params;
  const { db, org, membership } = await requireOrgMembership(slug);
  if (membership.role !== "admin") {
    throw new Error("this page requires an organization admin");
  }
  const cursor = parseCursor((await searchParams).after);

  const result = await db.execute(sql<AuditEventRow>`
    WITH audit_events AS (
      SELECT
        ${schema.repositoryEnablementEvents.id}::text AS "eventId",
        ${schema.repositoryEnablementEvents.occurredAt} AS "occurredAt",
        'repository'::text AS "eventType",
        ${schema.repositoryEnablementEvents.action} AS "value",
        ${schema.repositoryEnablementEvents.repositoryFullName} AS "subject",
        ${schema.repositoryEnablementEvents.repositoryPrivate} AS "repositoryPrivate",
        ${schema.repositoryEnablementEvents.source} AS "source",
        repository_actor.${sql.identifier("login")} AS "actorLogin"
      FROM ${schema.repositoryEnablementEvents}
      LEFT JOIN ${schema.users} repository_actor
        ON repository_actor.${sql.identifier("id")} = ${schema.repositoryEnablementEvents.actorUserId}
      WHERE ${schema.repositoryEnablementEvents.orgId} = ${org.id}

      UNION ALL

      SELECT
        ${schema.organizationSettingEvents.id}::text AS "eventId",
        ${schema.organizationSettingEvents.occurredAt} AS "occurredAt",
        'setting'::text AS "eventType",
        ${schema.organizationSettingEvents.value} AS "value",
        ${schema.organizationSettingEvents.setting} AS "subject",
        NULL::boolean AS "repositoryPrivate",
        ${schema.organizationSettingEvents.source} AS "source",
        setting_actor.${sql.identifier("login")} AS "actorLogin"
      FROM ${schema.organizationSettingEvents}
      LEFT JOIN ${schema.users} setting_actor
        ON setting_actor.${sql.identifier("id")} = ${schema.organizationSettingEvents.actorUserId}
      WHERE ${schema.organizationSettingEvents.orgId} = ${org.id}
    )
    SELECT "eventId", "occurredAt", "eventType", "value", "subject", "repositoryPrivate", "source", "actorLogin"
    FROM audit_events
    WHERE ${cursor ? sql`
      ("occurredAt", "eventType", "eventId"::bigint) <
      (${cursor.occurredAt}, ${cursor.eventType}, ${cursor.eventId}::bigint)
    ` : sql`TRUE`}
    ORDER BY "occurredAt" DESC, "eventType" DESC, "eventId"::bigint DESC
    LIMIT ${AUDIT_PAGE_SIZE + 1}
  `);
  const rows = (result.rows as unknown as RawAuditEventRow[]).map((row) => ({
    ...row,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt),
  }));
  const events = rows.slice(0, AUDIT_PAGE_SIZE);
  const nextCursor = rows.length > AUDIT_PAGE_SIZE && events.length > 0
    ? encodeCursor(events[events.length - 1]!)
    : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">
            <Link href={`/orgs/${org.slug}`} className="hover:underline">{org.slug}</Link>
            {" / audit log"}
          </p>
          <h1 className="serif-display mt-2 text-3xl">Organization audit log</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/orgs/${org.slug}/settings`} className="btn-secondary text-xs">
            Settings
          </Link>
          <Link href={`/orgs/${org.slug}/billing`} className="btn-secondary text-xs">
            Billing
          </Link>
        </div>
      </div>

      <div className="card mt-8 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-stone/70 font-mono text-[11px] uppercase tracking-[0.12em] text-charcoal/55">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Event</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone/60">
            {events.map((event) => (
              <tr key={`${event.eventType}-${event.eventId}`}>
                <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                  {formatDateTime(event.occurredAt)}
                </td>
                <td className="px-4 py-3">
                  {formatAuditEvent(event)}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-charcoal/70">
                  {event.actorLogin ? `@${event.actorLogin}` : "System"}
                </td>
                <td className="px-4 py-3 text-charcoal/70">
                  {formatAuditSource(event.source)}
                </td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-charcoal/50">
                  No audit events.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(cursor || nextCursor) && (
        <nav aria-label="Audit log pages" className="mt-4 flex items-center justify-between gap-3">
          {cursor ? (
            <Link href={auditPageUrl(org.slug)} className="btn-secondary text-xs">
              Newest
            </Link>
          ) : <span />}
          {nextCursor ? (
            <Link href={auditPageUrl(org.slug, nextCursor)} className="btn-secondary text-xs">
              Next
            </Link>
          ) : <span />}
        </nav>
      )}
    </div>
  );
}

interface AuditCursor {
  occurredAt: Date;
  eventType: AuditEventRow["eventType"];
  eventId: string;
}

function parseCursor(raw: string | undefined): AuditCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof value.occurredAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(value.occurredAt) ||
      (value.eventType !== "repository" && value.eventType !== "setting") ||
      typeof value.eventId !== "string" ||
      !/^[1-9]\d*$/.test(value.eventId)
    ) return null;
    if (BigInt(value.eventId) > 9_223_372_036_854_775_807n) return null;
    const occurredAt = new Date(value.occurredAt);
    if (!Number.isFinite(occurredAt.getTime())) return null;
    return { occurredAt, eventType: value.eventType, eventId: value.eventId };
  } catch {
    return null;
  }
}

function encodeCursor(event: AuditEventRow): string {
  return Buffer.from(JSON.stringify({
    occurredAt: event.occurredAt.toISOString(),
    eventType: event.eventType,
    eventId: event.eventId,
  })).toString("base64url");
}

function auditPageUrl(slug: string, after?: string): string {
  const base = `/orgs/${encodeURIComponent(slug)}/settings/audit`;
  return after ? `${base}?after=${encodeURIComponent(after)}` : base;
}

function formatAuditEvent(event: AuditEventRow): string {
  if (event.eventType === "repository") {
    const visibility = event.repositoryPrivate ? " (private)" : "";
    return `${event.value === "enable" ? "Enabled" : "Disabled"} ${event.subject ?? "repository"}${visibility}`;
  }
  return event.value === "enabled" ? "Enabled merge gate" : "Set merge gate to advisory";
}

function formatAuditSource(source: string): string {
  const labels: Record<string, string> = {
    dashboard: "Dashboard",
    github_installation: "GitHub App installation",
    github_pull_request: "GitHub pull request",
    github_transfer: "GitHub repository transfer",
    github_uninstall: "GitHub App removal",
    migration_baseline: "Imported baseline",
  };
  return labels[source] ?? "System";
}
