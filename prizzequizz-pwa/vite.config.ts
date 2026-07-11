import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  preview: { port: 4173 },
  build: {
    target: 'es2020',
    sourcemap: true,
    cssCodeSplit: true
  }
});
