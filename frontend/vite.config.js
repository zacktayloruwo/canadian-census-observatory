import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/; the deploy workflow
  // sets VITE_BASE to that path. Local dev and preview stay at /.
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
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
