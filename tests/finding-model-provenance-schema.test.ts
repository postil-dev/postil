import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";

import { getTableConfig } from "drizzle-orm/pg-core";

import { findingApprovals } from "@/lib/db/schema";
import provenanceSnapshot from "../drizzle/meta/0054_snapshot.json";

describe("finding model provenance schema", () => {
  test("maps explicit application names onto stable database columns", () => {
    const config = getTableConfig(findingApprovals);
    const columns = Object.fromEntries(
      config.columns.map((column) => [
        column.name,
        { notNull: column.notNull, type: column.getSQLType() },
      ]),
    );

    expect(findingApprovals.findingGeneratorModel.name).toBe("finding_model");
    expect(findingApprovals.findingScorerModel.name).toBe(
      "finding_scorer_model",
    );
    expect("findingModel" in findingApprovals).toBe(false);
    expect(columns).toMatchObject({
      finding_model: { notNull: false, type: "text" },
      finding_scorer_model: { notNull: false, type: "text" },
    });
  });

  test("records the final constraint in the current Drizzle snapshot", () => {
    const snapshot = provenanceSnapshot as {
      tables: Record<
        string,
        {
          columns: Record<string, { type: string; notNull: boolean }>;
          checkConstraints: Record<string, { value: string }>;
        }
      >;
    };
    const approvals = snapshot.tables["public.finding_approvals"]!;

    expect(approvals.columns.finding_model).toEqual(
      expect.objectContaining({ type: "text", notNull: false }),
    );
    expect(approvals.columns.finding_scorer_model).toEqual(
      expect.objectContaining({ type: "text", notNull: false }),
    );
    const dismissalCheck =
      approvals.checkConstraints.finding_approvals_dismissal_check!.value;
    expect(dismissalCheck).toContain('"finding_model" IS NOT NULL');
    expect(dismissalCheck).toContain('"finding_scorer_model" IS NULL');
  });

  test("uses one generated migration after the current main boundary", async () => {
    const migrations = (await readdir(new URL("../drizzle/", import.meta.url)))
      .filter((file) => /^005[3-4]_.*[.]sql$/.test(file))
      .sort();
    const migration = await readFile(
      new URL("../drizzle/0054_finding_model_provenance.sql", import.meta.url),
      "utf8",
    );
    const previousSnapshot = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/0053_snapshot.json", import.meta.url),
        "utf8",
      ),
    ) as { id: string };
    const snapshot = provenanceSnapshot as { id: string; prevId: string };
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(migrations).toEqual([
      "0053_wonderful_annihilus.sql",
      "0054_finding_model_provenance.sql",
    ]);
    expect(migration).toContain('ADD COLUMN "finding_scorer_model" text');
    expect(migration).not.toContain("RENAME COLUMN");
    expect(migration).toContain(
      'ADD CONSTRAINT "finding_approvals_dismissal_check_v2"',
    );
    expect(migration).toContain("NOT VALID");
    expect(migration).toContain(
      'VALIDATE CONSTRAINT "finding_approvals_dismissal_check_v2"',
    );
    expect(migration).toContain(
      'NEW."finding_scorer_model" IS DISTINCT FROM OLD."finding_scorer_model"',
    );
    expect(snapshot.prevId).toBe(previousSnapshot.id);
    expect(snapshot.id).not.toBe(previousSnapshot.id);
    expect(journal.entries.at(-1)).toEqual(
      expect.objectContaining({
        idx: 53,
        tag: "0054_finding_model_provenance",
      }),
    );
  });
});
