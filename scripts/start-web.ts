import { startServer } from "next/dist/server/lib/start-server";

function portFromEnv(): number {
  const value = process.env.PORT ?? "3000";
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

await startServer({
  dir: process.cwd(),
  port: portFromEnv(),
  isDev: false,
  hostname: process.env.POSTIL_BIND_HOST?.trim() || "0.0.0.0",
});
