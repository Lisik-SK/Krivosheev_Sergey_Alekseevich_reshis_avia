import { defineConfig } from 'vite';

const apiPort = process.env.PORT ?? '3000';

export default defineConfig({
  root: 'src/client',
  publicDir: 'public',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
});
