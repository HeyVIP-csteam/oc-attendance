import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dashboard build. `npm run build` writes web/dist, which wrangler serves as static assets.
// `npm run dev:web` starts Vite on :5173 and proxies /api to `wrangler dev` on :8787.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
