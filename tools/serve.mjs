#!/usr/bin/env node
// Minimal static file server for the app (ES modules and workers need http://, not file://).
// usage: node tools/serve.mjs [port]      then open http://localhost:<port>/
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function startServer(port = 8080, host = '127.0.0.1') {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(ROOT, p));
      if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403); res.end('forbidden'); return; }
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, () => ok(server)); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = +process.argv[2] || 8080;
  startServer(port).then(() => console.log(`Ship-block passage simulator: http://localhost:${port}/  (Ctrl+C to stop)`), e => { console.error(String(e.message || e)); process.exit(1); });
}
