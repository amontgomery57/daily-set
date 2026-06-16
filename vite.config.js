import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Multi-page build: the game (index.html) and the gated analytics
// dashboard (dashboard.html) are separate entry points, so the dashboard
// ships its own bundle and never bloats the game.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
      },
    },
  },
})
