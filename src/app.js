// One codebase, two homes: Railway (Node) now, Cloudflare Workers later.
// `export default app` is what Workers needs; the Node server is at the bottom.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './env.js';
import { gateway } from './gateway.js';
import { setup } from './setup.js';
import { ofmHealthy, ofmStatus } from './ofm.js';
import { ofmProxy } from './ofm-proxy.js';

const app = new Hono();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

app.get('/', (c) => c.json({
  ok: true,
  service: 'backend',
  routes: ['/health', '/api/ping', '/api/items', '/v1/chat/completions', '/v1/models', '/v1/providers', '/v1', '/setup', '/ofm'],
}));

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
