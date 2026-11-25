// OpenAI-compatible gateway over free-tier LLM providers.
//
//   POST /v1/chat/completions   <- point any Android app at this
//   GET  /v1/models
//   GET  /v1/providers
//
// Provider keys live in server env vars, so the phone only ever holds one token
// (GATEWAY_TOKEN). Requests fall down the provider list until one answers.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env, safeEqual } from './env.js';
import { describeProviders, resolveProviders } from './providers.js';

export const gateway = new Hono();

gateway.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Gateway-Token', 'X-Provider'],
  exposeHeaders: ['X-Gateway-Provider', 'X-Gateway-Model', 'X-Gateway-Attempts'],
}));

const getEnv = (k) => env(null, k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

const DEFAULT_ORDER = 'gemini,groq,openrouter,ovhcloud,llm7';
const FALLBACK_DEADLINE_MS = () => Number(getEnv('FALLBACK_DEADLINE_MS') ?? 150_000);
const FIRST_CHUNK_MS = () => Number(getEnv('FIRST_CHUNK_MS') ?? 40_000);

// Statuses that mean "this provider can't serve this request right now" → try the next.
const RETRY_STATUS = new Set([0, 401, 402, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 529]);

function snippet(value) {
  let text = value;
  if (typeof value !== 'string') {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  return String(text ?? '').slice(0, 400);
}

function errorMessage(json, raw) {
  const e = json?.error ?? json?.message ?? json?.detail ?? json;
  let message = typeof e === 'object' && e !== null ? e.message ?? e.type : e;
  if (Array.isArray(message)) message = message.map((m) => m?.message ?? JSON.stringify(m)).join('; ');
  return snippet(message || raw || 'unknown provider error');
}

async function readProviderError(res) {
  const raw = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not JSON */ }
  return errorMessage(json, raw) || `HTTP ${res.status}`;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

const unauthorized = (c, status, message) =>
  c.json({ error: { message, type: 'gateway_auth', code: status } }, status);

function checkAuth(c) {
  const expected = getEnv('GATEWAY_TOKEN');
  if (!expected) {
    return {
      ok: false,
      status: 503,
      message: 'GATEWAY_TOKEN is not set on the server. Set it before exposing /v1 — otherwise anyone can spend your free quota.',
    };
  }
  const header = c.req.header('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!safeEqual(token, expected)) {
    return { ok: false, status: 401, message: 'Invalid API key. Paste the GATEWAY_TOKEN value as the API key in your app.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// request planning: which providers to try, with which model
// ---------------------------------------------------------------------------

/** If the model is namespaced ("groq/openai/gpt-oss-120b") or is a known model, route straight there. */
function plan(c, body, providers) {
  const headerPick = (c.req.header('x-provider') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const requested = typeof body.model === 'string' ? body.model.trim() : '';

  let candidates = providers;
  if (headerPick.length) {
    const picked = providers.filter((p) => headerPick.includes(p.id));
    if (picked.length) candidates = picked;
  }

  const isAuto = !requested || ['auto', 'default', 'gateway', 'any'].includes(requested.toLowerCase());

  if (!isAuto) {
    const slash = requested.indexOf('/');
    if (slash > 0) {
      const prefix = requested.slice(0, slash);
      const rest = requested.slice(slash + 1);
      const match = providers.find((p) => p.id === prefix);
      if (match) return { providers: [match], model: rest };
    }
    const owner = providers.find((p) => (p.models ?? []).includes(requested));
    if (owner) return { providers: [owner], model: requested };
  }

  return { providers: candidates, model: isAuto ? null : requested };
}

// ---------------------------------------------------------------------------
// provider call + fallback
// ---------------------------------------------------------------------------

/** Short-lived "don't bother" list so a rate-limited provider doesn't add latency to every request. */
const cooldown = new Map(); // providerId -> timestamp until which we skip it
const COOLDOWN_MS = () => Number(getEnv('PROVIDER_COOLDOWN_MS') ?? 45_000);

function alive(list) {
  // Cooldown off (0) also clears anything recorded earlier — handy for tests and for
  // "just retry everything" restarts.
  if (COOLDOWN_MS() <= 0) {
    cooldown.clear();
    return list;
  }
  const t = now();
  for (const [id, until] of cooldown) if (until <= t) cooldown.delete(id);
  const usable = list.filter((p) => !cooldown.has(p.id));
  return usable.length ? usable : list; // if everything is cooling down, just try anyway
}

function buildHeaders(provider) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    // A non-browser UA matters: some providers apply browser-only restrictions.
    'User-Agent': getEnv('GATEWAY_USER_AGENT') ?? 'android-free-llm-gateway/1.0',
  };
  if (provider.key) headers.Authorization = `Bearer ${provider.key}`;
  if (getEnv('SITE_URL')) headers['HTTP-Referer'] = getEnv('SITE_URL');
  if (getEnv('SITE_NAME')) headers['X-Title'] = getEnv('SITE_NAME');
  return headers;
}

async function callProvider(provider, payload, signal) {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutMs = Number(getEnv('PROVIDER_TIMEOUT_MS') ?? 60_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(provider),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { res };
  } catch (err) {
    const message = err?.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : snippet(err?.message ?? err);
    return { error: message, status: 0 };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function noteFailure(provider) {
  cooldown.set(provider.id, now() + COOLDOWN_MS());
}

function attemptsPayload(attempts) {
  return {
    error: {
      message:
        'Every configured provider failed. Free tiers rate-limit by IP, and shared hosts get throttled first — retry in a minute, or add another provider key.',
      type: 'gateway_exhausted',
      attempts,
    },
  };
}

// ---------------------------------------------------------------------------
// non-streaming
// ---------------------------------------------------------------------------

async function handleJson(c, list, base, signal) {
  const attempts = [];
  const deadline = now() + FALLBACK_DEADLINE_MS();

  for (let i = 0; i < list.length; i++) {
    if (now() > deadline) {
      attempts.push({ provider: list[i].id, ok: false, error: 'fallback deadline reached before trying' });
      break;
    }
    const provider = list[i];
    const model = base.model ?? provider.defaultModel;
    const payload = { ...base, model, stream: false };
    delete payload.stream_options;

    const started = now();
    const { res, error, status } = await callProvider(provider, payload, signal);
    const ms = now() - started;

    if (!res) {
      attempts.push({ provider: provider.id, model, ok: false, status: 0, ms, error });
      noteFailure(provider);
      continue;
    }
    if (!res.ok) {
      const status = res.status;
      attempts.push({ provider: provider.id, model, ok: false, status, ms, error: await readProviderError(res) });
      if (RETRY_STATUS.has(status)) noteFailure(provider);
      if (!RETRY_STATUS.has(status)) break; // 400/422: the request itself is wrong
      await sleep(Math.min(150 * (i + 1), 600));
      continue;
    }

    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!data || !Array.isArray(data.choices)) {
      attempts.push({ provider: provider.id, model, ok: false, status, ms, error: 'provider returned no choices' });
      noteFailure(provider);
      continue;
    }

    attempts.push({ provider: provider.id, model, ok: true, ms });
    return c.json(data, 200, {
      'X-Gateway-Provider': provider.id,
      'X-Gateway-Model': model,
      'X-Gateway-Attempts': String(attempts.length),
    });
  }

  return c.json(attemptsPayload(attempts), 503);
}

// ---------------------------------------------------------------------------
// streaming: wait for the first real event before committing to a provider,
// so a provider that 200s and then errors can still be replaced silently.
// ---------------------------------------------------------------------------

const SSE_DONE = 'data: [DONE]';

async function handleStream(c, list, base, signal) {
  const attempts = [];
  const deadline = now() + FALLBACK_DEADLINE_MS();

  for (let i = 0; i < list.length; i++) {
    if (now() > deadline) {
      attempts.push({ provider: list[i].id, ok: false, error: 'fallback deadline reached before trying' });
      break;
    }
    const provider = list[i];
    const model = base.model ?? provider.defaultModel;
    const payload = { ...base, model, stream: true };

    const started = now();
    const { res, error, status: netStatus } = await callProvider(provider, payload, signal);

    if (!res) {
      attempts.push({ provider: provider.id, model, ok: false, status: 0, ms: now() - started, error });
      noteFailure(provider);
      continue;
    }
    if (!res.ok) {
      const status = res.status;
      attempts.push({ provider: provider.id, model, ok: false, status, ms: now() - started, error: await readProviderError(res) });
      if (RETRY_STATUS.has(status)) noteFailure(provider);
      if (!RETRY_STATUS.has(status)) break;
      await sleep(Math.min(150 * (i + 1), 600));
      continue;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      attempts.push({ provider: provider.id, model, ok: false, ms: now() - started, error: 'empty response body' });
      noteFailure(provider);
      continue;
    }

    // Peek until we see a content chunk, an [DONE], or a provider error event.
    const decoder = new TextDecoder();
    const firstChunkDeadline = now() + FIRST_CHUNK_MS();
    let head = '';
    let verdict = 'pending';
    while (verdict === 'pending') {
      if (now() > firstChunkDeadline) { verdict = 'timeout'; break; }
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        verdict = err?.name === 'AbortError' ? 'timeout' : `read error: ${snippet(err?.message ?? err)}`;
        break;
      }
      if (chunk.done) { verdict = 'ended'; break; }
      head += decoder.decode(chunk.value, { stream: true });

      if (head.includes('"choices"') || head.includes(SSE_DONE)) verdict = 'ok';
      else if (/"error"/.test(head)) verdict = 'provider error';
      else if (head.length > 128 * 1024) verdict = 'oversized preamble';
    }

    if (verdict !== 'ok') {
      try { await reader.cancel(); } catch { /* already gone */ }
      attempts.push({ provider: provider.id, model, ok: false, ms: now() - started, error: verdict });
      noteFailure(provider);
      continue;
    }

    attempts.push({ provider: provider.id, model, ok: true, ms: now() - started });

    // Stream: the bytes we already read, then everything still coming.
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(head));
        (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        })();
      },
      cancel(reason) {
        return reader.cancel(reason).catch(() => {});
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Gateway-Provider': provider.id,
        'X-Gateway-Model': model,
        'X-Gateway-Attempts': String(attempts.length),
      },
    });
  }

  return c.json(attemptsPayload(attempts), 503);
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

gateway.post('/chat/completions', async (c) => {
  const auth = checkAuth(c);
  if (!auth.ok) return unauthorized(c, auth.status, auth.message);

  let body;
  try { body = await c.req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: { message: 'Request body must be a JSON object', type: 'invalid_request_error' } }, 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: { message: 'messages[] is required', type: 'invalid_request_error' } }, 400);
  }

  const providers = resolveProviders(getEnv);
  if (!providers.length) {
    return c.json({
      error: {
        message: 'No providers configured. Set at least one of GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, or CUSTOM_BASE_URL on the server.',
        type: 'gateway_not_configured',
      },
    }, 503);
  }

  const { providers: list, model } = plan(c, body, alive(providers));
  const base = { ...body };
  delete base.model;
  if (model) base.model = model;

  // Stop working if the phone hangs up.
  const clientSignal = c.req.raw.signal;

  if (body.stream === true) return handleStream(c, list, base, clientSignal);
  return handleJson(c, list, base, clientSignal);
});

gateway.get('/models', (c) => {
  const auth = checkAuth(c);
  if (!auth.ok) return unauthorized(c, auth.status, auth.message);

  const data = [];
  for (const p of resolveProviders(getEnv)) {
    const models = p.models?.length ? p.models : [p.defaultModel].filter(Boolean);
    for (const m of models) {
      data.push({
        id: `${p.id}/${m}`,   // namespaced so the app can route precisely
        object: 'model',
        created: 0,
        owned_by: p.id,
        provider: p.id,
        model: m,
      });
    }
  }
  return c.json({ object: 'list', data });
});

gateway.get('/providers', (c) => {
  const auth = checkAuth(c);
  if (!auth.ok) return unauthorized(c, auth.status, auth.message);
  return c.json({
    order: (getEnv('PROVIDER_ORDER') ?? DEFAULT_ORDER).split(',').map((s) => s.trim()).filter(Boolean),
    providers: describeProviders(getEnv),
  });
});

gateway.get('/', (c) => c.json({
  ok: true,
  service: 'free-llm-gateway',
  configured_providers: resolveProviders(getEnv).map((p) => p.id),
  routes: ['POST /v1/chat/completions', 'GET /v1/models', 'GET /v1/providers'],
}));
