import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: { rollupOptions: { input: { main: resolve(__dirname, 'web/index.html'), admin: resolve(__dirname, 'web/admin/index.html') } } }
});
