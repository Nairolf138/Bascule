import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/engine.mjs', ['engine.mjs', 'text/javascript; charset=utf-8']],
  ['/example.mjs', ['example.mjs', 'text/javascript; charset=utf-8']],
]);
const port = Number(process.env.BASCULE_PORT ?? 4318);

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const target = files.get(pathname);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'");
  if (request.method !== 'GET' || !target) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Introuvable');
    return;
  }
  try {
    const body = await readFile(join(root, target[0]));
    response.writeHead(200, { 'Content-Type': target[1] });
    response.end(body);
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Erreur de lecture');
  }
});

server.on('error', (error) => {
  console.error(`Bascule : ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`Bascule est prêt : ${url}`);
  console.log('Fermez cette fenêtre ou appuyez sur Ctrl+C pour arrêter.');
  if (process.platform === 'win32' && !process.argv.includes('--no-open')) {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
});
