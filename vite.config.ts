import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `--mode single` inlines everything into one HTML file (used for the shareable preview).
// `npm run dev` passes ACS_API_KEY from .env to the page so ACS models work with no setup. Only the
// dev server does: a build always gets '', so the key can't be shipped in a deployed bundle.
export default defineConfig(({ mode, command }) => ({
  base: './',
  define: {
    __DEV_ACS_KEY__: JSON.stringify(command === 'serve' ? (loadEnv(mode, process.cwd(), '').ACS_API_KEY ?? '') : ''),
  },
  plugins: [react(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  build: { outDir: mode === 'single' ? 'dist-single' : 'dist' },
  // the model worker pulls in transformers.js, which splits into chunks
  worker: { format: 'es' },
}));
