import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The dev proxy is not a convenience; it is what makes the browser's origin the
 * same origin the API believes it is talking to.
 *
 * `/api` is stripped before the request leaves, because the API mounts its routes
 * at the root (`/campaigns`, not `/api/campaigns`). The prefix exists purely so a
 * single Vite dev server can serve the SPA and forward everything else without
 * guessing which unmatched path was meant to be a client route.
 *
 * The public surfaces are proxied UNPREFIXED and deliberately so. `/t/o/:id`,
 * `/r/:code`, `/u/:token` and `/webhooks/:provider` are reached by mail clients,
 * by a recipient's browser and by a provider — none of which will ever prepend
 * `/api`. Rewriting them here would mean the unsubscribe link rendered in a
 * preview does not resolve from the dev server, which is exactly the class of
 * failure I7 exists to catch.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/t': { target: 'http://localhost:3000', changeOrigin: true },
      '/r': { target: 'http://localhost:3000', changeOrigin: true },
      '/u': { target: 'http://localhost:3000', changeOrigin: true },
      '/webhooks': { target: 'http://localhost:3000', changeOrigin: true },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: true },
      '/readyz': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
