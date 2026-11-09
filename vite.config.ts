import { defineConfig } from 'vite';

// Cross-origin isolation so SharedArrayBuffer works for worker threads.
// The desktop app's app:// protocol sends the same headers (electron/main.cjs).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { host: true, open: true, headers: isolation },
  preview: { headers: isolation },
});
