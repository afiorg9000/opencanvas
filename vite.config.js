import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['rembg-webgpu'],
  },
  worker: {
    format: 'es',
  },
}))
