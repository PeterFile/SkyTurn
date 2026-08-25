import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";

import type { BrowserWindowConstructorOptions, WebContents } from "electron";
import type { InlineConfig, ViteDevServer } from "vite" with { "resolution-mode": "import" };

export interface BrowserScreenshotHostCaptureInput {
  worktreePath: string;
}

export type BrowserScreenshotPngPublisher = (png: Buffer) => Promise<void>;

export const CANONICAL_BROWSER_SCREENSHOT_CSS =
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

export const BROWSER_SCREENSHOT_CAPTURE_STAGES = [
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
] as const;

export type BrowserScreenshotCaptureStage = typeof BROWSER_SCREENSHOT_CAPTURE_STAGES[number];

export class BrowserScreenshotCaptureStageError extends Error {
  readonly stage: BrowserScreenshotCaptureStage;

  constructor(stage: BrowserScreenshotCaptureStage) {
    super(`Host screenshot PNG capture failed at stage ${stage}.`);
    Object.defineProperty(this, "name", { value: "BrowserScreenshotCaptureStageError" });
    Object.defineProperty(this, "stack", { value: `${this.name}: ${this.message}`, configurable: true });
    this.stage = stage;
  }
}

interface CapturedImageLike {
  isEmpty(): boolean;
  toPNG(): Buffer;
}

interface BrowserWindowLike {
  webContents: Pick<WebContents, "session" | "on" | "setWindowOpenHandler"> & {
    insertCSS(css: string): Promise<string>;
    capturePage(): Promise<CapturedImageLike>;
  };
  once(event: "ready-to-show", listener: () => void): void;
  removeListener(event: "ready-to-show", listener: () => void): void;
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  destroy(): void;
}

interface ViteServerLike {
  httpServer: Pick<NonNullable<ViteDevServer["httpServer"]>, "address"> | null;
  listen(): Promise<unknown>;
  close(): Promise<unknown>;
}

interface BrowserScreenshotHostProducerDependencies {
  createBrowserWindow(options: BrowserWindowConstructorOptions): BrowserWindowLike;
  createViteServer?(config: InlineConfig): Promise<ViteServerLike>;
  allocateVitePort?(): Promise<number>;
  captureTimeoutMs?: number;
  captureSettleMs?: number;
  cacheRoot?: string;
  removeCacheDir?(cacheDir: string): Promise<void>;
}

const defaultCaptureTimeoutMs = 30_000;
const defaultCaptureSettleMs = 1_200;
const defaultCacheRoot = path.join(tmpdir(), "skyturn-browser-capture-cache");
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngIend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export function createBrowserScreenshotHostProducer(
  dependencies: BrowserScreenshotHostProducerDependencies,
): (
  input: BrowserScreenshotHostCaptureInput,
  publishPng: BrowserScreenshotPngPublisher,
  signal: AbortSignal,
) => Promise<void> {
  const createViteServer = dependencies.createViteServer ?? defaultCreateViteServer;
  const allocateVitePort = dependencies.allocateVitePort ?? allocateEphemeralLoopbackPort;
  const captureTimeoutMs = positiveTimeout(dependencies.captureTimeoutMs, defaultCaptureTimeoutMs);
  const captureSettleMs = requiredPositiveDuration(
    dependencies.captureSettleMs,
    defaultCaptureSettleMs,
    "Host screenshot capture settle duration must be a positive integer.",
  );
  const cacheRoot = dependencies.cacheRoot ?? defaultCacheRoot;
  const removeCacheDir = dependencies.removeCacheDir ?? removeCaptureCacheDir;
  let tail: Promise<void> = Promise.resolve();

  return (input, publishPng, signal) => {
    const capture = tail.then(() => {
      throwIfAborted(signal);
      return captureOnce(
        input,
        signal,
        {
          ...dependencies,
          createViteServer,
          allocateVitePort,
          publishPng,
          captureTimeoutMs,
          captureSettleMs,
          cacheRoot,
          removeCacheDir,
        },
      );
    });
    tail = capture.catch(() => undefined);
    return capture;
  };
}

async function captureOnce(
  input: BrowserScreenshotHostCaptureInput,
  outerSignal: AbortSignal,
  dependencies: Required<Pick<
    BrowserScreenshotHostProducerDependencies,
    "createBrowserWindow" | "createViteServer" | "allocateVitePort" | "captureTimeoutMs" | "captureSettleMs" | "cacheRoot" | "removeCacheDir"
  >> & { publishPng: BrowserScreenshotPngPublisher },
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Host screenshot capture timed out."), dependencies.captureTimeoutMs);
  const forwardAbort = () => controller.abort(outerSignal.reason ?? "Host screenshot capture aborted.");
  outerSignal.addEventListener("abort", forwardAbort, { once: true });
  if (outerSignal.aborted) forwardAbort();

  let server: ViteServerLike | null = null;
  let window: BrowserWindowLike | null = null;
  let cacheDir: string | null = null;
  let closeServerPromise: Promise<void> | null = null;
  let bodyError: unknown = null;
  let png: Buffer | null = null;
  const destroyWindow = (): void => {
    if (!window || window.isDestroyed()) return;
    window.destroy();
    if (!window.isDestroyed()) throw new Error("Host screenshot BrowserWindow did not close.");
  };
  const closeServer = (): Promise<void> => {
    if (!server) return Promise.resolve();
    closeServerPromise ??= Promise.resolve().then(() => server!.close()).then(() => undefined);
    return closeServerPromise;
  };
  const abortResources = (): void => {
    try {
      destroyWindow();
    } catch {}
    void closeServer().catch(() => undefined);
  };
  controller.signal.addEventListener("abort", abortResources, { once: true });

  try {
    try {
      throwIfAborted(controller.signal);
      cacheDir = await captureStage(
        "vite_create",
        () => createCaptureCacheDir(dependencies.cacheRoot, input.worktreePath),
        controller.signal,
      );
      throwIfAborted(controller.signal);
      const vitePort = await captureStage("vite_create", async () => {
        const port = await abortable(dependencies.allocateVitePort(), controller.signal);
        if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
          throw new Error("Host screenshot port allocator returned an invalid TCP port.");
        }
        return port;
      }, controller.signal);
      throwIfAborted(controller.signal);
      server = await captureStage(
        "vite_create",
        () => dependencies.createViteServer(viteConfig(input.worktreePath, cacheDir!, vitePort)),
        controller.signal,
      );
      throwIfAborted(controller.signal);
      await captureStage(
        "vite_listen",
        () => abortable(Promise.resolve(server!.listen()).then(() => undefined), controller.signal),
        controller.signal,
      );
      const url = exactLoopbackUrl(server);
      await captureStage("window_load", async () => {
        window = dependencies.createBrowserWindow(browserWindowOptions());
        restrictBrowserWindow(window, url);
        const readiness = waitForFirstPaint(window, controller.signal);
        try {
          await Promise.all([
            abortable(window.loadURL(url), controller.signal),
            readiness.promise,
          ]);
          try {
            await abortable(window.webContents.insertCSS(CANONICAL_BROWSER_SCREENSHOT_CSS), controller.signal);
          } catch {
            throw new BrowserScreenshotCaptureStageError("window_load");
          }
          await abortableDelay(dependencies.captureSettleMs, controller.signal);
        } finally {
          readiness.dispose();
        }
      }, controller.signal);
      const image = await captureStage(
        "window_capture",
        () => abortable(window!.webContents.capturePage(), controller.signal),
        controller.signal,
      );
      throwIfAborted(controller.signal);
      await captureStage("window_capture", async () => {
        if (image.isEmpty()) throw new Error("Host screenshot capture returned an empty PNG.");
        png = image.toPNG();
        if (!isValidPng(png)) throw new Error("Host screenshot capture returned an invalid PNG.");
      }, controller.signal);
    } catch (error) {
      bodyError = error;
    }

    let cleanupError: unknown = null;
    let serverClosed = server === null;
    try {
      destroyWindow();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await closeServer();
      serverClosed = true;
    } catch (error) {
      cleanupError = appendCleanupError(cleanupError, error);
    }
    if (cacheDir && serverClosed) {
      try {
        await dependencies.removeCacheDir(cacheDir);
      } catch (error) {
        cleanupError = appendCleanupError(cleanupError, error);
      }
    }
    if (cleanupError) {
      throw new BrowserScreenshotCaptureStageError("cleanup");
    }
    if (bodyError) throw bodyError;
    throwIfAborted(controller.signal);
    await captureStage("publish", async () => {
      if (!png) throw new Error("Host screenshot capture produced no PNG.");
      await dependencies.publishPng(png);
    }, controller.signal);
    throwIfAborted(controller.signal);
  } finally {
    clearTimeout(timeout);
    outerSignal.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", abortResources);
  }
}

async function captureStage<T>(
  stage: BrowserScreenshotCaptureStage,
  action: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof BrowserScreenshotCaptureStageError) throw error;
    throw new BrowserScreenshotCaptureStageError(stage);
  }
}

function appendCleanupError(current: unknown, error: unknown): unknown {
  return current
    ? new AggregateError([current, error], "Host screenshot cleanup failed.")
    : error;
}

function restrictBrowserWindow(window: BrowserWindowLike, viteUrl: string): void {
  const session = window.webContents.session;
  session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      callback({ cancel: !isAllowedViteNetworkUrl(details.url, viteUrl) });
    },
  );
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);

  const denyExternalNavigation = (event: { url: string; preventDefault(): void }): void => {
    if (!isAllowedViteHttpUrl(event.url, viteUrl)) event.preventDefault();
  };
  window.webContents.on("will-navigate", denyExternalNavigation);
  window.webContents.on("will-redirect", denyExternalNavigation);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function isAllowedViteNetworkUrl(candidate: string, viteUrl: string): boolean {
  try {
    const candidateUrl = new URL(candidate);
    const allowedUrl = new URL(viteUrl);
    if (candidateUrl.protocol === "http:") return candidateUrl.origin === allowedUrl.origin;
    return candidateUrl.protocol === "ws:" &&
      candidateUrl.hostname === allowedUrl.hostname &&
      candidateUrl.port === allowedUrl.port;
  } catch {
    return false;
  }
}

function isAllowedViteHttpUrl(candidate: string, viteUrl: string): boolean {
  try {
    const candidateUrl = new URL(candidate);
    return candidateUrl.protocol === "http:" && candidateUrl.origin === new URL(viteUrl).origin;
  } catch {
    return false;
  }
}

function viteConfig(worktreePath: string, cacheDir: string, port: number): InlineConfig {
  return {
    root: worktreePath,
    cacheDir,
    configFile: false,
    plugins: [],
    appType: "spa",
    logLevel: "silent",
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
    },
  };
}

async function allocateEphemeralLoopbackPort(): Promise<number> {
  const reservation = createNetServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reservation.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      reservation.off("error", onError);
      resolve();
    };
    reservation.once("error", onError);
    reservation.once("listening", onListening);
    reservation.listen(0, "127.0.0.1");
  });

  try {
    const address = reservation.address();
    if (!address || typeof address === "string" ||
      !Number.isSafeInteger(address.port) || address.port <= 0 || address.port > 65_535) {
      throw new Error("Host screenshot port reservation returned an invalid TCP port.");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => error ? reject(error) : resolve());
    });
  }
}

function browserWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: `skyturn-browser-capture-${randomUUID()}`,
    },
  };
}

function exactLoopbackUrl(server: ViteServerLike): string {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string" || !Number.isSafeInteger(address.port) || address.port <= 0) {
    throw new Error("Host screenshot Vite server did not bind a local port.");
  }
  return `http://127.0.0.1:${address.port}/`;
}

function isValidPng(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) &&
    value.length >= pngSignature.length + pngIend.length &&
    value.subarray(0, pngSignature.length).equals(pngSignature) &&
    value.subarray(value.length - pngIend.length).equals(pngIend);
}

async function defaultCreateViteServer(config: InlineConfig): Promise<ViteServerLike> {
  const { createServer } = await import("vite");
  return createServer(config);
}

async function createCaptureCacheDir(cacheRoot: string, worktreePath: string): Promise<string> {
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const cacheDir = await fs.mkdtemp(path.join(cacheRoot, "capture-"));
  if (isPathInside(path.resolve(worktreePath), path.resolve(cacheDir))) {
    await fs.rm(cacheDir, { recursive: true, force: true });
    throw new Error("Host screenshot Vite cache must stay outside the worktree.");
  }
  return cacheDir;
}

async function removeCaptureCacheDir(cacheDir: string): Promise<void> {
  await fs.rm(cacheDir, { recursive: true, force: true });
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function waitForFirstPaint(
  window: BrowserWindowLike,
  signal: AbortSignal,
): { promise: Promise<void>; dispose(): void } {
  let settled = false;
  let disposed = false;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    window.removeListener("ready-to-show", onReady);
    signal.removeEventListener("abort", onAbort);
  };
  const finish = (action: () => void): void => {
    if (settled) return;
    settled = true;
    dispose();
    action();
  };
  const onReady = (): void => finish(() => resolveReady?.());
  const onAbort = (): void => finish(() => rejectReady?.(abortError(signal)));
  const promise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    window.once("ready-to-show", onReady);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return { promise, dispose };
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => reject(abortError(signal)));
    const timer = setTimeout(() => finish(resolve), durationMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  const reason = typeof signal.reason === "string" && signal.reason.trim()
    ? ` ${signal.reason.trim()}`
    : "";
  return new Error(`Host screenshot capture aborted.${reason}`);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function requiredPositiveDuration(value: number | undefined, fallback: number, message: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(message);
  return value;
}
