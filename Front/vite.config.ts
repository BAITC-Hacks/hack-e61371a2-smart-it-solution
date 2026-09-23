import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/test-results*/**', '**/playwright-report/**'] }, proxy: { '/api': 'http://127.0.0.1:3001' } },
});
