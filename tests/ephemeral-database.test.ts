import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Client } from "pg";

import { retainOrDropTestDatabase } from "./ephemeral-database";

const ORIGINAL_KEEP_DATABASE = process.env.POSTIL_TEST_KEEP_DATABASE;

async function findTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findTestFiles(path);
      return entry.isFile() && /\.test\.tsx?$/u.test(entry.name) ? [path] : [];
    }),
  );
  return paths.flat();
}

afterEach(() => {
  if (ORIGINAL_KEEP_DATABASE === undefined) {
    delete process.env.POSTIL_TEST_KEEP_DATABASE;
  } else {
    process.env.POSTIL_TEST_KEEP_DATABASE = ORIGINAL_KEEP_DATABASE;
  }
});

describe("test database retention", () => {
  test("does not issue a destructive query when retention is enabled", async () => {
    process.env.POSTIL_TEST_KEEP_DATABASE = "1";
    const queries: string[] = [];
    const admin = {
      async query(sql: string) {
        queries.push(sql);
      },
    } as unknown as Client;

    await retainOrDropTestDatabase(admin, "postil_retained_test");

    expect(queries).toEqual([]);
  });

  test("isolates mutable test schemas and routes teardown through the retention guard", async () => {
    const destructiveStatements = [
      ["DROP", "DATABASE"].join(" "),
      ["DROP", "SCHEMA"].join(" "),
    ];
    const files = (await findTestFiles(import.meta.dir))
      .filter((file) => file !== join(import.meta.dir, "ephemeral-database.test.ts"))
      .sort();
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const baseUrlAliases = [
        ...source.matchAll(
          /(?:const|let)\s+(\w+)\s*=\s*process\.env\.POSTIL_TEST_DATABASE_URL/gmu,
        ),
      ].map((match) => match[1]!);
      const hasDirectDestructiveStatement = destructiveStatements.some((statement) =>
        source.includes(statement)
      );
      const opensSharedTestDatabase =
        /connectionString\s*:\s*(?:TEST_URL|process\.env\.POSTIL_TEST_DATABASE_URL)\b/m
          .test(source) ||
        baseUrlAliases.some((alias) =>
          new RegExp(`connectionString\\s*:\\s*${alias}\\b`, "m").test(source)
        );
      const createsDatabaseDirectly = source.includes(
        ["CREATE", "DATABASE"].join(" "),
      );
      if (
        hasDirectDestructiveStatement ||
        opensSharedTestDatabase ||
        createsDatabaseDirectly
      ) {
        offenders.push(file.slice(import.meta.dir.length + 1));
      }
    }

    expect(offenders).toEqual([]);
  });
});
