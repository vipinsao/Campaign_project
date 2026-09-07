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
/**
 * The target is read from the environment, and written down once.
 *
 * It used to be the literal `http://localhost:3000`, repeated seven times, while
 * the API bound `PORT ?? 3001`. `npm run dev` therefore came up with every proxied
 * request going to a port nothing was listening on, and the symptom — a bodiless
 * 404 on every screen — looks like a broken API rather than a broken proxy.
 * scripts/dev.mjs now sets VITE_API_PROXY_TARGET from the same constant it passes
 * to the API as PORT, so the two cannot disagree.
 */
const target = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000';
const forward = { target, changeOrigin: true };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { ...forward, rewrite: (path) => path.replace(/^\/api/, '') },
      '/t': forward,
      '/r': forward,
      '/u': forward,
      '/webhooks': forward,
      '/healthz': forward,
      '/readyz': forward,
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
