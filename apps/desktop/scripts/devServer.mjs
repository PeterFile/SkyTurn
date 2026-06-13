import net from "node:net";

export const RENDERER_HOST = "127.0.0.1";
export const DEFAULT_RENDERER_PORT = 5173;

export function makeDevServerUrl(port, host = RENDERER_HOST) {
  return `http://${host}:${port}`;
}

export function rendererDevCommand(port, host = RENDERER_HOST) {
  return ["pnpm", ["exec", "vite", "--host", host, "--port", String(port), "--strictPort"]];
}

export async function findAvailablePort(startPort = DEFAULT_RENDERER_PORT, host = RENDERER_HOST) {
  for (let offset = 0; offset < 20; offset += 1) {
    const port = startPort + offset;
    if (await isPortAvailable(port, host)) return port;
  }
  throw new Error(`No available renderer port from ${startPort} to ${startPort + 19}`);
}

function isPortAvailable(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}
