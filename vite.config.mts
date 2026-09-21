import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

/** `.mts` so vite loads this as ESM (the CJS config API is deprecated), which costs us `__dirname`. */
const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * Builds the UI, and nothing else. The logic ships as the `plugin/lib/*.mjs` files themselves and
 * the server and engine run on bare node, so this is the only thing in the repo that needs a build.
 *
 * The output is one self-contained `plugin/ui/index.html`. Every byte of JS, CSS, and font is inlined
 * by `vite-plugin-singlefile`, because the plugin folder has to be installable with no build step.
 * That file is committed; `npm run check:ui` rebuilds it and fails if the committed copy has drifted.
 */
export default defineConfig({
  root: resolve(here, 'src/renderer'),
  // Relative, so nothing depends on the page being served from a particular path.
  base: './',
  resolve: {
    alias: {
      '@': resolve(here, 'src/renderer/src'),
      '@shared': resolve(here, 'src/shared'),
      '@lib': resolve(here, 'plugin/lib')
    }
  },
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: resolve(here, 'plugin/ui'),
    emptyOutDir: true,
    // Deterministic output: the committed bundle is diffed against a fresh build in CI, so anything
    // that varies run to run (a minifier's name mangling is stable, but a sourcemap comment isn't)
    // would turn that check into noise.
    sourcemap: false,
    reportCompressedSize: false
  },
  server: {
    // `npm run dev` serves the UI from vite but has no API of its own. Point it at a review server
    // you already have running (`QVAL_DEV_SERVER=http://127.0.0.1:PORT npm run dev`) and open the
    // vite URL with that server's `?t=` token. `changeOrigin` rewrites Host to the target's, which
    // the server's loopback allowlist requires.
    proxy: {
      '/api': {
        target: process.env.QVAL_DEV_SERVER || 'http://127.0.0.1:7391',
        changeOrigin: true
      }
    }
  }
})
