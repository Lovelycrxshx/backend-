// One codebase, two homes: Railway (Node) now, Cloudflare Workers later.
// `export default app` is what Workers needs; the Node server is at the bottom.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './env.js';
import { gateway } from './gateway.js';
import { setup } from './setup.js';
import { dashboardHtml, ofmHealthy, ofmKey, ofmModels, ofmStatus } from './ofm.js';
import { ofmProxy } from './ofm-proxy.js';

const app = new Hono();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// `/` is the phone page, so the public port is all a phone needs: one origin,
// no second listener, no CORS. `?json=1` (and the JSON Accept header) keep the
// machine-readable route index that scripts and the README rely on.
app.get('/', (c) => {
  const wantsJson = c.req.query('json') === '1' || (c.req.header('accept') ?? '').includes('application/json');
  const page = wantsJson ? null : dashboardHtml();
  if (page !== null) return c.html(page.toString('utf8'));
  return c.json({
    ok: true,
    service: 'backend',
    routes: ['/health', '/api/ping', '/api/items', '/v1/chat/completions', '/v1/models', '/v1/providers', '/v1', '/setup', '/ofm/v1/*', '/api/state', '/api/test'],
  });
});

// --- same-origin state for the dashboard page -------------------------------
app.get('/api/state', async (c) => {
  const key = ofmKey();
  const models = key === null ? [] : await ofmModels();
  return c.json({
    gateway: { up: true, version: '1.2.0' },
    service: { ...ofmStatus(), healthy: await ofmHealthy() },
    key,
    models,
    baseUrl: '/ofm/v1',
  });
});

app.get('/health', async (c) => {
  const ofm = ofmStatus();
  return c.json({
    status: 'healthy',
    version: '1.2.0',
    uptime: Math.round(typeof process !== 'undefined' && process.uptime ? process.uptime() : 0),
    time: new Date().toISOString(),
    ofm: { ...ofm, healthy: ofm.running ? await ofmHealthy() : false },
  });
});

// --- the vendored dsh-our-free-model standalone service ---------------------
// It binds loopback itself and fences its console to same-origin loopback
// callers, so this route reports status only — it is not a public proxy.
app.get('/ofm', (c) => c.json(ofmStatus()));

app.get('/api/ping', (c) => c.json({ pong: true, echo: c.req.query('echo') ?? null }));

// --- Supabase REST proxy. Uses the anon key, so RLS does the access control. ---
async function sb(c, path, init = {}) {
  const url = env(c, 'SUPABASE_URL');
  const key = env(c, 'SUPABASE_ANON_KEY');
  if (!url || !key) return { error: 'SUPABASE_URL / SUPABASE_ANON_KEY not set', status: 503 };
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { data, status: res.status };
}

// --- one streamed chat turn for the dashboard's "Try it" box ----------------
// Deliberately same-origin and key-injected server-side: the phone never has to
// paste the service key to try a model, and there is no cross-origin preflight.
app.post('/api/test', async (c) => {
  const key = ofmKey();
  if (key === null) return c.json({ error: 'the free-model service has not written its key yet' }, 503);
  const body = await c.req.json().catch(() => null);
  const model = typeof body?.model === 'string' ? body.model : '';
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  if (model === '' || prompt.trim() === '') return c.json({ error: 'model and prompt are required' }, 400);
  const started = Date.now();
  let upstream;
  try {
    upstream = await fetch(`http://127.0.0.1:${ofmStatus().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
        ...(typeof body?.effort === 'string' && body.effort !== '' ? { reasoning_effort: body.effort } : {}),
      }),
      signal: c.req.raw.signal,
    });
  } catch (error) {
    return c.json({ error: String(error?.message ?? error) }, 502);
  }
  if (upstream.status !== 200) {
    const text = await upstream.text().catch(() => '');
    let message = text;
    try { message = JSON.parse(text)?.error?.message ?? text; } catch { /* plain text */ }
    return c.json({ error: String(message ?? '').slice(0, 800), status: upstream.status }, 502);
  }
  // Rewrite the upstream SSE into the small event vocabulary the page renders.
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      emit({ type: 'start', model, at: Date.now() });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let firstTokenMs = null;
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
                emit({ type: 'reasoning', text: delta.reasoning_content });
              }
              if (typeof delta.content === 'string' && delta.content !== '') {
                if (firstTokenMs === null) firstTokenMs = Date.now() - started;
                emit({ type: 'delta', text: delta.content });
              }
            }
          }
        }
        emit({ type: 'done', ms: Date.now() - started, firstTokenMs });
      } catch (error) {
        emit({ type: 'error', message: String(error?.message ?? error) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
});

app.get('/api/items', async (c) => {
  const r = await sb(c, 'items?select=*&order=created_at.desc&limit=50');
  if (r.error) return c.json({ error: r.error }, 503);
  return c.json({ items: r.data }, r.status);
});

app.post('/api/items', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ error: 'name is required' }, 400);
  }
  const r = await sb(c, 'items', { method: 'POST', body: JSON.stringify({ name: body.name.trim() }) });
  if (r.error) return c.json({ error: r.error }, 503);
  return c.json({ item: Array.isArray(r.data) ? r.data[0] : r.data }, r.status);
});

// --- free LLM gateway: /v1/chat/completions, /v1/models, /v1/providers ---
app.route('/v1', gateway);

// --- phone-friendly setup card: open /setup on the Android device ---
app.route('/setup', setup);

// --- inference-only proxy to the vendored our-free-model service (loopback) ---
app.route('/ofm', ofmProxy);

app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});

export default app;
