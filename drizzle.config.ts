import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Only needed for push/migrate against a live database; `generate` works offline.
    url: process.env.DATABASE_URL ?? "postgres://postil:postil@localhost:5432/postil",
  },
});
