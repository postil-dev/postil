const EDGE_ARTIFACT = /(^|\/)(edge|middleware)([^/]*)(\/|$)/i;
const NODE_ONLY_SENTINELS = [
  "POSTHOG_ERROR_CAPTURE",
  "postil_model_incident",
  "PostilOperationalError",
  "postil-operational",
  "job_permanently_failed",
] as const;

const files = Array.from(
  new Bun.Glob("**/*").scanSync({ cwd: ".next/server", onlyFiles: true }),
).filter((path) => EDGE_ARTIFACT.test(path) && /\.(?:js|json|map)$/.test(path));

for (const path of files) {
  const contents = await Bun.file(`.next/server/${path}`).text();
  for (const sentinel of NODE_ONLY_SENTINELS) {
    if (contents.includes(sentinel)) {
      throw new Error(
        `Node-only observability marker ${sentinel} leaked into Edge artifact ${path}`,
      );
    }
  }
}

console.log(`Verified ${files.length} Edge artifacts exclude Node-only observability code.`);

const reservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("reserved"),
});
const port = reservation.port;
await reservation.stop(true);
const bootProbe = crypto.randomUUID();

const server = Bun.spawn(
  [
    process.execPath,
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      DATABASE_URL: "postgres://127.0.0.1/postil",
      GITHUB_OAUTH_CLIENT_ID: "build-probe-client",
      GITHUB_OAUTH_CLIENT_SECRET: crypto.randomUUID(),
      GITHUB_WEBHOOK_SECRET: crypto.randomUUID(),
      HOME: process.env.HOME ?? "/tmp",
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      // Do not pre-seed POSTIL_BOOT_PROBE_READY. The Node instrumentation
      // hook sets it after startup registration, and the health header below
      // proves that the built server actually ran that hook.
      POSTIL_BOOT_PROBE: bootProbe,
      POSTIL_PUBLIC_URL: "https://postil.invalid",
      POSTIL_SEALING_KEY: crypto.randomUUID().replaceAll("-", "").repeat(2),
      POSTIL_SESSION_SECRET: crypto.randomUUID(),
      POSTIL_WEBHOOK_DRAIN_ENABLED: "0",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  },
);
const MAX_OUTPUT_CHARACTERS = 4_000;
function collectOutput(stream: ReadableStream<Uint8Array>): {
  cancel: () => Promise<void>;
  text: Promise<string>;
} {
  const reader = stream.getReader();
  return {
    cancel: async () => {
      await reader.cancel();
    },
    text: (async () => {
      const decoder = new TextDecoder();
      let output = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output = `${output}${decoder.decode(value, { stream: true })}`.slice(
          -MAX_OUTPUT_CHARACTERS,
        );
      }
      return `${output}${decoder.decode()}`.slice(-MAX_OUTPUT_CHARACTERS);
    })(),
  };
}
const stdout = collectOutput(server.stdout);
const stderr = collectOutput(server.stderr);

let healthy = false;
for (let attempt = 0; attempt < 100 && server.exitCode === null; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      healthy =
        body.ok === true &&
        body.service === "web" &&
        response.headers.get("x-postil-boot-probe") === bootProbe &&
        server.exitCode === null;
      if (healthy) break;
    } else {
      await response.body?.cancel();
    }
  } catch {
    // The production server is still starting.
  }
  await Bun.sleep(100);
}

if (healthy) await Bun.sleep(100);
const exitedBeforeTeardown = server.exitCode !== null;

function signalServer(signal: NodeJS.Signals): boolean {
  if (process.platform !== "win32") {
    try {
      process.kill(-server.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }
  if (server.exitCode !== null) return false;
  server.kill(signal);
  return true;
}

function serverGroupIsRunning(): boolean {
  if (process.platform === "win32") return server.exitCode === null;
  try {
    process.kill(-server.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForServerGroup(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (serverGroupIsRunning() && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  return !serverGroupIsRunning();
}

async function terminateServer(): Promise<boolean> {
  if (process.platform === "win32") {
    if (server.exitCode !== null) return false;
    const taskkill = Bun.spawn(
      ["taskkill", "/PID", String(server.pid), "/T", "/F"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const taskkillExit = await Promise.race([
      taskkill.exited,
      Bun.sleep(2_000).then(() => null),
    ]);
    if (taskkillExit !== 0) {
      if (taskkill.exitCode === null) {
        taskkill.kill("SIGKILL");
        const taskkillStopped = await Promise.race([
          taskkill.exited.then(() => true),
          Bun.sleep(500).then(() => false),
        ]);
        if (!taskkillStopped) taskkill.unref();
      }
      if (server.exitCode === null) {
        server.kill("SIGKILL");
        const serverStopped = await Promise.race([
          server.exited.then(() => true),
          Bun.sleep(500).then(() => false),
        ]);
        if (!serverStopped) server.unref();
      }
      return false;
    }
    const serverStopped = await Promise.race([
      server.exited.then(() => true),
      Bun.sleep(2_000).then(() => false),
    ]);
    if (!serverStopped) {
      if (server.exitCode === null) server.kill("SIGKILL");
      const serverReaped = await Promise.race([
        server.exited.then(() => true),
        Bun.sleep(500).then(() => false),
      ]);
      if (!serverReaped) server.unref();
    }
    return serverStopped;
  }

  if (!serverGroupIsRunning() || !signalServer("SIGTERM")) return false;
  const stopped = await waitForServerGroup(2_000);
  if (stopped) return true;

  if (!signalServer("SIGKILL")) return false;
  const killed = await waitForServerGroup(2_000);
  if (!killed) throw new Error("Production server did not stop after SIGKILL.");
  return true;
}

const terminatedByProbe = await terminateServer();
let outputTimeout: ReturnType<typeof setTimeout> | undefined;
const outputTimeoutPromise = new Promise<never>((_, reject) => {
  outputTimeout = setTimeout(() => {
    reject(new Error("Production server output pipes did not close after teardown."));
    void Promise.allSettled([stdout.cancel(), stderr.cancel()]);
  }, 2_000);
});
let output: string;
try {
  output = await Promise.race([
    Promise.all([stdout.text, stderr.text]).then(([out, err]) =>
      `${out}\n${err}`.trim(),
    ),
    outputTimeoutPromise,
  ]);
} finally {
  clearTimeout(outputTimeout);
}
if (
  !healthy ||
  exitedBeforeTeardown ||
  !terminatedByProbe ||
  output.includes("instrumentation hook")
) {
  throw new Error(
    `Production server failed its boot probe.${output ? `\n${output}` : ""}`,
  );
}

console.log("Verified the production server loads instrumentation and serves health.");

export {};
