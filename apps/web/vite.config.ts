import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the desktop overlay can load the build from disk (file://).
  base: './',
  server: {
    // Bind to localhost only: Linaw is a local app and should not be reachable from the network.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
