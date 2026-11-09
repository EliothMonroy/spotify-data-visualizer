#!/usr/bin/env node
// Minimal static server (no dependencies). Listens on localhost only.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

// URL prefix -> folder on disk
const mounts = [
  ['/data/', join(root, 'data')],
  ['/vendor/echarts/', join(root, 'node_modules', 'echarts', 'dist')],
  ['/', join(root, 'public')],
];

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function resolvePath(urlPath) {
  for (const [prefix, dir] of mounts) {
    if (!urlPath.startsWith(prefix)) continue;
    const rel = decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html';
    const full = resolve(dir, normalize(rel));
    if (full !== dir && !full.startsWith(dir + sep)) return null; // block path traversal
    return full;
  }
  return null;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  const file = resolvePath(urlPath);
  let info;
  try {
    info = file && (await stat(file));
  } catch {
    info = null;
  }
  if (!info || !info.isFile()) {
    const missingData = urlPath.startsWith('/data/');
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(missingData ? 'Dataset not built yet. Run: npm run prepare-data' : 'Not found');
    return;
  }

  const type = types[extname(file)] ?? 'application/octet-stream';
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && /json|javascript|css|html|svg/.test(type);
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : { 'Content-Length': info.size }),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  (gzip ? stream.pipe(createGzip({ level: 6 })) : stream).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`Spotify Data Visualizer running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
