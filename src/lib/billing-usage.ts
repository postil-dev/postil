export type RepositoryEnablementAction = "enable" | "disable";

export interface RepositoryEnablementEventForBilling {
  id: number;
  repositoryId: number | null;
  githubRepoId: number;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  action: RepositoryEnablementAction;
  occurredAt: Date;
}

export interface BillingPeriod {
  start: Date;
  end: Date;
}

export interface CurrentEnabledRepositoryUsage {
  repositoryKey: string;
  repositoryId: number | null;
  githubRepoId: number;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  enabledSince: Date;
  enabledMsInPeriod: number;
}

export interface RepositoryUsageDetail {
  repositoryKey: string;
  repositoryId: number | null;
  githubRepoId: number;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  enabledMsInPeriod: number;
}

export interface BillingUsageSummary {
  period: BillingPeriod;
  totalEnabledMs: number;
  totalRepoDays: number;
  enabledPublicCount: number;
  enabledPrivateCount: number;
  currentEnabledRepositories: CurrentEnabledRepositoryUsage[];
  repositoryDetails: RepositoryUsageDetail[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function currentMonthBillingPeriod(now = new Date()): BillingPeriod {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)),
    end: now,
  };
}

export function calculateBillingUsage(
  events: RepositoryEnablementEventForBilling[],
  period: BillingPeriod,
): BillingUsageSummary {
  const byRepository = new Map<string, RepositoryEnablementEventForBilling[]>();
  for (const event of events) {
    const repositoryEvents = byRepository.get(repositoryKey(event)) ?? [];
    repositoryEvents.push(event);
    byRepository.set(repositoryKey(event), repositoryEvents);
  }

  const currentEnabledRepositories: CurrentEnabledRepositoryUsage[] = [];
  const repositoryDetails: RepositoryUsageDetail[] = [];
  let totalEnabledMs = 0;
  let enabledPublicCount = 0;
  let enabledPrivateCount = 0;

  for (const [key, repositoryEvents] of byRepository) {
    const ordered = [...repositoryEvents].sort(compareEvents);
    const latestEvent = ordered.at(-1);
    if (!latestEvent) continue;

    let enabled = false;
    let enabledSince: Date | null = null;
    let openIntervalStart: Date | null = null;
    let enabledMsInPeriod = 0;

    for (const event of ordered) {
      if (event.occurredAt < period.start) {
        if (event.action === "enable") {
          enabled = true;
          enabledSince = event.occurredAt;
          openIntervalStart = period.start;
        } else {
          enabled = false;
          enabledSince = null;
          openIntervalStart = null;
        }
        continue;
      }
      if (event.occurredAt > period.end) break;

      if (event.action === "enable") {
        if (!enabled) {
          enabled = true;
          enabledSince = event.occurredAt;
          openIntervalStart = event.occurredAt;
        }
      } else if (enabled) {
        enabledMsInPeriod += boundedDuration(openIntervalStart ?? period.start, event.occurredAt);
        enabled = false;
        enabledSince = null;
        openIntervalStart = null;
      }
    }

    if (enabled) {
      enabledMsInPeriod += boundedDuration(openIntervalStart ?? period.start, period.end);
      if (!enabledSince) enabledSince = period.start;
    }

    totalEnabledMs += enabledMsInPeriod;
    repositoryDetails.push({
      repositoryKey: key,
      repositoryId: latestEvent.repositoryId,
      githubRepoId: latestEvent.githubRepoId,
      repositoryFullName: latestEvent.repositoryFullName,
      repositoryPrivate: latestEvent.repositoryPrivate,
      enabledMsInPeriod,
    });

    if (enabled && enabledSince) {
      if (latestEvent.repositoryPrivate) enabledPrivateCount += 1;
      else enabledPublicCount += 1;
      currentEnabledRepositories.push({
        repositoryKey: key,
        repositoryId: latestEvent.repositoryId,
        githubRepoId: latestEvent.githubRepoId,
        repositoryFullName: latestEvent.repositoryFullName,
        repositoryPrivate: latestEvent.repositoryPrivate,
        enabledSince,
        enabledMsInPeriod,
      });
    }
  }

  return {
    period,
    totalEnabledMs,
    totalRepoDays: totalEnabledMs / MS_PER_DAY,
    enabledPublicCount,
    enabledPrivateCount,
    currentEnabledRepositories: currentEnabledRepositories.sort((a, b) =>
      a.repositoryFullName.localeCompare(b.repositoryFullName),
    ),
    repositoryDetails: repositoryDetails.sort((a, b) =>
      a.repositoryFullName.localeCompare(b.repositoryFullName),
    ),
  };
}

export function formatRepoDays(value: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: value >= 10 ? 1 : 2,
    minimumFractionDigits: value === 0 ? 0 : 1,
  });
}

export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function repositoryKey(event: RepositoryEnablementEventForBilling): string {
  return `github:${event.githubRepoId}`;
}

function compareEvents(
  left: RepositoryEnablementEventForBilling,
  right: RepositoryEnablementEventForBilling,
): number {
  const time = left.occurredAt.getTime() - right.occurredAt.getTime();
  return time === 0 ? left.id - right.id : time;
}

function boundedDuration(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}
