import { defineConfig } from "electron-vite"
import { resolve } from "pathe"

import { getGitHash } from "../../scripts/lib"
import rendererConfig from "./configs/vite.electron-render.config"

// defuddle/linkedom must stay external — bundling them triggers misplaced CJS shims
// and breaks vite:esbuild-transpile with "Unexpected __cjs_mod__".
const mainProcessExternals = ["defuddle", "defuddle/node", "linkedom"] as const

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      lib: {
        entry: "./layer/main/src/index.ts",
      },
      rollupOptions: {
        external: [...mainProcessExternals],
      },
    },
    ssr: {
      external: [...mainProcessExternals],
    },
    resolve: {
      alias: {
        "@shared": resolve("packages/shared/src"),
        "@pkg": resolve("./package.json"),
        "@locales": resolve("../../locales"),
        "~": resolve("./layer/main/src"),
        "utf-8-validate": resolve("./layer/main/src/shims/utf-8-validate.cjs"),
      },
    },
    define: {
      ELECTRON: "true",
      GIT_COMMIT_HASH: JSON.stringify(getGitHash()),
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      lib: {
        entry: "./layer/main/preload/index.ts",
      },
    },
    resolve: {
      alias: {
        "@pkg": resolve("./package.json"),
        "@locales": resolve("../../locales"),
      },
    },
  },
  renderer: rendererConfig,
})
