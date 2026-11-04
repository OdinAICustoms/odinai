import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Development: screens on http://localhost:5200, API calls passed to the server on 3200.
export default defineConfig({
  plugins: [react()],
  server: { port: 5200, strictPort: true, proxy: { '/api': 'http://localhost:3200' } },
  build: { outDir: 'dist', emptyOutDir: true }
});
