#!/usr/bin/env node
/**
 * 指尖花 · zero-dependency local static server.
 *
 * Usage:
 *   node serve.mjs            -> http://localhost:4173
 *   node serve.mjs --open     -> start, then open the default browser
 *   node serve.mjs --port 8080
 *   PORT=8080 node serve.mjs
 *
 * The page needs an HTTP(S) origin for getUserMedia. This server is intentionally
 * tiny: no dependencies, no build step, correct MIME types for WASM + the
 * MediaPipe .task model, and safe path resolution.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}));

function parsePort(argv) {
  const argIndex = argv.indexOf('--port');
  const fromArg = argIndex >= 0 ? argv[argIndex + 1] : undefined;
  const raw = fromArg ?? process.env.PORT ?? '4173';
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 4173;
}

function safePathname(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;

  // URL paths are always POSIX. Reject traversal before resolving on Windows.
  const normalized = posix.normalize(pathname);
  if (normalized.includes('..')) return null;

  const relative = normalized.replace(/^\/+/, '');
  const absolute = resolve(ROOT, relative);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + sep)) return null;

  return { absolute, pathname: normalized };
}

function sendStatus(res, status, message, extra = '') {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extra ? { Allow: extra } : {}),
  });
  res.end(`<!doctype html><meta charset="utf-8"><title>${status}</title><body style="background:#06080b;color:#d7e4dd;font:16px/1.6 system-ui;padding:10vh 8vw"><h1>${status}</h1><p>${message}</p></body>`);
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendStatus(res, 405, 'Method not allowed.', 'GET, HEAD');
    return;
  }

  const resolved = safePathname(req.url ?? '/');
  if (!resolved) {
    sendStatus(res, 400, 'Bad request.');
    return;
  }

  let { absolute, pathname } = resolved;
  let info;
  try {
    info = await stat(absolute);
    if (info.isDirectory()) {
      // Redirect "/repo" -> "/repo/" BEFORE serving index.html. Relative
      // styles/scripts depend on the trailing slash; this also mirrors how
      // GitHub Pages serves project sites.
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      if (!requestUrl.pathname.endsWith('/')) {
        res.writeHead(301, { Location: `${requestUrl.pathname}/${requestUrl.search}` });
        res.end();
        return;
      }
      absolute = resolve(absolute, 'index.html');
      info = await stat(absolute);
    }
  } catch {
    sendStatus(res, 404, 'Nothing lives at this path.');
    return;
  }

  if (!info.isFile()) {
    sendStatus(res, 404, 'Not a file.');
    return;
  }

  const ext = extname(absolute).toLowerCase();
  const type = MIME.get(ext) ?? 'application/octet-stream';
  const cache = pathname.startsWith('/vendor/')
    ? 'public, max-age=3600'
    : 'no-cache';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    // MediaPipe's WASM loader uses fetch; these media permissions keep the
    // camera preview inside the origin friendly for local development.
    'Permissions-Policy': 'camera=(self), microphone=()',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(absolute);
  stream.on('error', (error) => {
    console.error('[serve] read error:', error.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    // The empty first argument is the window title for cmd's `start`.
    command = process.env.ComSpec || 'cmd.exe';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (error) => {
      console.warn(`  Could not open a browser automatically: ${error.message}`);
      console.warn(`  Open this URL manually: ${url}`);
    });
    child.unref();
  } catch (error) {
    console.warn(`  Could not open a browser automatically: ${error.message}`);
    console.warn(`  Open this URL manually: ${url}`);
  }
}

const port = parsePort(process.argv.slice(2));
const shouldOpenBrowser = process.argv.includes('--open') && process.env.BLOOM_NO_OPEN !== '1';
const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('[serve] unexpected error:', error);
    if (!res.headersSent) sendStatus(res, 500, 'Internal server error.');
    else res.end();
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use. Try: npm start -- --port ${port + 1}\n`);
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  const line = '─'.repeat(48);
  console.log(`\n  ✦ 指尖花 · Bloom at your fingertips`);
  console.log(`  ${line}`);
  console.log(`  Local:    http://localhost:${port}`);
  console.log(`  Camera:   allow access when the browser asks`);
  console.log(`  Demo:     http://localhost:${port}/?demo=1`);
  console.log(`  ${line}\n`);
  if (shouldOpenBrowser) {
    console.log('  Opening the browser…');
    setTimeout(() => openBrowser(`http://localhost:${port}`), 120);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
