import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Separate entry points and config: no S3 proxy, production routes, or dev credentials.
export default defineConfig({
  envDir: false,
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  build: { target: 'es2022', rollupOptions: { input: ['tests/ui/index.html', 'tests/ui/checks.html'] } },
  preview: { host: '127.0.0.1', port: 5187, strictPort: true },
});
