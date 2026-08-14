import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "organization-switcher-menu-app");
const TEST_DIST_DIRECTORY = join(FIXTURE, ".next");
const CHROME = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find(existsSync);
let serverProcess: ReturnType<typeof Bun.spawn> | undefined;

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface MenuObservation {
  viewportWidth: number;
  documentWidth: number;
  trigger: Rect;
  menu: Rect;
  menuLeft: string;
  menuRight: string;
  activeElement: string;
}

afterEach(async () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await serverProcess.exited;
    serverProcess = undefined;
  }
  rmSync(TEST_DIST_DIRECTORY, { force: true, recursive: true });
  rmSync(join(FIXTURE, "next-env.d.ts"), { force: true });
});

describe("organization switcher menu geometry", () => {
  test("keeps the menu visible and preserves its keyboard contract across breakpoints", async () => {
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

    const observation = await observeOrganizationSwitcherInChrome(
      `http://127.0.0.1:${port}/`,
    );

    expect(observation.narrow.menu.left).toBeGreaterThanOrEqual(0);
    expect(observation.narrow.menu.right).toBeLessThanOrEqual(
      observation.narrow.viewportWidth,
    );
    expect(observation.narrow.documentWidth).toBe(observation.narrow.viewportWidth);
    expect(observation.narrow.menuLeft).toBe("0px");
    expect(observation.narrow.menu.left).toBeCloseTo(
      observation.narrow.trigger.left,
      2,
    );
    expect(observation.legacy.menu.left).toBeLessThan(0);
    expect(observation.legacy.menu.right).toBeCloseTo(
      observation.legacy.trigger.right,
      2,
    );
    expect(observation.focusAfterEscape).toBe("Switch GitHub account. Current account: RunAtlas Iceland");
    for (const tablet of [observation.tablet640, observation.tablet768]) {
      expect(tablet.menu.left).toBeGreaterThanOrEqual(0);
      expect(tablet.menu.right).toBeLessThanOrEqual(tablet.viewportWidth);
      expect(tablet.documentWidth).toBe(tablet.viewportWidth);
      expect(tablet.menuLeft).toBe("0px");
      expect(tablet.menu.left).toBeCloseTo(tablet.trigger.left, 2);
    }
    expect(observation.desktop.menu.right).toBeCloseTo(observation.desktop.trigger.right, 2);
    expect(observation.desktop.menuRight).toBe("0px");
    expect(observation.desktop.menu.left).toBeGreaterThanOrEqual(0);
    expect(observation.desktop.menu.right).toBeLessThanOrEqual(
      observation.desktop.viewportWidth,
    );
    expect(observation.desktop.documentWidth).toBe(observation.desktop.viewportWidth);
    expect(observation.keyboardFocus).toEqual([
      "/orgs/runatlas-is",
      "/reports",
      "/orgs/runatlas-is",
      "/reports",
      "/reports",
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

async function observeOrganizationSwitcherInChrome(url: string): Promise<{
  narrow: MenuObservation;
  legacy: MenuObservation;
  tablet640: MenuObservation;
  tablet768: MenuObservation;
  desktop: MenuObservation;
  focusAfterEscape: string;
  keyboardFocus: string[];
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
      "--window-size=360,800",
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
    const { call } = cdpCaller(socket);
    await call("Runtime.enable");
    await call("Page.enable");

    await setViewport(call, 360, 800);
    await call("Page.navigate", { url });
    await waitForMenuToggle(call);
    const narrow = await openAndObserveMenu(call);

    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    const focusAfterEscape = await waitForFocusAfterEscape(call);

    await call("Runtime.evaluate", {
      expression: `(() => {
        const menu = document.querySelector('[role="menu"]');
        menu?.classList.remove('left-0', 'right-auto');
        menu?.classList.add('right-0');
      })()`,
    });
    const legacy = await openAndObserveMenu(call);

    await call("Runtime.evaluate", {
      expression: `(() => {
        const menu = document.querySelector('[role="menu"]');
        menu?.classList.remove('right-0');
        menu?.classList.add('left-0', 'right-auto');
      })()`,
    });
    await setViewport(call, 640, 800);
    const tablet640 = await observeOpenMenu(call);
    await setViewport(call, 768, 800);
    const tablet768 = await observeOpenMenu(call);
    await setViewport(call, 1024, 800);
    const desktop = await observeOpenMenu(call);

    await dispatchKey(call, "Escape", "Escape");
    await waitForFocusAfterEscape(call);
    await dispatchKey(call, "ArrowDown", "ArrowDown");
    const keyboardFocus = [await waitForFocusedMenuItem(call, "/orgs/runatlas-is")];
    await dispatchKey(call, "End", "End");
    keyboardFocus.push(await waitForFocusedMenuItem(call, "/reports"));
    await dispatchKey(call, "Home", "Home");
    keyboardFocus.push(await waitForFocusedMenuItem(call, "/orgs/runatlas-is"));
    await dispatchKey(call, "ArrowUp", "ArrowUp");
    keyboardFocus.push(await waitForFocusedMenuItem(call, "/reports"));
    await dispatchKey(call, "Escape", "Escape");
    await waitForFocusAfterEscape(call);
    await dispatchKey(call, "ArrowUp", "ArrowUp");
    keyboardFocus.push(await waitForFocusedMenuItem(call, "/reports"));

    return {
      narrow,
      legacy,
      tablet640,
      tablet768,
      desktop,
      focusAfterEscape,
      keyboardFocus,
    };
  } finally {
    socket?.close();
    chromeProcess.kill("SIGTERM");
    await chromeProcess.exited;
  }
}

async function setViewport(call: CdpCall, width: number, height: number): Promise<void> {
  await call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function waitForMenuToggle(call: CdpCall): Promise<void> {
  await waitForBrowserValue(call, "the organization switcher trigger", () => {
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="menu"]',
    );
    return trigger?.getAttribute("aria-expanded") === "false";
  });
}

async function openAndObserveMenu(call: CdpCall): Promise<MenuObservation> {
  const trigger = await waitForBrowserValue(call, "the hydrated organization trigger", () => {
    const button = document.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
    if (!button || document.readyState !== "complete") return undefined;
    const box = button.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: trigger.x,
    y: trigger.y,
    button: "left",
    clickCount: 1,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: trigger.x,
    y: trigger.y,
    button: "left",
    clickCount: 1,
  });
  return observeOpenMenu(call);
}

async function observeOpenMenu(call: CdpCall): Promise<MenuObservation> {
  return waitForBrowserValue(call, "the organization menu", () => {
    const trigger = document.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    if (!trigger || !menu || menu.hidden) return undefined;
    const rect = (element: HTMLElement): Rect => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };
    const menuStyle = getComputedStyle(menu);
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      trigger: rect(trigger),
      menu: rect(menu),
      menuLeft: menuStyle.left,
      menuRight: menuStyle.right,
      activeElement: document.activeElement?.getAttribute("aria-label") ?? "",
    };
  });
}

async function waitForFocusAfterEscape(call: CdpCall): Promise<string> {
  return waitForBrowserValue(call, "focus to return to the organization trigger", () => {
    const trigger = document.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    if (!trigger || !menu?.hidden || document.activeElement !== trigger) return undefined;
    return trigger.getAttribute("aria-label") ?? "";
  });
}

async function waitForFocusedMenuItem(call: CdpCall, expectedPath: string): Promise<string> {
  const focusedPath = await waitForBrowserValue(call, "focus on a menu item", () => {
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    const active = document.activeElement;
    if (menu?.hidden || !(active instanceof HTMLAnchorElement)) return undefined;
    return new URL(active.href).pathname;
  });
  if (focusedPath !== expectedPath) {
    throw new Error(`Expected menu focus on ${expectedPath}, received ${focusedPath}`);
  }
  return focusedPath;
}

async function dispatchKey(
  call: CdpCall,
  key: string,
  code: string,
): Promise<void> {
  await call("Runtime.evaluate", {
    expression: `(() => {
      const target = document.activeElement;
      if (!target) throw new Error('No focused element received the keyboard event');
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        code: ${JSON.stringify(code)},
        bubbles: true,
        cancelable: true,
      }));
      target.dispatchEvent(new KeyboardEvent('keyup', {
        key: ${JSON.stringify(key)},
        code: ${JSON.stringify(code)},
        bubbles: true,
        cancelable: true,
      }));
    })()`,
  });
}

type CdpCall = (method: string, params?: Record<string, unknown>) => Promise<any>;

async function waitForBrowserValue<T>(
  call: CdpCall,
  description: string,
  inspect: () => T | undefined,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    const response = await call("Runtime.evaluate", {
      expression: `(${inspect.toString()})()`,
      returnByValue: true,
    });
    lastValue = response.result.value as T | undefined;
    if (lastValue !== undefined) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chrome did not observe ${description}; last state: ${JSON.stringify(lastValue)}`);
}

async function createChromeTarget(
  port: number,
): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: "PUT",
      });
      if (response.ok) return (await response.json()) as { webSocketDebuggerUrl: string };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

function cdpCaller(socket: WebSocket): { call: CdpCall } {
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
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
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
  };
}
