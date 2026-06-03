import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { resolve } from "node:path"
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'Redactr - Online PDF Redaction',
        short_name: 'Redactr',
        description: 'Redact sensitive information from PDFs entirely in your browser.',
        theme_color: '#ffffff',
        icons: [
          {
            src: 'android-chrome-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,mjs}'],
        // Increase the maximum file size for caching (e.g., for large pdfjs-dist chunks)
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      }
    })
  ],
  build: {
    minify: "none",
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
