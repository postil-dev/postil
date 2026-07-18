const SUPABASE_POOLER_HOST = /(?:^|[.])pooler[.]supabase[.]com$/i;

export function resolveDirectDatabaseUrl(input: {
  databaseUrl: string;
  directDatabaseUrl?: string;
}): string {
  if (input.directDatabaseUrl !== undefined && !input.directDatabaseUrl.trim()) {
    throw new Error("POSTIL_DIRECT_DATABASE_URL cannot be empty when configured");
  }
  const candidate = input.directDatabaseUrl?.trim() ?? input.databaseUrl.trim();
  if (!candidate) throw new Error("DATABASE_URL is required");

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("database URL is invalid");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("database URL must use postgres or postgresql");
  }
  if (!parsed.hostname || !parsed.username) {
    throw new Error("database URL must include a host and user");
  }

  if (parsed.port === "6543") {
    if (!SUPABASE_POOLER_HOST.test(parsed.hostname)) {
      throw new Error(
        "a transaction-pool database URL cannot be used for migrations without a known session endpoint",
      );
    }
    parsed.port = "5432";
    parsed.searchParams.delete("pgbouncer");
  }
  return parsed.toString();
}
