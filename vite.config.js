// Builds the dashboard plugin bundle: one IIFE (React comes from the dashboard's SDK) + style.css.
import { defineConfig } from 'vite';

export default defineConfig({
  oxc: { jsx: { runtime: 'classic', pragma: 'React.createElement', pragmaFrag: 'React.Fragment' } },
  build: {
    outDir: 'plugin/agent-office/dashboard/dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    lib: { entry: 'src/main.jsx', formats: ['iife'], name: 'AgentOffice', fileName: () => 'index.js', cssFileName: 'style' },
  },
});
