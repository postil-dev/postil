import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL_UNPOOLED ??
      process.env.NEON_CONNECTION_STRING ??
      process.env.DATABASE_URL ??
      "",
  },
  strict: true,
  verbose: true,
});
