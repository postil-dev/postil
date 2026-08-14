import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "node:net";

const RUN_PATH =
  "/orgs/example-org/runs/11111111-2222-4333-8444-555555555555?tab=findings&severity=error";
const RETRY_PATH = "/retry-once?tab=findings&severity=error";
const FIXTURE = join(import.meta.dir, "fixtures", "auth-error-app");
const TEST_DIST_DIRECTORY = join(FIXTURE, ".next");
let serverProcess: ReturnType<typeof Bun.spawn> | undefined;
const CHROME = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find(existsSync);
const browserTest = CHROME ? test : test.skip;

afterEach(async () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await serverProcess.exited;
    serverProcess = undefined;
  }
  rmSync(TEST_DIST_DIRECTORY, { force: true, recursive: true });
  rmSync(join(FIXTURE, "next-env.d.ts"), { force: true });
});

describe("Next membership verification error rendering", () => {
  test("keeps the original URL and serialized error identity with HTTP 500", async () => {
    const port = await availablePort();
    const nextBin = fileURLToPath(import.meta.resolve("next/dist/bin/next"));
    serverProcess = Bun.spawn({
      cmd: [
        process.execPath,
        nextBin,
        "dev",
        FIXTURE,
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, NODE_ENV: "development" },
      stdout: "ignore",
      stderr: "ignore",
    });

    const requestedUrl = `http://127.0.0.1:${port}${RUN_PATH}`;
    const response = await waitForResponse(requestedUrl);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.url).toBe(requestedUrl);
    expect(body).toContain("postil-membership-verification-unavailable");
    expect(body).toContain("./app/error.tsx");
  }, 180_000);

  browserTest("renders accessible retry progress and recovers at the same URL", async () => {
    const port = await availablePort();
    const nextBin = fileURLToPath(import.meta.resolve("next/dist/bin/next"));
    serverProcess = Bun.spawn({
      cmd: [
        process.execPath,
        nextBin,
        "dev",
        FIXTURE,
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, NODE_ENV: "development" },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForResponse(`http://127.0.0.1:${port}/ready`);

    const requestedUrl = `http://127.0.0.1:${port}${RETRY_PATH}`;
    const observation = await observeRetryInChrome(requestedUrl);

    expect(observation.sawErrorUi).toBe(true);
    expect(observation.initialFocus).toBe("membership-error-heading");
    expect(observation.blockedRefreshes).toBe(0);
    expect(observation.sawCountdown).toBe(true);
    expect(observation.sawRetryPending).toBe(true);
    expect(observation.pendingFocus).toBe("main-content");
    expect(observation.recoveredText).toBe("Organization access verified.");
    expect(observation.recoveredFocus).toBe("main-content");
    expect(observation.refreshes).toBe(1);
    expect(observation.path).toBe(RETRY_PATH);
    expect(observation.countdownAnnouncements).toEqual([
      "You can try again now.",
    ]);
    expect(observation.pendingAnnouncements).toEqual([
      "You can try again now.",
      "Checking organization access.",
    ]);
  }, 180_000);
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (port === 0) throw new Error("Could not allocate a test server port");
  return port;
}

async function waitForResponse(url: string): Promise<Response> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (serverProcess && (await Promise.race([
      serverProcess.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]))) {
      throw new Error("Next test server exited before serving the error boundary");
    }
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Next test server did not become ready");
}

async function observeRetryInChrome(url: string): Promise<{
  sawErrorUi: boolean;
  sawCountdown: boolean;
  sawRetryPending: boolean;
  initialFocus: string;
  pendingFocus: string;
  recoveredFocus: string;
  blockedRefreshes: number;
  refreshes: number;
  recoveredText: string;
  path: string;
  countdownAnnouncements: string[];
  pendingAnnouncements: string[];
}> {
  if (!CHROME) throw new Error("Chrome is unavailable");
  const debuggingPort = await availablePort();
  const chromeProcess = Bun.spawn({
    cmd: [
      CHROME,
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--remote-debugging-port=${debuggingPort}`,
      "about:blank",
    ],
    stdout: "ignore",
    stderr: "ignore",
  });
  let socket: WebSocket | undefined;
  try {
    const target = await createChromeTarget(debuggingPort);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener(
        "error",
        () => reject(new Error("Chrome DevTools connection failed")),
        { once: true },
      );
    });
    const session = cdpCaller(socket);
    const call = session.call;
    await call("Runtime.enable");
    await call("Page.enable");
    await call("Network.enable");
    await call("Page.navigate", { url });

    const initial = await waitForBrowserState(
      call,
      "the membership verification error",
      (state) =>
        state.errorVisible &&
        state.activeElementId === "membership-error-heading" &&
        state.retryDisabled &&
        state.retryStatus.startsWith("Retry available in ") &&
        state.retryAnnouncement === "",
    );
    await call("Runtime.evaluate", {
      expression: `(() => {
        const target = document.getElementById('membership-retry-announcement');
        window.__postilRetryAnnouncements = [];
        new MutationObserver(() => {
          window.__postilRetryAnnouncements.push(target?.textContent?.trim() ?? '');
        }).observe(target, { childList: true, characterData: true, subtree: true });
      })()`,
    });
    session.requests.length = 0;
    await call("Runtime.evaluate", {
      expression:
        "(()=>{const button=Array.from(document.querySelectorAll('button')).find((candidate)=>candidate.textContent?.includes('Try again'));button?.click();button?.click();button?.click();})()",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const blockedRefreshes = retryRouteRequests(session.requests).length;
    await waitForBrowserState(
      call,
      "an actionable retry",
      (state) =>
        !state.retryDisabled &&
        state.retryStatus === "You can try again now." &&
        state.retryAnnouncement === "You can try again now.",
    );
    const countdownAnnouncements = await browserRetryAnnouncements(call);
    session.requests.length = 0;
    await call("Runtime.evaluate", {
      expression:
        "(()=>{const button=Array.from(document.querySelectorAll('button')).find((candidate)=>candidate.textContent?.includes('Try again'));button?.focus();button?.click();button?.click();button?.click();})()",
    });
    const pending = await waitForBrowserState(
      call,
      "pending retry progress",
      (state) =>
        state.retryPending &&
        state.retryAnnouncement === "Checking organization access." &&
        state.activeElementId === "main-content",
    );
    const pendingAnnouncements = await browserRetryAnnouncements(call);
    const recovered = await waitForBrowserState(
      call,
      "the recovered page",
      (state) => Boolean(state.recoveredText),
    );
    return {
      sawErrorUi: initial.errorVisible,
      sawCountdown: initial.retryStatus.startsWith("Retry available in "),
      sawRetryPending: pending.retryPending,
      initialFocus: initial.activeElementId,
      pendingFocus: pending.activeElementId,
      recoveredFocus: recovered.activeElementId,
      blockedRefreshes,
      refreshes: retryRouteRequests(session.requests).length,
      recoveredText: recovered.recoveredText,
      path: recovered.path,
      countdownAnnouncements,
      pendingAnnouncements,
    };
  } finally {
    socket?.close();
    chromeProcess.kill("SIGTERM");
    await chromeProcess.exited;
  }
}

interface BrowserState {
  errorVisible: boolean;
  activeElementId: string;
  retryDisabled: boolean;
  retryPending: boolean;
  retryStatus: string;
  retryAnnouncement: string;
  recoveredText: string;
  path: string;
  countdownAnnouncements: string[];
  pendingAnnouncements: string[];
}

type CdpCall = (method: string, params?: Record<string, unknown>) => Promise<any>;

async function browserRetryAnnouncements(call: CdpCall): Promise<string[]> {
  const response = await call("Runtime.evaluate", {
    expression: "window.__postilRetryAnnouncements ?? []",
    returnByValue: true,
  });
  return response.result.value as string[];
}
interface CdpSession {
  call: CdpCall;
  requests: string[];
}

async function createChromeTarget(
  port: number,
): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/json/new?about:blank`,
        { method: "PUT" },
      );
      if (response.ok) {
        return (await response.json()) as { webSocketDebuggerUrl: string };
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

function cdpCaller(socket: WebSocket): CdpSession {
  let nextId = 0;
  const requests: string[] = [];
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: { request?: { url?: string } };
      result?: unknown;
      error?: { message?: string };
    };
    if (message.method === "Network.requestWillBeSent") {
      const url = message.params?.request?.url;
      if (url) requests.push(url);
    }
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message ?? "Chrome DevTools call failed"));
    } else {
      request.resolve(message.result);
    }
  });
  return {
    requests,
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
  };
}

async function waitForBrowserState(
  call: CdpCall,
  description: string,
  accept: (state: BrowserState) => boolean,
): Promise<BrowserState> {
  const deadline = Date.now() + 20_000;
  let lastState: BrowserState | undefined;
  while (Date.now() < deadline) {
    const response = await call("Runtime.evaluate", {
      expression: `(() => {
        const heading = document.getElementById('membership-error-heading');
        const retry = Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.includes('Try')
        );
        const status = document.getElementById('membership-retry-status');
        const announcement = document.getElementById('membership-retry-announcement');
        return {
          activeElementId: document.activeElement?.id ?? '',
          errorVisible: Boolean(
            heading?.textContent?.includes('Organization access could not be verified.')
          ),
          retryDisabled: Boolean(retry?.disabled),
          retryPending: Boolean(
            retry?.disabled &&
            retry.textContent?.includes('Trying again') &&
            status?.textContent?.includes('Checking organization access.')
          ),
          retryStatus: status?.textContent?.trim() ?? '',
          retryAnnouncement: announcement?.textContent?.trim() ?? '',
          recoveredText:
            document.querySelector('[data-membership-recovered]')?.textContent ?? '',
          path: location.pathname + location.search,
        };
      })()`,
      returnByValue: true,
    });
    const state = response.result.value as BrowserState;
    lastState = state;
    if (accept(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Chrome did not observe ${description}; last state: ${JSON.stringify(lastState)}`,
  );
}

function retryRouteRequests(requests: string[]): string[] {
  return requests.filter(
    (request) => request.includes("/retry-once?") && request.includes("_rsc="),
  );
}
