import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Main: ESM (can import the ESM workspace packages, which stay external).
// Preload: CommonJS, one self-contained file (required for `sandbox: true`).
// Renderer: React, no Node access; shipped through the `abox-app://` protocol with a strict CSP.
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/main/index.ts') },
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: resolve(import.meta.dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') },
    },
  },
});
