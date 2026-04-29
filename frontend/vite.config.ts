import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Function form required by Vite 8 / Rolldown.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/](?:react|react-dom|react-router-dom|react-router|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (/[\\/]node_modules[\\/]@mui[\\/]/.test(id) || /[\\/]node_modules[\\/]@emotion[\\/]/.test(id)) return 'vendor-mui';
          if (/[\\/]node_modules[\\/]monaco-editor[\\/]/.test(id) || /[\\/]node_modules[\\/]@monaco-editor[\\/]/.test(id)) return 'vendor-monaco';
          if (/[\\/]node_modules[\\/](?:axios|zustand|date-fns|react-hot-toast|file-saver|sql-formatter)[\\/]/.test(id)) return 'vendor-utils';
        },
      },
    },
  },
});
