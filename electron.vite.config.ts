import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias }
  },
  preload: {
    // Sandboxed preloads can't require node_modules, so bundle what they use.
    plugins: [externalizeDepsPlugin({ exclude: ['electron-chrome-extensions'] })],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          page: resolve(__dirname, 'src/preload/page.ts')
        }
      }
    }
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          chrome: resolve(__dirname, 'src/renderer/chrome.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          autofill: resolve(__dirname, 'src/renderer/autofill.html'),
          pip: resolve(__dirname, 'src/renderer/pip.html')
        }
      }
    }
  }
})
