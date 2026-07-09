import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const rendererRoot = resolve(__dirname, 'src/renderer')

export default defineConfig({
  root: rendererRoot,
  plugins: [react()],
  server: {
    port: 5183,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(rendererRoot, 'index.html'),
    },
  },
})
