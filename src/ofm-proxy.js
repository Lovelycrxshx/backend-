// A narrow reverse proxy from this public server to the vendored
// our-free-model standalone service on loopback.
//
// Why it exists at all: the standalone service binds 127.0.0.1 by design and
// fences its console (`/`, `/assets/*`, `/api/management/*`) to loopback,
// same-origin callers with an HTTP-only session cookie. None of that can work
// through a public URL, and deliberately so — this file does not try to make it
// work. It forwards *only* the inference paths, and *only* to a caller that
// presents the service's own bearer key:
//
//   POST /ofm/v1/chat/completions      stream + non-stream
//   POST /ofm/v1/responses
//   POST /ofm/v1/messages              (+ /count_tokens)
//   GET  /ofm/v1/models
//   GET  /ofm/v1/health
//
// The console itself stays on loopback, where the user reaches it from the
// machine that runs this server (see /health → ofm.dataDir for the link the
// child prints on startup).
import { Hono } from 'hono';
import { OFM, ofmKey, ofmStatus } from './ofm.js';

export const ofmProxy = new Hono();

/** Same set of paths the upstream LAN relay forwards — nothing else. */
const PATHS = new Set([
  '/v1/models',
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/messages',
  '/v1/messages/count_tokens',
]);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-api-key',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '600',
};

function bearer(c) {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer (.+)$/i.exec(header);
  return match?.[1]?.trim() ?? c.req.header('x-api-key') ?? '';
}

ofmProxy.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return c.body(null, 204, CORS);
  await next();
  for (const [k, v] of Object.entries(CORS)) c.res.headers.set(k, v);
});

ofmProxy.all('*', async (c) => {
  const path = (new URL(c.req.url).pathname.replace(/^\/ofm/, '') || '/').replace(/\/+$/, '') || '/';
  if (path === '/health' || path === '/v1/health') {
    const status = ofmStatus();
    return c.json({ ...status, keyConfigured: ofmKey() !== null });
  }
  if (!PATHS.has(path)) {
    return c.json({ error: { message: `no route for ${c.req.method} ${path}`, type: 'invalid_request_error' } }, 404);
  }
  const key = ofmKey();
  if (key === null) {
    return c.json({ error: { message: 'the our-free-model service has not written its key yet; retry in a moment', type: 'server_error' } }, 503);
  }
  if (bearer(c) !== key) {
    return c.json({ error: { message: 'missing or invalid API key — use the key from /setup', type: 'invalid_request_error' } }, 401);
  }

  const search = new URL(c.req.url).search;
  const init = {
    method: c.req.method,
    headers: {
      // Only what an inference call needs; the caller's own Authorization is
      // replaced with the service's local key.
      'content-type': c.req.header('content-type') ?? 'application/json',
      accept: c.req.header('accept') ?? 'application/json',
      authorization: `Bearer ${key}`,
    },
    signal: c.req.raw.signal,
  };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    // Streamed straight through, so a large prompt body is not buffered twice.
    init.body = c.req.raw.body;
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetch(`http://127.0.0.1:${OFM.port}${path}${search}`, init);
  } catch (error) {
    return c.json({
      error: { message: `the our-free-model service is not reachable on loopback (${error?.message ?? error})`, type: 'server_error' },
    }, 502);
  }

  const headers = new Headers(CORS);
  for (const name of ['content-type', 'cache-control']) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // Pass the response body through as a stream: SSE deltas arrive as they are
  // produced instead of being collected into one buffer first.
  return new Response(upstream.body, { status: upstream.status, headers });
});
