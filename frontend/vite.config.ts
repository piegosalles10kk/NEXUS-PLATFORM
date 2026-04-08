import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://10kk-backend:4500',
        changeOrigin: true,
      },
      '/webhook': {
        target: 'http://10kk-backend:4500',
        changeOrigin: true,
      },
      '/gateway': {
        target: 'http://10kk-backend:4500',
        changeOrigin: true,
      },
    },
  },
})
