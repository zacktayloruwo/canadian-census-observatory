import { defineConfig } from 'vite'
import process from 'node:process'
import react from '@vitejs/plugin-react'

// Start downloading DuckDB-WASM (36 MB, 8 MB gzipped) from the HTML head,
// while the page is still parsing, instead of after the app bundle has loaded
// and started the DuckDB worker. The worker's own fetch of the same URL is
// then served from the HTTP cache (or joins the download in flight). The file
// name carries a content hash, so the link is injected at build time.
function preloadDuckdbWasm() {
  let base = '/'
  return {
    name: 'preload-duckdb-wasm',
    apply: 'build',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const wasm = Object.keys(ctx.bundle ?? {}).find((f) => /duckdb-eh-[^/]*\.wasm$/.test(f))
        if (!wasm) {
          this.warn('DuckDB-WASM file not found in the bundle; no preload link added')
          return html
        }
        return [{
          tag: 'link',
          attrs: { rel: 'preload', href: `${base}${wasm}`, as: 'fetch', type: 'application/wasm', crossorigin: 'anonymous' },
          injectTo: 'head-prepend',
        }]
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/; the deploy workflow
  // sets VITE_BASE to that path. Local dev and preview stay at /.
  base: process.env.VITE_BASE || "/",
  plugins: [react(), preloadDuckdbWasm()],
  build: {
    rollupOptions: {
      output: {
        // Split the heavyweight vendor libraries into their own long-lived
        // chunks so an app-code change doesn't invalidate the whole bundle.
        manualChunks: {
          echarts: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'],
          leaflet: ['leaflet', 'react-leaflet'],
          mantine: ['@mantine/core', '@mantine/hooks'],
        },
      },
    },
  },
})
