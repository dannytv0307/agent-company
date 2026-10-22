import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The webview's UI. Relative asset paths: the extension turns them into webview URIs.
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  build: { outDir: '../out/webview', emptyOutDir: true },
})
