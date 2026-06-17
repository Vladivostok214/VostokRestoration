import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Tauri dev server — evita colisión con el workspace padre
  server: {
    port: 1420,
    strictPort: true,
    // Permite al IPC de Tauri comunicarse con el webview
    host: false,
  },

  // Vite construye para Tauri (carpeta dest estándar)
  build: {
    outDir:   'dist',
    target:   ['es2022', 'chrome105'],
    minify:   true,
    sourcemap: false,
  },

  // Resolución de alias limpia
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
