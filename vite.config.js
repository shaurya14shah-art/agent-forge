import { defineConfig } from 'vite';
import { loadDotEnv } from './server/env.js';
import { createAiRouter } from './server/aiRouter.js';
import { createModelRouter } from './server/modelSearch.js';

loadDotEnv();

/** Serves the Claude proxy and the model service in dev and preview alike. */
function agentForgeApi() {
  // NB: must not return the connect app — Vite treats a returned value from
  // configureServer as a post-hook and would invoke it with no request.
  const mount = (server) => {
    server.middlewares.use('/api/ai', createAiRouter());
    server.middlewares.use('/api/models', createModelRouter());
  };
  return {
    name: 'agent-forge-api',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}

export default defineConfig({
  plugins: [agentForgeApi()],
  server: {
    port: Number(process.env.FORGE_PORT) || 5273,
    strictPort: false,
  },
  preview: { port: Number(process.env.FORGE_PORT) || 5273 },
  // Pre-bundle the vision task so enabling the camera doesn't stall on a
  // cold dep optimisation the first time.
  optimizeDeps: { include: ['@mediapipe/tasks-vision'] },
  // Production builds do not publish source maps (they expose the original source).
  // Run `SOURCEMAP=1 npm run build` when you need them for debugging.
  build: { target: 'es2022', sourcemap: process.env.SOURCEMAP === '1' },
});
