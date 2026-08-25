import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BROWSER_SCREENSHOT_CAPTURE_STAGES,
  BrowserScreenshotCaptureStageError,
  createBrowserScreenshotHostProducer,
} from "../dist-electron/electron/browserScreenshotHostCapture.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("host capture reports only fixed non-sensitive failure stages", async () => {
  assert.deepEqual(BROWSER_SCREENSHOT_CAPTURE_STAGES, [
    "authorization_lookup",
    "durable_segment_lane_check",
    "callback_identity_check",
    "vite_create",
    "vite_listen",
    "window_load",
    "window_capture",
    "cleanup",
    "publish",
    "verify",
  ]);

  for (const expectedStage of [
    "vite_create",
    "vite_listen",
    "window_load",
    "window_capture",
    "cleanup",
    "publish",
  ]) {
    const sensitiveDetail = `/private/project/${expectedStage}/secret`;
    const producer = createBrowserScreenshotHostProducer({
      async createViteServer() {
        if (expectedStage === "vite_create") throw new Error(sensitiveDetail);
        return {
          httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43140 }) },
          async listen() {
            if (expectedStage === "vite_listen") throw new Error(sensitiveDetail);
          },
          async close() {
            if (expectedStage === "cleanup") throw new Error(sensitiveDetail);
          },
        };
      },
      createBrowserWindow() {
        let destroyed = false;
        return {
          webContents: {
            ...inertBrowserSecuritySurface(),
            async capturePage() {
              if (expectedStage === "window_capture") throw new Error(sensitiveDetail);
              return { isEmpty: () => false, toPNG: () => png };
            },
          },
          async loadURL() {
            if (expectedStage === "window_load") throw new Error(sensitiveDetail);
          },
          isDestroyed: () => destroyed,
          destroy() { destroyed = true; },
        };
      },
      captureTimeoutMs: 1_000,
    });

    await assert.rejects(
      producer(
        { worktreePath: "/project" },
        async () => {
          if (expectedStage === "publish") throw new Error(sensitiveDetail);
        },
        new AbortController().signal,
      ),
      (error) => {
        assert.equal(error instanceof BrowserScreenshotCaptureStageError, true);
        assert.equal(error.stage, expectedStage);
        assert.equal(BROWSER_SCREENSHOT_CAPTURE_STAGES.includes(error.stage), true);
        assert.doesNotMatch(error.message, /private|project|secret/);
        assert.equal(error.stack, `${error.name}: ${error.message}`);
        assert.deepEqual(Object.keys(error).sort(), ["stage"]);
        return true;
      },
    );
  }
});

test("host capture uses isolated Vite cache and BrowserWindow settings, then cleans up after close", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-host-capture-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "skyturn-host-cache-root-"));
  const order = [];
  const viteConfigs = [];
  const windowOptions = [];
  const loadedUrls = [];
  const writes = [];
  let cacheDir;
  let destroyed = false;
  const server = {
    httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43123 }) },
    async listen() { order.push("listen"); },
    async close() { order.push("close-server"); },
  };
  const window = {
    webContents: {
      ...inertBrowserSecuritySurface(),
      async capturePage(...args) {
        assert.equal(args.length, 0);
        order.push("capture");
        return { isEmpty: () => false, toPNG: () => png };
      },
    },
    async loadURL(url) {
      loadedUrls.push(url);
      order.push("load");
    },
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
      order.push("destroy-window");
    },
  };
  const producer = createBrowserScreenshotHostProducer({
    async createViteServer(config) {
      viteConfigs.push(config);
      cacheDir = config.cacheDir;
      assert.equal((await stat(cacheDir)).isDirectory(), true);
      return server;
    },
    createBrowserWindow(options) {
      windowOptions.push(options);
      return window;
    },
    async removeCacheDir(directory) {
      await rm(directory, { recursive: true, force: true });
      order.push("remove-cache");
    },
    captureTimeoutMs: 1_000,
    cacheRoot,
  });

  try {
    await producer(
      { worktreePath: projectRoot },
      async (capturedPng) => {
        writes.push(capturedPng);
        order.push("publish");
      },
      new AbortController().signal,
    );

    assert.deepEqual(viteConfigs, [{
      root: projectRoot,
      configFile: false,
      plugins: [],
      appType: "spa",
      logLevel: "silent",
      clearScreen: false,
      cacheDir,
      server: { host: "127.0.0.1", port: 0, strictPort: true },
    }]);
    assert.equal(cacheDir.startsWith(`${cacheRoot}/`), true);
    assert.equal(cacheDir.startsWith(`${projectRoot}/`), false);
    await assert.rejects(stat(cacheDir), /ENOENT/);
    assert.equal(windowOptions.length, 1);
    assert.deepEqual(windowOptions[0], {
      width: 1440,
      height: 900,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: windowOptions[0].webPreferences.partition,
      },
    });
    assert.equal(typeof windowOptions[0].webPreferences.partition, "string");
    assert.equal(windowOptions[0].webPreferences.partition.startsWith("persist:"), false);
    assert.equal(Object.hasOwn(windowOptions[0].webPreferences, "preload"), false);
    assert.deepEqual(loadedUrls, ["http://127.0.0.1:43123/"]);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], png);
    assert.deepEqual(order, [
      "listen",
      "load",
      "capture",
      "destroy-window",
      "close-server",
      "remove-cache",
      "publish",
    ]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("host capture gives every BrowserWindow a unique non-persistent partition", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-host-partition-"));
  const partitions = [];
  const producer = createBrowserScreenshotHostProducer({
    async createViteServer() {
      return {
        httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43128 }) },
        async listen() {},
        async close() {},
      };
    },
    createBrowserWindow(options) {
      partitions.push(options.webPreferences.partition);
      let destroyed = false;
      return {
        webContents: {
          ...inertBrowserSecuritySurface(),
          async capturePage() { return { isEmpty: () => false, toPNG: () => png }; },
        },
        async loadURL() {},
        isDestroyed: () => destroyed,
        destroy() { destroyed = true; },
      };
    },
    captureTimeoutMs: 1_000,
  });
  try {
    await producer({ worktreePath: projectRoot }, async () => {}, new AbortController().signal);
    await producer({ worktreePath: projectRoot }, async () => {}, new AbortController().signal);

    assert.equal(partitions.length, 2);
    assert.notEqual(partitions[0], partitions[1]);
    assert.equal(partitions.every((partition) => typeof partition === "string" && !partition.startsWith("persist:")), true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("host capture waits for actual Vite close before settling or removing cache", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-host-close-"));
  const closeGate = deferred();
  const closeStarted = deferred();
  let cacheDir;
  const producer = createBrowserScreenshotHostProducer({
    async createViteServer(config) {
      cacheDir = config.cacheDir;
      return {
        httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43129 }) },
        async listen() {},
        async close() {
          closeStarted.resolve();
          await closeGate.promise;
        },
      };
    },
    createBrowserWindow() {
      let destroyed = false;
      return {
        webContents: {
          ...inertBrowserSecuritySurface(),
          async capturePage() { return { isEmpty: () => false, toPNG: () => png }; },
        },
        async loadURL() {},
        isDestroyed: () => destroyed,
        destroy() { destroyed = true; },
      };
    },
    captureTimeoutMs: 1_000,
    cleanupTimeoutMs: 10,
  });
  try {
    let settled = false;
    const capture = producer(
      { worktreePath: projectRoot },
      async () => {},
      new AbortController().signal,
    );
    void capture.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await closeStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(settled, false);
    assert.equal((await stat(cacheDir)).isDirectory(), true);
    closeGate.resolve();
    await capture;
    await assert.rejects(stat(cacheDir), /ENOENT/);
  } finally {
    closeGate.resolve();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("host capture fails closed when cache cleanup fails after Vite close", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-host-cache-cleanup-"));
  let closed = false;
  let cleanupCalls = 0;
  let publications = 0;
  const producer = createBrowserScreenshotHostProducer({
    async createViteServer() {
      return {
        httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43130 }) },
        async listen() {},
        async close() { closed = true; },
      };
    },
    createBrowserWindow() {
      let destroyed = false;
      return {
        webContents: {
          ...inertBrowserSecuritySurface(),
          async capturePage() { return { isEmpty: () => false, toPNG: () => png }; },
        },
        async loadURL() {},
        isDestroyed: () => destroyed,
        destroy() { destroyed = true; },
      };
    },
    async removeCacheDir() {
      cleanupCalls += 1;
      assert.equal(closed, true);
      throw new Error("cache cleanup failed");
    },
    captureTimeoutMs: 1_000,
  });
  try {
    await assert.rejects(
      producer(
        { worktreePath: projectRoot },
        async () => { publications += 1; },
        new AbortController().signal,
      ),
      /cache|cleanup/i,
    );
    assert.equal(cleanupCalls, 1);
    assert.equal(publications, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("host capture does not remove Vite cache when server close fails", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-host-close-failure-"));
  let cacheCleanupCalls = 0;
  const producer = createBrowserScreenshotHostProducer({
    async createViteServer() {
      return {
        httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43131 }) },
        async listen() {},
        async close() { throw new Error("close failed"); },
      };
    },
    createBrowserWindow() {
      let destroyed = false;
      return {
        webContents: {
          ...inertBrowserSecuritySurface(),
          async capturePage() { return { isEmpty: () => false, toPNG: () => png }; },
        },
        async loadURL() {},
        isDestroyed: () => destroyed,
        destroy() { destroyed = true; },
      };
    },
    async removeCacheDir() { cacheCleanupCalls += 1; },
    captureTimeoutMs: 1_000,
  });
  try {
    await assert.rejects(
      producer({ worktreePath: projectRoot }, async () => {}, new AbortController().signal),
      /cleanup|close/i,
    );
    assert.equal(cacheCleanupCalls, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("host capture rejects invalid PNG data and cleanup failures without success", async () => {
  for (const scenario of ["empty", "invalid", "cleanup"]) {
    let destroyed = 0;
    let closed = 0;
    let publications = 0;
    const producer = createBrowserScreenshotHostProducer({
      async createViteServer() {
        return {
          httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43124 }) },
          async listen() {},
          async close() {
            closed += 1;
            if (scenario === "cleanup") throw new Error("close failed");
          },
        };
      },
      createBrowserWindow() {
        return {
          webContents: {
            ...inertBrowserSecuritySurface(),
            async capturePage() {
              return {
                isEmpty: () => scenario === "empty",
                toPNG: () => scenario === "invalid" ? Buffer.from("not-png") : png,
              };
            },
          },
          async loadURL() {},
          isDestroyed: () => destroyed > 0,
          destroy() { destroyed += 1; },
        };
      },
      captureTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
    });

    await assert.rejects(
      producer(
        { worktreePath: "/project" },
        async () => { publications += 1; },
        new AbortController().signal,
      ),
      scenario === "cleanup" ? /cleanup|close/i : /PNG/i,
    );
    assert.equal(destroyed, 1, scenario);
    assert.equal(closed, 1, scenario);
    assert.equal(publications, 0, scenario);
  }
});

test("host capture abort destroys the BrowserWindow and closes Vite", async () => {
  const controller = new AbortController();
  let destroyed = 0;
  let closed = 0;
  const captureStarted = deferred();
  const producer = createBrowserScreenshotHostProducer({
    async createViteServer() {
      return {
        httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43125 }) },
        async listen() {},
        async close() { closed += 1; },
      };
    },
    createBrowserWindow() {
      return {
        webContents: {
          ...inertBrowserSecuritySurface(),
          async capturePage() {
            captureStarted.resolve();
            return await new Promise(() => undefined);
          },
        },
        async loadURL() {},
        isDestroyed: () => destroyed > 0,
        destroy() { destroyed += 1; },
      };
    },
    captureTimeoutMs: 1_000,
    cleanupTimeoutMs: 1_000,
  });

  const capture = producer(
    { worktreePath: "/project" },
    async () => assert.fail("aborted capture must not publish"),
    controller.signal,
  );
  await captureStarted.promise;
  controller.abort("cancelled");

  await assert.rejects(capture, /abort|cancel/i);
  assert.equal(destroyed, 1);
  assert.equal(closed, 1);
});

test("host capture timeout is bounded and cleans up without writing", async () => {
  let destroyed = 0;
  let closed = 0;
  const producer = createBrowserScreenshotHostProducer({
    async createViteServer() {
      return {
        httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43126 }) },
        async listen() {},
        async close() { closed += 1; },
      };
    },
    createBrowserWindow() {
      return {
        webContents: {
          ...inertBrowserSecuritySurface(),
          async capturePage() { return await new Promise(() => undefined); },
        },
        async loadURL() {},
        isDestroyed: () => destroyed > 0,
        destroy() { destroyed += 1; },
      };
    },
    captureTimeoutMs: 20,
    cleanupTimeoutMs: 1_000,
  });

  await assert.rejects(
    producer(
      { worktreePath: "/project" },
      async () => assert.fail("timed out capture must not publish"),
      new AbortController().signal,
    ),
    /abort|timed out/i,
  );
  assert.equal(destroyed, 1);
  assert.equal(closed, 1);
});

test("host capture keeps later work serialized when a queued capture is aborted", async () => {
  const firstCapture = deferred();
  const firstServerStarted = deferred();
  let serverCreations = 0;
  const producer = createBrowserScreenshotHostProducer({
    async createViteServer() {
      serverCreations += 1;
      if (serverCreations === 1) firstServerStarted.resolve();
      const current = serverCreations;
      return {
        httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43125 + current }) },
        async listen() {},
        async close() {},
      };
    },
    createBrowserWindow() {
      const current = serverCreations;
      let destroyed = false;
      return {
        webContents: {
          ...inertBrowserSecuritySurface(),
          async capturePage() {
            if (current === 1) await firstCapture.promise;
            return { isEmpty: () => false, toPNG: () => png };
          },
        },
        async loadURL() {},
        isDestroyed: () => destroyed,
        destroy() { destroyed = true; },
      };
    },
    captureTimeoutMs: 1_000,
    cleanupTimeoutMs: 1_000,
  });
  const first = producer({ worktreePath: "/project-1" }, async () => {}, new AbortController().signal);
  await firstServerStarted.promise;
  const secondController = new AbortController();
  const second = producer({ worktreePath: "/project-2" }, async () => {}, secondController.signal);
  secondController.abort("cancel queued capture");
  const third = producer({ worktreePath: "/project-3" }, async () => {}, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(serverCreations, 1);
  firstCapture.resolve();
  await Promise.all([first, assert.rejects(second, /abort|cancel/i), third]);
  assert.equal(serverCreations, 2);
});

test("host capture restricts the renderer session to its exact Vite HTTP and WebSocket origin", async () => {
  const requests = [];
  const events = new Map();
  let permissionRequestHandler;
  let permissionCheckHandler;
  let windowOpenHandler;
  let configuredBeforeLoad = false;
  let destroyed = false;
  const producer = createBrowserScreenshotHostProducer({
    async createViteServer() {
      return {
        httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43132 }) },
        async listen() {},
        async close() {},
      };
    },
    createBrowserWindow() {
      return {
        webContents: {
          session: {
            webRequest: {
              onBeforeRequest(filter, handler) {
                requests.push({ filter, handler });
              },
            },
            setPermissionRequestHandler(handler) { permissionRequestHandler = handler; },
            setPermissionCheckHandler(handler) { permissionCheckHandler = handler; },
          },
          on(event, handler) { events.set(event, handler); },
          setWindowOpenHandler(handler) { windowOpenHandler = handler; },
          async capturePage() { return { isEmpty: () => false, toPNG: () => png }; },
        },
        async loadURL() {
          configuredBeforeLoad = requests.length === 1 &&
            events.has("will-navigate") &&
            events.has("will-redirect") &&
            events.has("will-attach-webview") &&
            typeof permissionRequestHandler === "function" &&
            typeof permissionCheckHandler === "function" &&
            typeof windowOpenHandler === "function";
        },
        isDestroyed: () => destroyed,
        destroy() { destroyed = true; },
      };
    },
    captureTimeoutMs: 1_000,
  });

  await producer({ worktreePath: "/project" }, async () => {}, new AbortController().signal);

  assert.equal(configuredBeforeLoad, true);
  assert.equal(requests.length, 1);
  const requestDecision = (url) => {
    let decision;
    requests[0].handler({ url }, (response) => { decision = response; });
    return decision;
  };
  for (const url of [
    "http://127.0.0.1:43132/",
    "http://127.0.0.1:43132/src/main.tsx",
    "ws://127.0.0.1:43132/?token=vite",
  ]) {
    assert.deepEqual(requestDecision(url), { cancel: false }, url);
  }
  for (const url of [
    "http://example.com/",
    "https://example.com/",
    "ws://example.com/socket",
    "wss://example.com/socket",
    "https://127.0.0.1:43132/",
    "wss://127.0.0.1:43132/socket",
    "http://localhost:43132/",
    "http://127.0.0.1:43133/",
    "ws://127.0.0.1:43133/socket",
  ]) {
    assert.deepEqual(requestDecision(url), { cancel: true }, url);
  }

  for (const eventName of ["will-navigate", "will-redirect"]) {
    let prevented = false;
    events.get(eventName)({
      url: "https://example.com/escape",
      preventDefault() { prevented = true; },
    });
    assert.equal(prevented, true, eventName);
  }
  let sameOriginPrevented = false;
  events.get("will-navigate")({
    url: "http://127.0.0.1:43132/next",
    preventDefault() { sameOriginPrevented = true; },
  });
  assert.equal(sameOriginPrevented, false);
  assert.deepEqual(windowOpenHandler({ url: "https://example.com/popup" }), { action: "deny" });

  let webviewPrevented = false;
  events.get("will-attach-webview")({ preventDefault() { webviewPrevented = true; } }, {}, {});
  assert.equal(webviewPrevented, true);
  let permissionGranted;
  permissionRequestHandler({}, "media", (granted) => { permissionGranted = granted; }, {});
  assert.equal(permissionGranted, false);
  assert.equal(permissionCheckHandler({}, "geolocation", "http://127.0.0.1:43132", {}), false);
});

test("host capture observes abort after cleanup and before publication", async () => {
  const controller = new AbortController();
  let publications = 0;
  const producer = createBrowserScreenshotHostProducer({
    async createViteServer() {
      return {
        httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43133 }) },
        async listen() {},
        async close() {},
      };
    },
    createBrowserWindow() {
      let destroyed = false;
      return {
        webContents: {
          ...inertBrowserSecuritySurface(),
          async capturePage() { return { isEmpty: () => false, toPNG: () => png }; },
        },
        async loadURL() {},
        isDestroyed: () => destroyed,
        destroy() { destroyed = true; },
      };
    },
    async removeCacheDir(directory) {
      await rm(directory, { recursive: true, force: true });
      controller.abort("cancel before publication");
    },
    captureTimeoutMs: 1_000,
  });

  await assert.rejects(
    producer(
      { worktreePath: "/project" },
      async () => { publications += 1; },
      controller.signal,
    ),
    /abort|cancel/i,
  );
  assert.equal(publications, 0);
});

test("host capture awaits an in-flight publication before cancellation settles", async () => {
  const controller = new AbortController();
  const writeStarted = deferred();
  const writeGate = deferred();
  let settled = false;
  const producer = createBrowserScreenshotHostProducer({
    async createViteServer() {
      return {
        httpServer: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43134 }) },
        async listen() {},
        async close() {},
      };
    },
    createBrowserWindow() {
      let destroyed = false;
      return {
        webContents: {
          ...inertBrowserSecuritySurface(),
          async capturePage() { return { isEmpty: () => false, toPNG: () => png }; },
        },
        async loadURL() {},
        isDestroyed: () => destroyed,
        destroy() { destroyed = true; },
      };
    },
    captureTimeoutMs: 1_000,
  });

  const capture = producer({ worktreePath: "/project" }, async () => {
      writeStarted.resolve();
      await writeGate.promise;
    }, controller.signal);
  void capture.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await writeStarted.promise;
  controller.abort("cancel during publication");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false);
  writeGate.resolve();
  await assert.rejects(capture, /abort|cancel/i);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function inertBrowserSecuritySurface() {
  return {
    session: {
      webRequest: { onBeforeRequest() {} },
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
    },
    on() {},
    setWindowOpenHandler() {},
  };
}
