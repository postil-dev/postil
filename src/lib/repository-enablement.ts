import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { RepositoryEnablementAction } from "@/lib/billing-usage";

type RepositoryEnablementEventWriter = Pick<Database, "insert">;
export type RepositoryEnablementSource =
  | "dashboard"
  | "github_installation"
  | "github_pull_request"
  | "github_transfer"
  | "github_uninstall"
  | "migration_baseline";

export interface RepositoryEnablementEventInput {
  orgId: number;
  repositoryId: number | null;
  githubRepoId: number;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  action: RepositoryEnablementAction;
  actorUserId?: number | null;
  source: RepositoryEnablementSource;
  occurredAt?: Date;
}

export async function recordRepositoryEnablementEvent(
  db: RepositoryEnablementEventWriter,
  input: RepositoryEnablementEventInput,
): Promise<void> {
  if (input.action !== "enable" && input.action !== "disable") {
    throw new Error("repository enablement action must be enable or disable");
  }
  const values: typeof schema.repositoryEnablementEvents.$inferInsert = {
    orgId: input.orgId,
    repositoryId: input.repositoryId,
    githubRepoId: input.githubRepoId,
    repositoryFullName: input.repositoryFullName,
    repositoryPrivate: input.repositoryPrivate,
    action: input.action,
    actorUserId: input.actorUserId ?? null,
    source: input.source,
  };
  if (input.occurredAt) values.occurredAt = input.occurredAt;
  await db.insert(schema.repositoryEnablementEvents).values(values);
}
