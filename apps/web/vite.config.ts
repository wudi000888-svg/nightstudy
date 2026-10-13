import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5198', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:5198', changeOrigin: false },
      '/setup': {
        target: 'http://127.0.0.1:5198',
        changeOrigin: false,
        bypass(req) {
          if (req.method === 'GET') return '/index.html';
        },
      },
    },
  },
});
