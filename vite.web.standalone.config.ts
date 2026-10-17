import { markdownParserAliases } from './config/build-plugins/markdown-parser-exports'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createPdfjsViewerAssetsPlugin } from './config/build-plugins/pdfjs-viewer-assets'
import { createViteCacheRetentionPlugin } from './config/build-plugins/vite-cache-retention'
import { resolveBuildSourceCommit } from './config/scripts/build-source-commit.mjs'

// Vite config for the standalone, self-hostable Orca web IDE. Mirrors
// vite.web.config.ts but emits to out/web-standalone from a standalone HTML
// entry that boots App without the desktop host pairing flow.
//
// Assets use base './' so the build can be served at any reverse-proxy path
// prefix (e.g. https://example.com/orca/web-ide/).

export default defineConfig({
  root: resolve('src/renderer'),
  cacheDir: resolve('.cache/vite/web-standalone'),
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    createPdfjsViewerAssetsPlugin(),
    createViteCacheRetentionPlugin()
  ],
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true',
    ORCA_BUILD_COMMIT: JSON.stringify(resolveBuildSourceCommit()),
    ORCA_WEB_STANDALONE: 'true'
  },
  resolve: {
    alias: {
      ...markdownParserAliases,
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  build: {
    outDir: resolve('out/web-standalone'),
    emptyOutDir: true,
    reportCompressedSize: false,
    rollupOptions: {
      input: resolve('src/renderer/src/web-standalone-index.html')
    }
  },
  worker: {
    format: 'es'
  }
})
