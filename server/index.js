/**
 * Production server: serves `dist/` plus the /api/ai proxy.
 * Run `npm run build` first, then `npm start`.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './env.js';
import { createAiRouter } from './aiRouter.js';
import { createModelRouter } from './modelSearch.js';

loadDotEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const port = Number(process.env.FORGE_PORT) || 5273;
const aiRouter = createAiRouter();
const modelRouter = createModelRouter();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  const notFound = () => { res.statusCode = 404; res.end('Not found'); };

  if (url.pathname.startsWith('/api/ai')) {
    req.url = (url.pathname.slice('/api/ai'.length) || '/') + url.search;
    return aiRouter(req, res, notFound);
  }

  if (url.pathname.startsWith('/api/models')) {
    req.url = (url.pathname.slice('/api/models'.length) || '/') + url.search;
    return modelRouter(req, res, notFound);
  }

  // Static files, confined to dist/.
  const requested = path.normalize(decodeURIComponent(url.pathname));
  let filePath = path.join(dist, requested);
  if (!filePath.startsWith(dist)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(dist, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.statusCode = 404;
    return res.end('Build missing — run `npm run build` first.');
  }

  res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  const keyed = process.env.ANTHROPIC_API_KEY ? 'ONLINE' : 'OFFLINE (no ANTHROPIC_API_KEY)';
  console.log(`AGENT FORGE  →  http://localhost:${port}   [design agent: ${keyed}]`);
});
