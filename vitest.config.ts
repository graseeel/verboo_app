import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'

const rendererRoot = resolve(__dirname, 'src/renderer')

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/renderer/test/setup.ts'],
    include: ['src/renderer/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist-renderer', 'out', 'release'],
  },
  resolve: {
    alias: {
      // Keep aliases consistent with the renderer source tree.
      '@renderer': rendererRoot,
    },
  },
})
