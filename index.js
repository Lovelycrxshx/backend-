// One codebase, two homes: Railway (Node) now, Cloudflare Workers later.
// `export default app` is what Workers needs; the Node server is at the bottom.
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

const env = (c, k) => c.env?.[k] ?? process.env[k];

app.get('/', (c) => c.json({ ok: true, service: 'backend', routes: ['/health', '/api/ping', '/api/items'] }));

app.get('/health', (c) => c.json({
  status: 'healthy',
  version: '1.0.0',
  uptime: Math.round(typeof process !== 'undefined' && process.uptime ? process.uptime() : 0),
  time: new Date().toISOString(),
}));

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

app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});

export default app;

// --- Node server (Railway runs this file) ---
if (typeof process !== 'undefined' && !process.env.WORKER_RUNTIME) {
  const { serve } = await import('@hono/node-server');
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
    console.log(`listening on 0.0.0.0:${info.port}`);
  });
}
