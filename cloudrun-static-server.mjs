#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = process.env.STATIC_ROOT || 'dist';
const port = Number(process.env.PORT || 8080);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

function resolvePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^\/+/, '');
  const direct = join(root, clean);
  const candidates = [direct, join(direct, 'index.html')];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const st = statSync(candidate);
    if (st.isFile()) return candidate;
  }
  return join(root, 'index.html');
}

createServer((req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const file = resolvePath(req.url || '/');
    const ext = extname(file);
    res.writeHead(200, {
      'content-type': types.get(ext) || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`static server listening on ${port}, root=${root}`);
});
