export type MigrationSource = {
  path: string;
  sql: string;
};

export type MigrationLintFinding = {
  path: string;
  line: number;
  table: string;
  statement: string;
  message: string;
};

export type MigrationLintOptions = {
  allowedUnsafeIndexes?: readonly string[];
};

const SQL_IDENTIFIER = String.raw`(?:"(?:""|[^"])+"|[a-z_][\w$]*)`;
const QUALIFIED_SQL_IDENTIFIER = String.raw`${SQL_IDENTIFIER}(?:\s*\.\s*${SQL_IDENTIFIER})*`;

const CREATE_TABLE_PATTERN = new RegExp(
  String.raw`\bCREATE\s+(?:TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<table>${QUALIFIED_SQL_IDENTIFIER})`,
  "giy",
);

const CREATE_INDEX_PATTERN = new RegExp(
  String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:(?<concurrently>CONCURRENTLY)\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:${QUALIFIED_SQL_IDENTIFIER})\s+)?ON\s+(?:ONLY\s+)?(?<table>${QUALIFIED_SQL_IDENTIFIER})`,
  "giy",
);

// Existing-table indexes must use CONCURRENTLY; indexes created in the same
// migration as their table are allowed because no live table lock is extended.
export function lintMigrationSources(
  migrations: readonly MigrationSource[],
  options: MigrationLintOptions = {},
): MigrationLintFinding[] {
  const knownTables = new Set<string>();
  const allowedUnsafeIndexes = new Set(options.allowedUnsafeIndexes ?? []);
  const findings: MigrationLintFinding[] = [];

  for (const migration of migrations) {
    const masked = maskSqlForLint(migration.sql);
    const createdInMigration = findCreateTables(masked);
    const indexMatches = findCreateIndexes(masked);

    for (const match of indexMatches) {
      if (match.concurrently) continue;
      if (createdInMigration.has(match.table)) continue;

      const findingKey = `${migration.path}:${match.line}`;
      if (allowedUnsafeIndexes.has(findingKey)) continue;

      findings.push({
        path: migration.path,
        line: match.line,
        table: match.table,
        statement: compactSql(migration.sql.slice(match.start, match.end)),
        message: `CREATE INDEX on existing table "${match.table}" must use CREATE INDEX CONCURRENTLY`,
      });
    }

    for (const table of createdInMigration) knownTables.add(table);
    for (const match of indexMatches) {
      if (!createdInMigration.has(match.table) && !knownTables.has(match.table)) {
        knownTables.add(match.table);
      }
    }
  }

  return findings;
}

function findCreateTables(maskedSql: string): Set<string> {
  const tables = new Set<string>();

  for (const match of matchSqlPattern(maskedSql, CREATE_TABLE_PATTERN)) {
    const table = match.groups?.table;
    if (table) tables.add(normalizeSqlIdentifier(table));
  }

  return tables;
}

function findCreateIndexes(maskedSql: string): {
  concurrently: boolean;
  end: number;
  line: number;
  start: number;
  table: string;
}[] {
  return matchSqlPattern(maskedSql, CREATE_INDEX_PATTERN).map((match) => ({
    concurrently: Boolean(match.groups?.concurrently),
    end: statementEnd(maskedSql, match.index),
    line: lineNumberAt(maskedSql, match.index),
    start: match.index,
    table: normalizeSqlIdentifier(match.groups?.table ?? ""),
  }));
}

function matchSqlPattern(sql: string, pattern: RegExp): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];

  for (let offset = 0; offset < sql.length; offset += 1) {
    pattern.lastIndex = offset;
    const match = pattern.exec(sql);
    if (!match) continue;

    matches.push(match);
    offset = Math.max(match.index, pattern.lastIndex - 1);
  }

  return matches;
}

function maskSqlForLint(sql: string): string {
  let masked = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "-" && next === "-") {
      masked += "  ";
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        masked += " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      masked += "  ";
      index += 2;
      while (index < sql.length) {
        if (sql[index] === "*" && sql[index + 1] === "/") {
          masked += "  ";
          index += 2;
          break;
        }
        masked += sql[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (char === "'") {
      masked += " ";
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          masked += "  ";
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          masked += " ";
          index += 1;
          break;
        }
        masked += sql[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    const dollarTag = sql.slice(index).match(/^\$[A-Za-z_][\w$]*\$|^\$\$/);
    if (dollarTag) {
      const tag = dollarTag[0]!;
      masked += " ".repeat(tag.length);
      index += tag.length;
      const closeIndex = sql.indexOf(tag, index);
      const bodyEnd = closeIndex === -1 ? sql.length : closeIndex;
      while (index < bodyEnd) {
        masked += sql[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (closeIndex !== -1) {
        masked += " ".repeat(tag.length);
        index += tag.length;
      }
      continue;
    }

    masked += char;
    index += 1;
  }

  return masked;
}

function normalizeSqlIdentifier(identifier: string): string {
  const parts = identifier.match(new RegExp(SQL_IDENTIFIER, "gi")) ?? [];

  return parts
    .map((part) => {
      if (part.startsWith('"') && part.endsWith('"')) {
        return part.slice(1, -1).replace(/""/g, '"').toLowerCase();
      }

      return part.toLowerCase();
    })
    .join(".");
}

function statementEnd(sql: string, start: number): number {
  const semicolon = sql.indexOf(";", start);
  if (semicolon === -1) return sql.length;
  return semicolon + 1;
}

function lineNumberAt(sql: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (sql[index] === "\n") line += 1;
  }
  return line;
}

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
