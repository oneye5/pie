import { defineConfig } from 'vite';
import tailwindcssPostcss from '@tailwindcss/postcss';
import * as path from 'node:path';
import * as url from 'node:url';

const rootDir = path.dirname(url.fileURLToPath(import.meta.url));
const srcDir = path.join(rootDir, 'src');
const outDir = path.join(rootDir, 'out', 'webview', 'panel');

export default defineConfig({
  root: srcDir,
  publicDir: false,
  build: {
    target: 'es2022',
    outDir,
    emptyOutDir: true,
    manifest: true,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: path.join(srcDir, 'webview', 'panel', 'panel.tsx'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  css: {
    postcss: {
      plugins: [tailwindcssPostcss()],
    },
  },
  resolve: {
    alias: {
      '@shared': path.join(srcDir, 'shared'),
    },
  },
});
