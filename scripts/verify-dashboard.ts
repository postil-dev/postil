/**
 * Authenticated dashboard smoke test against a disposable local database.
 *
 *   POSTIL_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
 *     bun run verify:dashboard
 *
 * The script creates a database, applies the real Drizzle migration chain,
 * seeds the demo user and session, starts Next.js, and loads every authenticated
 * dashboard page over HTTP. Set POSTIL_DASHBOARD_SERVER=start after `bun run
 * build` to exercise the production server. Set
 * POSTIL_DASHBOARD_KEEP_DATABASE=1 to retain the fixture and its ignored
 * tmp/dashboard-verification/session.env for manual use.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const root = join(import.meta.dir, "..");
const stateDir = join(root, "tmp", "dashboard-verification");
const baseDatabaseUrl = process.env.POSTIL_TEST_DATABASE_URL;
const keepDatabase = process.env.POSTIL_DASHBOARD_KEEP_DATABASE === "1";
const serverMode = process.env.POSTIL_DASHBOARD_SERVER === "start" ? "start" : "dev";
const port = positiveInteger(process.env.POSTIL_DASHBOARD_PORT, 3217);
const sessionSecret = randomBytes(32).toString("base64url");
const databaseName = `postil_dashboard_verify_${process.pid}_${Date.now()}`;

if (!baseDatabaseUrl) {
  throw new Error("POSTIL_TEST_DATABASE_URL is required");
}
assertLocalDatabase(baseDatabaseUrl);

const adminClient = new Client({ connectionString: baseDatabaseUrl });
let fixtureClient: Client | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
let databaseCreated = false;

try {
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;

  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const appEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl.toString(),
    POSTIL_SESSION_SECRET: sessionSecret,
    POSTIL_OPERATOR_GITHUB_IDS: "9999001",
    POSTIL_SKIP_ENV_VALIDATION: "1",
    POSTIL_PUBLIC_URL: `http://127.0.0.1:${port}`,
  };

  await run(["bun", "run", "db:migrate"], appEnv);
  const seedOutput = await run(["bun", "run", "seed"], appEnv, true);
  const cookie = seedOutput.match(/postil_session=([^\s]+)/)?.[1];
  if (!cookie) throw new Error("seed did not emit a local dashboard session cookie");

  fixtureClient = new Client({ connectionString: databaseUrl.toString() });
  await fixtureClient.connect();
  const reviewResult = await fixtureClient.query<{ public_id: string; full_name: string }>(`
    SELECT reviews.public_id, repositories.full_name
    FROM reviews
    INNER JOIN repositories ON repositories.id = reviews.repository_id
    WHERE reviews.status = 'completed' AND reviews.silent = false
    ORDER BY reviews.id
    LIMIT 1
  `);
  const review = reviewResult.rows[0];
  if (!review) throw new Error("seed did not create a completed review with findings");
  await fixtureClient.end();
  fixtureClient = undefined;

  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "session.env"),
    `DATABASE_URL=${databaseUrl.toString()}\nPOSTIL_SESSION_SECRET=${sessionSecret}\nPOSTIL_OPERATOR_GITHUB_IDS=9999001\nPOSTIL_SKIP_ENV_VALIDATION=1\nPOSTIL_PUBLIC_URL=http://127.0.0.1:${port}\nPOSTIL_SESSION_COOKIE=postil_session=${cookie}\n`,
    { mode: 0o600 },
  );

  const nextPackage = fileURLToPath(import.meta.resolve("next/package.json"));
  const nextBin = join(dirname(nextPackage), "dist", "bin", "next");
  const serverCommand = ["node", nextBin, serverMode, "-p", String(port)];
  server = Bun.spawn(serverCommand, {
    cwd: root,
    env: appEnv,
    stdout: "inherit",
    stderr: "inherit",
  });

  const origin = `http://127.0.0.1:${port}`;
  await waitForServer(`${origin}/api/health`, server);
  const headers = { Cookie: `postil_session=${cookie}` };

  await verifyJson(`${origin}/api/auth/session`, headers, {
    authenticated: true,
    login: "demo-dev",
    dashboardHref: "/orgs/acme",
  });
  await verifyPage(`${origin}/orgs/acme`, headers, [
    "Acme Robotics",
    "Confidence distribution",
    "Recent reviews",
  ]);
  await verifyPage(`${origin}/orgs/acme/settings`, headers, [
    "Organization settings",
    "Config files",
  ]);
  await verifyPage(`${origin}/orgs/acme/billing`, headers, ["Organization billing"]);
  await verifyPage(`${origin}/reports`, headers, ["Recent reviews", "demo-dev", "Acme Robotics"]);
  await verifyPage(`${origin}/orgs/acme/runs/${review.public_id}`, headers, [
    review.full_name,
    "Summary",
    "Findings (",
  ]);
  await verifyPage(`${origin}/operator`, headers, ["Review and run ledger", "demo-dev"]);
  await verifyJsonShape(`${origin}/api/orgs/acme/reviews`, headers, (body) => {
    return Array.isArray(body) && body.length > 0;
  });
  await verifyJsonShape(
    `${origin}/api/orgs/acme/runs/${review.public_id}/logs`,
    headers,
    (body) => isRecord(body) && Array.isArray(body.lines) && body.status === "completed",
  );

  console.log(`Authenticated dashboard verification passed (${serverMode} server).`);
  if (keepDatabase) {
    console.log(`Fixture retained in ${databaseName}; session details: tmp/dashboard-verification/session.env`);
  }
} finally {
  if (server) {
    server.kill("SIGTERM");
    await Promise.race([server.exited, Bun.sleep(5_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await fixtureClient?.end().catch(() => undefined);
  if (databaseCreated && !keepDatabase) {
    await adminClient.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await rm(stateDir, { recursive: true, force: true });
  }
  await adminClient.end().catch(() => undefined);
}

async function run(
  command: string[],
  env: Record<string, string | undefined>,
  capture = false,
): Promise<string> {
  const process = Bun.spawn(command, {
    cwd: root,
    env,
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    capture ? new Response(process.stdout).text() : "",
    capture ? new Response(process.stderr).text() : "",
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})\n${stderr || stdout}`);
  }
  return stdout;
}

async function waitForServer(
  url: string,
  process: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Next.js exited with ${process.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is not listening yet.
    }
    await Bun.sleep(250);
  }
  throw new Error(`Next.js did not become ready at ${url}`);
}

async function verifyPage(
  url: string,
  headers: Record<string, string>,
  expectedContent: string[],
): Promise<void> {
  const response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (response.status !== 200) throw new Error(`${url} returned ${response.status}`);
  if (body.includes("Something failed, so we are failing closed.")) {
    throw new Error(`${url} rendered the generic error boundary`);
  }
  for (const content of expectedContent) {
    if (!body.includes(content)) throw new Error(`${url} did not render ${JSON.stringify(content)}`);
  }
  console.log(`${new URL(url).pathname}: 200, rendered ${expectedContent.join(", ")}`);
}

async function verifyJson(
  url: string,
  headers: Record<string, string>,
  expected: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (response.status !== 200 || JSON.stringify(body) !== JSON.stringify(expected)) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  console.log(`${new URL(url).pathname}: 200, authenticated demo-dev`);
}

async function verifyJsonShape(
  url: string,
  headers: Record<string, string>,
  matches: (body: unknown) => boolean,
): Promise<void> {
  const response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await response.json();
  if (response.status !== 200 || !matches(body)) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  console.log(`${new URL(url).pathname}: 200, rendered expected JSON shape`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertLocalDatabase(value: string): void {
  const hostname = new URL(value).hostname.toLowerCase();
  if (
    hostname !== "localhost" &&
    hostname !== "127.0.0.1" &&
    hostname !== "[::1]"
  ) {
    throw new Error("dashboard verification refuses a non-local database URL");
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
