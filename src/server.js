import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { paths } from './publish.js';
import { renderIndex, renderUnavailable } from './render.js';

const HTML_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function authorized(header, secret) {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...HTML_SECURITY_HEADERS,
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function sendHtml(response, status, body, cacheControl = 'no-cache') {
  send(response, status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl });
}

function sendJson(response, status, value, headers = {}) {
  send(response, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function routeName(pathname) {
  if (pathname === '/') return 'index';
  if (pathname === '/healthz') return 'health';
  if (pathname === '/style.css') return 'stylesheet';
  if (pathname.startsWith('/lessons/')) return 'lesson';
  if (pathname.startsWith('/assets/')) return 'asset';
  if (pathname.startsWith('/admin/publish/')) return 'publish';
  return 'not_found';
}

async function resolveLesson(config, store, slug) {
  const configured = config.bySlug.get(slug);
  if (configured) {
    return { lesson: configured, current: await store.readJson(paths.current(slug)) };
  }
  for (const root of config.lessons) {
    const current = await store.readJson(paths.current(root.slug));
    const lesson = current?.pages?.find((page) => page.slug === slug);
    if (lesson) return { lesson, current };
  }
  return null;
}

export function createApplication({ config, store, publisher, stylesheet = '', logger = console }) {
  return http.createServer(async (request, response) => {
    const requestId = randomUUID();
    let publishId;
    let status = 500;
    let pathname = '/';
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && pathname === '/healthz') {
        status = 200;
        sendJson(response, status, { status: 'ok' });
      } else if (request.method === 'GET' && pathname === '/') {
        status = 200;
        sendHtml(response, status, renderIndex(config), 'public, max-age=0, must-revalidate');
      } else if (request.method === 'GET' && pathname === '/style.css') {
        status = 200;
        send(response, status, stylesheet, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        });
      } else if (request.method === 'GET' && /^\/lessons\/[^/]+$/.test(pathname)) {
        const slug = decodeURIComponent(pathname.slice('/lessons/'.length));
        const resolved = await resolveLesson(config, store, slug);
        if (!resolved?.current || typeof resolved.current.version !== 'string') {
          status = 404;
          sendHtml(response, status, renderUnavailable());
          return;
        }
        const { current } = resolved;
        status = 200;
        response.setHeader('ETag', `"${current.version}"`);
        if (request.headers['if-none-match'] === `"${current.version}"`) {
          status = 304;
          response.statusCode = 304;
          response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
          response.end();
          return;
        }
        const snapshot = await store.read(paths.snapshot(slug, current.version));
        if (snapshot === null) {
          status = 503;
          sendHtml(response, status, renderUnavailable());
          return;
        }
        sendHtml(response, status, snapshot, 'public, max-age=0, must-revalidate');
      } else if (request.method === 'GET' && pathname.startsWith('/assets/')) {
        const match = pathname.match(/^\/assets\/([a-z0-9-]+)\/([0-9a-f]{8}-[0-9a-f-]{27})\/([a-f0-9]{24}\.[a-z0-9]+)$/);
        const resolved = match ? await resolveLesson(config, store, match[1]) : null;
        if (!resolved?.current) {
          status = 404;
          sendJson(response, status, { error: 'Asset not found' });
          return;
        }
        const [, slug, version, filename] = match;
        const asset = await store.get(paths.asset(slug, version, filename));
        if (!asset) {
          status = 404;
          sendJson(response, status, { error: 'Asset not found' });
          return;
        }
        response.writeHead(200, {
          ...HTML_SECURITY_HEADERS,
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Type': asset.metadata.contentType ?? 'application/octet-stream',
          'Content-Disposition': asset.metadata.contentDisposition ?? 'attachment',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': asset.data.length,
        });
        response.end(asset.data);
        status = 200;
      } else if (request.method === 'POST' && /^\/admin\/publish\/[^/]+$/.test(pathname)) {
        if (!authorized(request.headers.authorization, config.adminToken)) {
          status = 401;
          sendJson(response, status, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
          return;
        }
        if (Number(request.headers['content-length'] ?? 0) > 0) {
          status = 413;
          sendJson(response, status, { error: 'Publish requests do not accept a body' });
          return;
        }
        const slug = decodeURIComponent(pathname.slice('/admin/publish/'.length));
        if (!config.bySlug.has(slug)) {
          status = 404;
          sendJson(response, status, { error: 'Unknown lesson' });
          return;
        }
        publishId = randomUUID();
        const result = await publisher.publish(slug, publishId);
        status = 200;
        sendJson(response, status, result);
      } else {
        status = 404;
        sendJson(response, status, { error: 'Not found' });
      }
    } catch (error) {
      status = error.status ?? 500;
      const message = status >= 500 && status !== 503 && status !== 504 ? 'Internal server error' : error.message;
      logger.error({
        event: 'request_failed', requestId, publishId, code: error.code ?? 'internal_error', status,
      });
      if (!response.headersSent) {
        if (routeName(pathname) === 'publish') sendJson(response, status, { error: message, code: error.code ?? 'internal_error' });
        else sendHtml(response, status, renderUnavailable());
      } else {
        response.end();
      }
    } finally {
      logger.info({ event: 'http_request', requestId, publishId, method: request.method, route: routeName(pathname), status });
    }
  });
}
