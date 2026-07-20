import type { Metadata } from "next";
import Link from "next/link";

import { sql } from "drizzle-orm";

import { formatDateTime } from "@/lib/billing-usage";
import { requireOrgMembership } from "@/lib/org-access";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "./actions";

export const metadata: Metadata = {
  title: "Notifications",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

interface NotificationRow {
  id: string;
  severity: "info" | "warning" | "critical";
  category: "trial" | "billing" | "service" | "security";
  title: string;
  body: string;
  actionLabel: string | null;
  actionHref: string | null;
  createdAt: Date;
  readAt: Date | null;
}

interface RawNotificationRow extends Omit<NotificationRow, "createdAt" | "readAt"> {
  createdAt: Date | string;
  readAt: Date | string | null;
}

export default async function OrganizationNotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ after?: string }>;
}) {
  const { slug } = await params;
  const { db, user, org, membership } = await requireOrgMembership(slug);
  const cursor = parseCursor((await searchParams).after);
  const visibility = membership.role === "admin"
    ? sql`event.visibility IN ('members', 'admins')`
    : sql`event.visibility = 'members'`;
  const result = await db.execute(sql<NotificationRow>`
    SELECT
      event.id::text AS id,
      event.severity,
      event.category,
      event.title,
      event.body,
      event.action_label AS "actionLabel",
      event.action_href AS "actionHref",
      event.created_at AS "createdAt",
      receipt.read_at AS "readAt"
    FROM customer_notification_events AS event
    LEFT JOIN customer_notification_reads AS receipt
      ON receipt.event_id = event.id AND receipt.user_id = ${user.id}
    WHERE event.org_id = ${org.id}
      AND event.expires_at > now()
      AND ${visibility}
      AND ${cursor ? sql`(event.created_at, event.id) < (${cursor.createdAt}, ${cursor.id}::bigint)` : sql`TRUE`}
    ORDER BY event.created_at DESC, event.id DESC
    LIMIT ${PAGE_SIZE + 1}
  `);
  const rows = (result.rows as unknown as RawNotificationRow[]).map((row) => ({
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    readAt: row.readAt instanceof Date || row.readAt === null
      ? row.readAt
      : new Date(row.readAt),
  }));
  const notifications = rows.slice(0, PAGE_SIZE);
  const nextCursor = rows.length > PAGE_SIZE && notifications.length > 0
    ? encodeCursor(notifications[notifications.length - 1]!)
    : null;

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">
            <Link href={`/orgs/${org.slug}`} className="hover:underline">
              {org.slug}
            </Link>{" / notifications"}
          </p>
          <h1 className="serif-display mt-2 text-3xl">Notifications</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Trial, billing, security, and service updates for this organization.
          </p>
        </div>
        {notifications.length > 0 && (
          <form action={markAllNotificationsRead}>
            <input type="hidden" name="slug" value={org.slug} />
            <button type="submit" className="btn-secondary text-xs">
              Mark all read
            </button>
          </form>
        )}
      </div>

      <div className="card mt-8 overflow-hidden">
        {notifications.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <NotificationIcon severity="info" />
            <p className="mt-3 font-medium">You’re all caught up.</p>
            <p className="mt-1 text-sm text-ink-soft">
              Organization updates appear here when they need your attention.
            </p>
          </div>
        ) : (
          <ol className="divide-y divide-stone/60">
            {notifications.map((event) => (
              <li
                key={event.id}
                className={`grid gap-4 px-5 py-5 sm:grid-cols-[1.5rem_minmax(0,1fr)_auto] ${event.readAt ? "bg-white/25" : "bg-white/70"}`}
              >
                <NotificationIcon severity={event.severity} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h2 className="font-medium text-charcoal">{event.title}</h2>
                    {!event.readAt && (
                      <span className="rounded-full bg-gate/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-gate">
                        New
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm leading-6 text-ink-soft">{event.body}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                    <span className="font-mono uppercase tracking-[0.1em] text-charcoal/55">
                      {categoryLabel(event.category)}
                    </span>
                    <time
                      dateTime={event.createdAt.toISOString()}
                      title={formatDateTime(event.createdAt)}
                      className="text-charcoal/50"
                    >
                      {formatDateTime(event.createdAt)}
                    </time>
                    {event.actionHref && event.actionLabel && (
                      <Link href={event.actionHref} className="text-gate underline underline-offset-4">
                        {event.actionLabel}
                      </Link>
                    )}
                  </div>
                </div>
                {!event.readAt && (
                  <form action={markNotificationRead} className="self-start">
                    <input type="hidden" name="slug" value={org.slug} />
                    <input type="hidden" name="eventId" value={event.id} />
                    <button type="submit" className="btn-secondary whitespace-nowrap text-xs">
                      Mark read
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {(cursor || nextCursor) && (
        <nav aria-label="Notification pages" className="mt-4 flex items-center justify-between gap-3">
          {cursor ? (
            <Link href={pageUrl(org.slug)} className="btn-secondary text-xs">
              Newest
            </Link>
          ) : <span />}
          {nextCursor ? (
            <Link href={pageUrl(org.slug, nextCursor)} className="btn-secondary text-xs">
              Older
            </Link>
          ) : <span />}
        </nav>
      )}
    </main>
  );
}

function NotificationIcon({ severity }: { severity: NotificationRow["severity"] }) {
  const styles = {
    info: "border-gate/30 bg-gate/10 text-gate",
    warning: "border-amber-600/35 bg-amber-500/10 text-amber-700",
    critical: "border-gate/35 bg-gate/10 text-gate",
  } as const;
  return (
    <span
      role="img"
      aria-label={`${severity} notification`}
      className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full border ${styles[severity]}`}
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        {severity === "info" ? (
          <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>
        ) : (
          <><path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 9v4M12 16h.01" /></>
        )}
      </svg>
    </span>
  );
}

function categoryLabel(category: NotificationRow["category"]): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

interface NotificationCursor {
  createdAt: Date;
  id: string;
}

function parseCursor(raw: string | undefined): NotificationCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof value.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(value.createdAt) ||
      typeof value.id !== "string" ||
      !/^[1-9]\d*$/.test(value.id) ||
      BigInt(value.id) > 9_223_372_036_854_775_807n
    ) return null;
    const createdAt = new Date(value.createdAt);
    return Number.isFinite(createdAt.getTime()) ? { createdAt, id: value.id } : null;
  } catch {
    return null;
  }
}

function encodeCursor(event: NotificationRow): string {
  return Buffer.from(JSON.stringify({
    createdAt: event.createdAt.toISOString(),
    id: event.id,
  })).toString("base64url");
}

function pageUrl(slug: string, after?: string): string {
  const base = `/orgs/${encodeURIComponent(slug)}/notifications`;
  return after ? `${base}?after=${encodeURIComponent(after)}` : base;
}
