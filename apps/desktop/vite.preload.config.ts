import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@skyturn\/git-worktree$/,
        replacement: fileURLToPath(new URL("../../packages/git-worktree/src/index.ts", import.meta.url)),
      },
      {
        find: /^@skyturn\/project-core$/,
        replacement: fileURLToPath(new URL("../../packages/project-core/src/index.ts", import.meta.url)),
      },
    ],
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./electron/preload.ts", import.meta.url)),
      formats: ["cjs"],
      fileName: () => "preload.js",
    },
    outDir: fileURLToPath(new URL("./dist-electron/electron", import.meta.url)),
    rolldownOptions: {
      external: ["electron"],
      output: {
        codeSplitting: false,
        entryFileNames: "preload.js",
      },
    },
  },
});
