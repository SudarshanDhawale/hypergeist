import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', assetsInlineLimit: 0 },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8787' } },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Vitest replaces CSS with an empty string unless the file is listed here.
    // The CSS token scan test reads stylesheets as text with `?raw`.
    css: { include: [/\.css\?raw$/] },
  },
});
