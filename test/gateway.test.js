// Node's built-in test runner, no extra deps: `npm test`
//
// Every provider is replaced with a local fake so the tests exercise fallback
// logic without burning real free-tier quota.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// --- config: three fake providers, smallest possible ---
process.env.GATEWAY_TOKEN = 'test-token';
process.env.PROVIDER_ORDER = 'alpha,beta,gamma';
process.env.ALPHA_API_KEY = 'alpha-key';
process.env.BETA_API_KEY = 'beta-key';
process.env.GAMMA_API_KEY = 'gamma-key';
process.env.ALPHA_BASE_URL = 'http://llm.test/alpha/v1';
process.env.BETA_BASE_URL = 'http://llm.test/beta/v1';
process.env.GAMMA_BASE_URL = 'http://llm.test/gamma/v1';
process.env.ALPHA_MODEL = 'alpha-model';
process.env.BETA_MODEL = 'beta-model';
process.env.GAMMA_MODEL = 'gamma-model';
process.env.PROVIDER_COOLDOWN_MS = '0'; // per-test opt-in
process.env.FIRST_CHUNK_MS = '2000';

const realFetch = globalThis.fetch;
let calls = [];

// --- fake upstream ---
function sse(...events) {
  return new ReadableStream({
    start(ctrl) {
      const enc = new TextEncoder();
      for (const e of events) ctrl.enqueue(enc.encode(e));
      ctrl.close();
    },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const provider = url.pathname.split('/')[1];
  const body = JSON.parse(init.body);
  calls.push({ provider, model: body.model, stream: body.stream, headers: init.headers });

  const script = (globalThis.__scenario ?? {})[provider] ?? { status: 200, json: okJson(provider, body.model) };

  if (script.status && script.status !== 200) {
    return new Response(JSON.stringify({ error: { message: `${provider} says ${script.status}` } }), {
      status: script.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (script.stream) {
    const events = script.stream.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
    return new Response(sse(...events), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (script.sseDangling) {
    // 200 + text/event-stream but only junk, then close: must trigger fallback
    return new Response(sse('data: {"oops":true}\n\n'), { status: 200 });
  }
  return new Response(JSON.stringify(script.json ?? okJson(provider, body.model)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

function okJson(provider, model) {
  return {
    id: 'x',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: `hello from ${provider}` }, finish_reason: 'stop' }],
  };
}

const { default: app } = await import('../src/app.js');
after(() => { globalThis.fetch = realFetch; });

const post = (path, body, headers = {}) =>
  app.fetch(new Request(`http://local${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token', ...headers },
    body: JSON.stringify(body),
  }));

const get = (path, headers = {}) =>
  app.fetch(new Request(`http://local${path}`, { headers: { Authorization: 'Bearer test-token', ...headers } }));

const msgs = [{ role: 'user', content: 'hi' }];

function reset() { calls = []; globalThis.__scenario = {}; }

// ---------------------------------------------------------------------------

test('rejects a missing/incorrect token', async () => {
  reset();
  const noAuth = await app.fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: msgs }),
  }));
  assert.equal(noAuth.status, 401);

  const wrong = await post('/v1/chat/completions', { messages: msgs }, { Authorization: 'Bearer nope' });
  assert.equal(wrong.status, 401);
  assert.equal(calls.length, 0, 'no provider should be called without auth');
});

test('model "auto" walks the provider list and returns the first success', async () => {
  reset();
  globalThis.__scenario = { alpha: { status: 429 }, beta: { status: 503 } };
  const res = await post('/v1/chat/completions', { model: 'auto', messages: msgs });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-provider'), 'gamma');
  const json = await res.json();
  assert.equal(json.choices[0].message.content, 'hello from gamma');
  assert.deepEqual(calls.map((c) => c.provider), ['alpha', 'beta', 'gamma']);
  assert.equal(calls[2].model, 'gamma-model', 'uses the provider default model for auto');
});

test('cooldown makes a rate-limited provider skip on the next request', async () => {
  reset();
  process.env.PROVIDER_COOLDOWN_MS = '60000';
  try {
    globalThis.__scenario = { alpha: { status: 429 } };
    await post('/v1/chat/completions', { messages: msgs });
    calls = [];
    await post('/v1/chat/completions', { messages: msgs });
    assert.ok(!calls.some((c) => c.provider === 'alpha'), 'alpha should be cooling down');
  } finally {
    process.env.PROVIDER_COOLDOWN_MS = '0';
  }
});

test('all providers down → 503 with an attempts trail', async () => {
  reset();
  process.env.PROVIDER_COOLDOWN_MS = '0';
  globalThis.__scenario = { alpha: { status: 500 }, beta: { status: 500 }, gamma: { status: 500 } };
  const res = await post('/v1/chat/completions', { messages: msgs });
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.error.type, 'gateway_exhausted');
  assert.equal(json.error.attempts.length, 3);
  process.env.PROVIDER_COOLDOWN_MS = '0';
});

test('namespaced model routes straight to that provider', async () => {
  reset();
  const res = await post('/v1/chat/completions', { model: 'beta/beta-model', messages: msgs });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-provider'), 'beta');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'beta-model');
});

test('a provider 400 is NOT retried elsewhere (request itself is wrong)', async () => {
  reset();
  process.env.PROVIDER_COOLDOWN_MS = '0';
  globalThis.__scenario = { alpha: { status: 400 } };
  const res = await post('/v1/chat/completions', { messages: msgs });
  assert.equal(res.status, 503);
  assert.equal(calls.length, 1, 'only alpha should be called');
});

test('streaming passes events through and reports the provider in headers', async () => {
  reset();
  process.env.PROVIDER_COOLDOWN_MS = '0';
  const chunk = (content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  globalThis.__scenario = {
    alpha: {
      stream: [
        `data: ${JSON.stringify(chunk('str'))}\n\n`,
        `data: ${JSON.stringify(chunk('eam'))}\n\n`,
        'data: [DONE]\n\n',
      ],
    },
  };
  const res = await post('/v1/chat/completions', { stream: true, messages: msgs });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-provider'), 'alpha');
  const text = await res.text();
  assert.match(text, /"str"/);
  assert.match(text, /"eam"/);
  assert.match(text, /\[DONE\]/);
});

test('a stream that 200s but sends junk falls over to the next provider', async () => {
  reset();
  globalThis.__scenario = {
    alpha: { sseDangling: true },
    beta: { stream: [`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`, 'data: [DONE]\n\n'] },
  };
  const res = await post('/v1/chat/completions', { stream: true, messages: msgs });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-provider'), 'beta');
  const text = await res.text();
  assert.match(text, /"ok"/);
});

test('/v1/models lists namespaced models for configured providers', async () => {
  reset();
  const res = await get('/v1/models');
  assert.equal(res.status, 200);
  const json = await res.json();
  const ids = json.data.map((m) => m.id);
  assert.ok(ids.includes('alpha/alpha-model'));
  assert.ok(ids.includes('beta/beta-model'));
});

test('/v1/providers explains what is configured without leaking keys', async () => {
  reset();
  const res = await get('/v1/providers');
  const json = await res.json();
  const alpha = json.providers.find((p) => p.id === 'alpha');
  assert.equal(alpha.configured, true);
  assert.equal(JSON.stringify(json).includes('alpha-key'), false);
});

test('existing routes still work', async () => {
  const health = await app.fetch(new Request('http://local/health'));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'healthy');
  const ping = await app.fetch(new Request('http://local/api/ping?echo=yo'));
  assert.equal((await ping.json()).echo, 'yo');
});

test('missing GATEWAY_TOKEN disables /v1 instead of opening it', async () => {
  const saved = process.env.GATEWAY_TOKEN;
  delete process.env.GATEWAY_TOKEN;
  const res = await app.fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  }));
  process.env.GATEWAY_TOKEN = saved;
  assert.equal(res.status, 503);
});

test('/setup renders a phone card without leaking keys', async () => {
  reset();
  const res = await app.fetch(new Request('http://local/setup'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Paste this into the app/);
  assert.match(html, /http:\/\/local\/v1/);
  assert.equal(html.includes('alpha-key'), false, 'API keys must never be rendered');
  assert.match(html, /ChatterUI|Chatbox/);
});

test('/setup/cheatsheet is plain text with the base URL', async () => {
  const res = await app.fetch(new Request('http://local/setup/cheatsheet'));
  const text = await res.text();
  assert.match(text, /Base URL/);
  assert.match(text, /http:\/\/local\/v1/);
});

test('streaming a real upstream SSE keeps content chunks byte-identical', async () => {
  reset();
  process.env.PROVIDER_COOLDOWN_MS = '0';
  const chunk = (t) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] })}\n\n`;
  const upstream = chunk('a') + chunk('b') + 'data: [DONE]\n\n';
  globalThis.__scenario = { alpha: { stream: [chunk('a'), chunk('b'), 'data: [DONE]\n\n'] } };
  const res = await post('/v1/chat/completions', { stream: true, messages: msgs });
  const text = await res.text();
  assert.equal(text, upstream);
});

test('/setup carries a working in-page probe (posts to /v1/chat/completions)', async () => {
  const res = await app.fetch(new Request('http://local/setup'));
  const html = await res.text();
  assert.match(html, /async function probe\(/);
  assert.match(html, /'\/v1\/chat\/completions'/);
  assert.match(html, /x-gateway-provider/);
  assert.equal(html.includes('alpha-key'), false);
  // the page must not hard-code any secret into the script
  const script = html.split('<script>')[1] ?? '';
  assert.equal(/Bearer\s+[A-Za-z0-9]{12,}/.test(script), false);
});
