import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

// Publish compressed immutable assets once, rather than spending VPS CPU per request.
function compressedAssets(): Plugin {
  let output = '';
  return {
    name: 'nightstudy-precompressed-assets',
    apply: 'build',
    configResolved(config) {
      output = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const assets = path.join(output, 'assets');
      await Promise.all(
        (await fs.readdir(assets))
          .filter((name) => /\.(?:js|css|svg)$/.test(name))
          .map(async (name) => {
            const file = path.join(assets, name),
              bytes = await fs.readFile(file);
            if (bytes.length < 1024) return;
            const [br, gz] = await Promise.all([
              promisify(brotliCompress)(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }),
              promisify(gzip)(bytes, { level: 9 }),
            ]);
            await Promise.all([fs.writeFile(`${file}.br`, br), fs.writeFile(`${file}.gz`, gz)]);
          }),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), compressedAssets()],
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
