import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

const reactRefreshPreamble = [
  'import { injectIntoGlobalHook } from "/@react-refresh";',
  "injectIntoGlobalHook(window);",
  "window.$RefreshReg$ = () => {};",
  "window.$RefreshSig$ = () => (type) => type;",
].join("\n");

function desktopReactRefreshPreamble(): PluginOption {
  return {
    name: "skyturn:desktop-react-refresh-preamble",
    apply: "serve",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        if (html.includes("window.$RefreshSig$")) return [];

        return [
          {
            tag: "script",
            attrs: { type: "module" },
            children: reactRefreshPreamble,
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), desktopReactRefreshPreamble()],
  resolve:
    command === "serve"
      ? {
          alias: [
            {
              find: /^@skyturn\/ui-canvas$/,
              replacement: fileURLToPath(new URL("../../packages/ui-canvas/src/index.ts", import.meta.url)),
            },
          ],
        }
      : undefined,
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
}));
