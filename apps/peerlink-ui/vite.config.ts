import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // a fixed port, since the page's own URL is the Dropbox redirect URI
  // registered for it (http://localhost:5180/)
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
})
