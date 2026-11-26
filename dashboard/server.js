// A phone-first dashboard for the free-model gateway.
//
// It is a separate listener from src/index.js on purpose: the preview URL you
// open is this port, and everything it needs (the gateway on 127.0.0.1:3000,
// the our-free-model service on 127.0.0.1:18900) is reached server-side. The
// browser only ever talks to one origin, so there is no CORS puzzle and the
// service key never has to be typed in by hand on a phone keyboard.
//
//   GET  /                    the dashboard
//   GET  /api/state           status + model list + key (same-origin only)
//   POST /api/test            one streaming chat turn, relayed as SSE
//   ANY  /ofm/*, /v1/*        proxied to the gateway, for debugging with curl
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? 8080);
const GATEWAY = `http://127.0.0.1:${process.env.GATEWAY_PORT ?? 3000}`;
const OFM_HOME = path.resolve(process.env.OFM_HOME ?? path.join(HERE, '..', '.ofm'));

function serviceKey() {
  try {
    const key = JSON.parse(fs.readFileSync(path.join(OFM_HOME, 'settings.json'), 'utf8'))?.forwardKey;
    return typeof key === 'string' && key !== '' ? key : null;
  } catch {
    return null;
  }
}

const html = fs.readFileSync(path.join(HERE, 'index.html'));

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function gatewayJson(pathname, key) {
  const res = await fetch(`${GATEWAY}${pathname}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function state() {
  let gateway = { up: false };
  try {
    const res = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(4000) });
    gateway = { up: res.ok, ...(await res.json()) };
  } catch { /* gateway down */ }
  const key = serviceKey();
  let models = [];
  let modelsError = null;
  if (key !== null) {
    const listing = await gatewayJson('/ofm/v1/models', key).catch((error) => ({ status: 0, error: error?.message }));
    if (listing.status === 200 && Array.isArray(listing.body?.data)) models = listing.body.data;
    else modelsError = listing.error ?? `models answered ${listing.status}`;
  }
  const modelsCached = fs.existsSync(path.join(OFM_HOME, 'settings.json'));
  return {
    gateway,
    service: gateway?.ofm ?? null,
    key,
    models: models.map((m) => ({
      id: m.id,
      context: Number(m.context_window) || null,
      efforts: Array.isArray(m.x_ofm_efforts) ? m.x_ofm_efforts : null,
    })),
    modelsError,
    baseUrl: `/ofm/v1`,
    dataDir: OFM_HOME,
    settingsWritten: modelsCached,
  };
}

/** One chat turn, streamed straight back to the page as SSE. */
async function test(req, res) {
  const key = serviceKey();
  if (key === null) return json(res, 503, { error: 'the service has not written its key yet' });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) return json(res, 413, { error: 'body too large' });
  }
  let parsed;
  try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'invalid JSON' }); }
  const model = typeof parsed.model === 'string' ? parsed.model : '';
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
  if (model === '' || prompt.trim() === '') return json(res, 400, { error: 'model and prompt are required' });

  const controller = new AbortController();
  res.once('close', () => controller.abort());
  const started = Date.now();
  let firstTokenAt = null;

  let upstream;
  try {
    upstream = await fetch(`${GATEWAY}/ofm/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
        ...(typeof parsed.effort === 'string' && parsed.effort !== '' ? { reasoning_effort: parsed.effort } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    return json(res, 502, { error: String(error?.message ?? error) });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: 'start', model, at: Date.now() });

  // A non-200 is still a JSON body: show it as the failure it is instead of
  // pretending a stream started.
  if (upstream.status !== 200) {
    const text = await upstream.text().catch(() => '');
    let message = text;
    try { message = JSON.parse(text)?.error?.message ?? text; } catch { /* plain text */ }
    send({ type: 'error', status: upstream.status, message: String(message ?? '').slice(0, 800) });
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let event;
          try { event = JSON.parse(payload); } catch { continue; }
          const delta = event.choices?.[0]?.delta ?? {};
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
            reasoning += delta.reasoning_content;
            send({ type: 'reasoning', text: delta.reasoning_content });
          }
          if (typeof delta.content === 'string' && delta.content !== '') {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            text += delta.content;
            send({ type: 'delta', text: delta.content });
          }
        }
      }
    }
    send({
      type: 'done',
      text,
      reasoning,
      ms: Date.now() - started,
      firstTokenMs: firstTokenAt === null ? null : firstTokenAt - started,
    });
  } catch (error) {
    if (!controller.signal.aborted) send({ type: 'error', message: String(error?.message ?? error) });
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, await state());
    if (url.pathname === '/api/test' && req.method === 'POST') return await test(req, res);
    if (url.pathname.startsWith('/ofm/') || url.pathname.startsWith('/v1/')) {
      // Debug passthrough: same origin, so a phone browser can curl the API
      // without CORS, and the key is added here rather than in the URL.
      const key = serviceKey();
      const upstream = await fetch(`${GATEWAY}${url.pathname}${url.search}`, {
        method: req.method,
        headers: {
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          'content-type': req.headers['content-type'] ?? 'application/json',
        },
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : req,
        duplex: 'half',
        signal: AbortSignal.timeout(180_000),
      });
      const headers = {};
      for (const name of ['content-type', 'cache-control']) {
        const value = upstream.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      res.writeHead(upstream.status, headers);
      if (upstream.body) {
        for await (const chunk of upstream.body) res.write(chunk);
      }
      res.end();
      return;
    }
    json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: String(error?.message ?? error) });
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`dashboard on 0.0.0.0:${PORT} (gateway ${GATEWAY}, data ${OFM_HOME})`);
});
