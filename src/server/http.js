// Минимальный HTTP-сервер: роутер JSON API, раздача статики (с диска или
// из ресурсов, встроенных в exe) и Server-Sent Events для живых обновлений.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';

const L = log('http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/\/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$',
    );
    routes.push({ method, re, keys, handler });
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
      return null;
    },
  };
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Некорректный JSON'); }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Источник статики: папка на диске (разработка) или ресурсы SEA (exe).
export function createStaticSource({ dir, assets }) {
  return {
    read(rel) {
      rel = rel.replace(/^\/+/, '') || 'index.html';
      if (rel.includes('..')) return null;
      if (assets) {
        const buf = assets(`web/${rel}`);
        return buf ? { buf, ext: path.extname(rel) } : null;
      }
      const file = path.join(dir, rel);
      try {
        return { buf: fs.readFileSync(file), ext: path.extname(file) };
      } catch {
        return null;
      }
    },
  };
}

export class EventHub {
  constructor() {
    this.clients = new Set();
  }

  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  emit(type, data) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }
}

export function createServer({ router, staticSource, events }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (pathname === '/api/events' && req.method === 'GET') {
        events.attach(req, res);
        return;
      }
      if (pathname.startsWith('/api/')) {
        const m = router.match(req.method, pathname);
        if (!m) throw new HttpError(404, `Нет такого метода API: ${req.method} ${pathname}`);
        const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        const result = await m.handler({ req, res, params: m.params, query: Object.fromEntries(url.searchParams), body, url });
        if (!res.headersSent && !res.writableEnded) sendJson(res, 200, result ?? { ok: true });
        return;
      }
      // SPA: всё, что не файл, отдаём как index.html
      let file = staticSource.read(pathname);
      if (!file && !path.extname(pathname)) file = staticSource.read('index.html');
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[file.ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(file.buf);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) L.error(`${req.method} ${pathname} упал`, e);
      if (!res.headersSent) sendJson(res, status, { error: e.message, details: e.details });
      else res.end();
    }
  });
}
