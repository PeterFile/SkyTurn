import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import type { BrowserWindowConstructorOptions, WebContents } from "electron";
import type { InlineConfig, ViteDevServer } from "vite" with { "resolution-mode": "import" };

export interface BrowserScreenshotHostCaptureInput {
  worktreePath: string;
}

export type BrowserScreenshotPngPublisher = (png: Buffer) => Promise<void>;

interface CapturedImageLike {
  isEmpty(): boolean;
  toPNG(): Buffer;
}

interface BrowserWindowLike {
  webContents: Pick<WebContents, "session" | "on" | "setWindowOpenHandler"> & {
    capturePage(): Promise<CapturedImageLike>;
  };
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
  captureTimeoutMs?: number;
  cacheRoot?: string;
  removeCacheDir?(cacheDir: string): Promise<void>;
}

const defaultCaptureTimeoutMs = 30_000;
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
  const captureTimeoutMs = positiveTimeout(dependencies.captureTimeoutMs, defaultCaptureTimeoutMs);
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
          publishPng,
          captureTimeoutMs,
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
    "createBrowserWindow" | "createViteServer" | "captureTimeoutMs" | "cacheRoot" | "removeCacheDir"
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
      cacheDir = await createCaptureCacheDir(dependencies.cacheRoot, input.worktreePath);
      throwIfAborted(controller.signal);
      server = await dependencies.createViteServer(viteConfig(input.worktreePath, cacheDir));
      throwIfAborted(controller.signal);
      await abortable(Promise.resolve(server.listen()).then(() => undefined), controller.signal);
      const url = exactLoopbackUrl(server);
      window = dependencies.createBrowserWindow(browserWindowOptions());
      restrictBrowserWindow(window, url);
      await abortable(window.loadURL(url), controller.signal);
      const image = await abortable(window.webContents.capturePage(), controller.signal);
      throwIfAborted(controller.signal);
      if (image.isEmpty()) throw new Error("Host screenshot capture returned an empty PNG.");
      png = image.toPNG();
      if (!isValidPng(png)) throw new Error("Host screenshot capture returned an invalid PNG.");
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
      throw new Error("Host screenshot cleanup failed.", {
        cause: bodyError ? new AggregateError([bodyError, cleanupError]) : cleanupError,
      });
    }
    if (bodyError) throw bodyError;
    throwIfAborted(controller.signal);
    if (!png) throw new Error("Host screenshot capture produced no PNG.");
    await dependencies.publishPng(png);
    throwIfAborted(controller.signal);
  } finally {
    clearTimeout(timeout);
    outerSignal.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", abortResources);
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

function viteConfig(worktreePath: string, cacheDir: string): InlineConfig {
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
      port: 0,
      strictPort: true,
    },
  };
}

function browserWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
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
