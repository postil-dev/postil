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
  await seedMorgaesisBillingFixture(fixtureClient);
  await seedRepositoryHealthFixture(fixtureClient);
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

  const grantOutput = await run(
    [
      "bun",
      "run",
      "billing:grant-credit",
      "--",
      "--org",
      "morgaesis",
      "--confirm-org",
      "morgaesis",
      "--amount",
      "200",
      "--reason",
      "Owner launch credit",
      "--actor",
      "dashboard-verification",
      "--idempotency-key",
      "morgaesis-2026-07-owner-credit",
      "--applies-at",
      "2026-07-01T00:00:00.000Z",
    ],
    appEnv,
    true,
  );
  assertContains(grantOutput, "Billing credit grant applied.");
  assertContains(grantOutput, "grant_amount=$200.00");
  assertContains(grantOutput, "usage_charged=$1.305");
  assertContains(grantOutput, "remaining=$198.695");
  assertContains(grantOutput, "charged_usage_events=1");
  console.log("morgaesis billing credit grant: $200.00 granted, $1.305 charged, $198.695 remaining");

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
    dashboardHref: "/reports",
    hasActiveInstallation: true,
  });
  await verifyPage(`${origin}/orgs/acme`, headers, [
    "Acme Robotics",
    "Confidence distribution",
    "Recent reviews",
    "Enabled but never reviewed.",
    "acme/unreached",
    ".postil.yaml",
  ]);
  await verifyPage(`${origin}/orgs/acme/settings`, headers, [
    "Organization settings",
    "Config files",
    "Enabled but never reviewed.",
    "acme/unreached",
    "pending",
    "set up but not yet exercised",
    "never reviewed",
  ]);
  await verifyPage(`${origin}/orgs/acme/billing`, headers, ["Organization billing"]);
  await verifyPage(`${origin}/orgs/morgaesis/billing`, headers, [
    "Credit balance",
    "$198.695",
    "$200.00",
    "$1.305",
    "charged across",
    "Owner launch credit",
    "morgaesis-2026-07-owner-credit",
  ]);
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

async function seedMorgaesisBillingFixture(client: Client): Promise<void> {
  await client.query(`
    WITH owner AS (
      SELECT id FROM users WHERE login = 'demo-dev' LIMIT 1
    ),
    org AS (
      INSERT INTO organizations (slug, name, github_org_id, plan)
      VALUES ('morgaesis', 'Morgaesis', 9999200, 'beta')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    ),
    membership AS (
      INSERT INTO org_members (org_id, user_id, role)
      SELECT org.id, owner.id, 'admin'
      FROM org, owner
      ON CONFLICT DO NOTHING
      RETURNING id
    ),
    installation AS (
      INSERT INTO installations (github_installation_id, org_id, account_login, account_type)
      SELECT 555002, org.id, 'morgaesis', 'Organization'
      FROM org
      ON CONFLICT (github_installation_id) DO UPDATE SET org_id = EXCLUDED.org_id
      RETURNING id, org_id
    ),
    repository AS (
      INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
      SELECT installation.id, 778000, 'morgaesis/postil', true, true
      FROM installation
      ON CONFLICT (github_repo_id) DO UPDATE SET installation_id = EXCLUDED.installation_id
      RETURNING id, github_repo_id, full_name, private
    ),
    enablement AS (
      INSERT INTO repository_enablement_events (
        org_id,
        repository_id,
        github_repo_id,
        repository_full_name,
        repository_private,
        action,
        source,
        occurred_at
      )
      SELECT
        installation.org_id,
        repository.id,
        repository.github_repo_id,
        repository.full_name,
        repository.private,
        'enable',
        'migration_baseline',
        '2026-07-01T00:00:00.000Z'::timestamptz
      FROM installation, repository
      RETURNING id
    ),
    review AS (
      INSERT INTO reviews (
        repository_id,
        pr_number,
        head_sha,
        base_sha,
        status,
        silent,
        gate_failing,
        queued_at,
        started_at,
        finished_at
      )
      SELECT
        repository.id,
        200,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'completed',
        true,
        false,
        '2026-07-11T11:00:00.000Z'::timestamptz,
        '2026-07-11T11:00:05.000Z'::timestamptz,
        '2026-07-11T11:00:30.000Z'::timestamptz
      FROM repository
      RETURNING id, repository_id
    )
    INSERT INTO usage_events (
      org_id,
      repository_id,
      review_id,
      prompt_tokens,
      completion_tokens,
      model_used,
      cost_micros,
      cost_cents,
      created_at
    )
    SELECT
      installation.org_id,
      review.repository_id,
      review.id,
      2000000,
      500000,
      'deepseek/deepseek-v4-pro',
      1305000,
      131,
      '2026-07-11T12:00:00.000Z'::timestamptz
    FROM installation, review;
  `);
}

async function seedRepositoryHealthFixture(client: Client): Promise<void> {
  await client.query(`
    WITH installation AS (
      SELECT installations.id, installations.org_id
      FROM installations
      INNER JOIN organizations ON organizations.id = installations.org_id
      WHERE organizations.slug = 'acme'
      LIMIT 1
    ),
    repository AS (
      INSERT INTO repositories (
        installation_id,
        github_repo_id,
        full_name,
        private,
        enabled,
        created_at
      )
      SELECT
        installation.id,
        777099,
        'acme/unreached',
        true,
        true,
        now() - interval '10 days'
      FROM installation
      ON CONFLICT (github_repo_id) DO UPDATE SET enabled = true
      RETURNING id, github_repo_id, full_name, private
    ),
    enablement AS (
      INSERT INTO repository_enablement_events (
        org_id,
        repository_id,
        github_repo_id,
        repository_full_name,
        repository_private,
        action,
        source,
        occurred_at
      )
      SELECT
        installation.org_id,
        repository.id,
        repository.github_repo_id,
        repository.full_name,
        repository.private,
        'enable',
        'migration_baseline',
        now() - interval '10 days'
      FROM installation, repository
      RETURNING id
    )
    INSERT INTO repo_config_probes (repository_id, probed_at, ok, files)
    SELECT repository.id, now(), true, ARRAY['.postil.yaml']::text[]
    FROM repository
    ON CONFLICT (repository_id) DO UPDATE SET
      probed_at = EXCLUDED.probed_at,
      ok = EXCLUDED.ok,
      files = EXCLUDED.files
  `);
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

function assertContains(value: string, expected: string): void {
  if (!value.includes(expected)) {
    throw new Error(`expected command output to contain ${JSON.stringify(expected)}; got ${value}`);
  }
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
