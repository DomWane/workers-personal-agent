import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    // `pnpm dev:web` talks to `pnpm dev`; the agent's WebSocket needs ws:true or the
    // upgrade is answered by Vite instead of being forwarded.
    proxy: {
      '/agents': { target: 'http://localhost:8787', ws: true, changeOrigin: true },
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
})
