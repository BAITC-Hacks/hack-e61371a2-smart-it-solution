import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Server-only override for isolated local integration environments. The browser
  // always requests /api/v1 on its own origin; no server URL is bundled into JS.
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/test-results*/**', '**/playwright-report/**'] }, proxy: { '/api': process.env.CQ_API_PROXY_TARGET ?? 'http://127.0.0.1:3001' } },
});
