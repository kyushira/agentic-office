// Local test page that stands in for the Hermes dashboard (real React + the plugin bundle).
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'dev',
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
