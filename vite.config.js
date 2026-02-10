import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { resolve } from "node:path"

// https://vite.dev/config/
export default defineConfig({
  plugins: [preact()],
  build: {
    rollupOptions: {
      input: {
        app: resolve(__dirname, "index.html"),
        pdfWorker: resolve(__dirname, "node_modules/pdfjs-dist/build/pdf.worker.mjs")
      },
      output: {
        entryFileNames: "[name].js"
      }
    }
  }
})
