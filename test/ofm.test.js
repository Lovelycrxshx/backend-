// Tests for the /ofm bridge: no real standalone service, no real network.
//
// The child process is faked by pointing OFM_HOME at a temp directory with a
// settings.json (that file *is* the key source) and stubbing global fetch,
// which is how the bridge talks to the loopback service.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-test-'));
const KEY = 'ofm-test-key';
process.env.OFM_HOME = home;
process.env.GATEWAY_TOKEN = 'test-token';
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ forwardKey: KEY }));

const realFetch = globalThis.fetch;
const seen = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  seen.push({ url: url.pathname + url.search, init });
  if (url.pathname === '/v1/models') {
    return new Response(JSON.stringify({ object: 'list', data: [{ id: 'demo-model', context_window: 1000 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.pathname === '/v1/chat/completions') {
    return new Response('data: {"delta":"hi"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  if (url.pathname === '/health') return new Response('{"ok":true}', { status: 200 });
  return new Response('{"error":"nope"}', { status: 404 });
};

let app;
before(async () => {
  ({ default: app } = await import('../src/app.js'));
});
after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(home, { recursive: true, force: true });
});

const bg = (p, init) => app.fetch(new Request(`http://local${p}`, init));
const auth = (key = KEY) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

test('/health reports the bundled service and its key', async () => {
  const res = await bg('/health');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'healthy');
  assert.equal(body.ofm.hasKey, true);
  assert.equal(body.ofm.port, 18900);
});

test('/ofm requires the service key', async () => {
  const none = await bg('/ofm/v1/models');
  assert.equal(none.status, 401);
  const wrong = await bg('/ofm/v1/models', { headers: auth('not-it') });
  assert.equal(wrong.status, 401);
  const ok = await bg('/ofm/v1/models', { headers: auth() });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data[0].id, 'demo-model');
});

test('/ofm forwards only inference paths — never the console or management API', async () => {
  for (const p of ['/ofm/', '/ofm/assets/app.js', '/ofm/api/management/summary', '/ofm/v1/nope']) {
    const res = await bg(p, { headers: auth() });
    assert.equal(res.status, 404, p);
  }
});

test('/ofm streams the upstream body through instead of buffering it', async () => {
  const res = await bg('/ofm/v1/chat/completions', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ model: 'demo-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(await res.text(), 'data: {"delta":"hi"}\n\n');
  // The caller's key is swapped for the service's local key, and nothing else
  // from the caller's headers rides along.
  const upstream = seen.filter((r) => r.url === '/v1/chat/completions').at(-1);
  assert.equal(upstream.init.headers.authorization, `Bearer ${KEY}`);
});

test('the setup card offers the /ofm base URL and never the GATEWAY_TOKEN', async () => {
  const html = await (await bg('/setup')).text();
  assert.match(html, /\/ofm\/v1/);
  assert.match(html, /demo-model/);
  assert.doesNotMatch(html, /test-token/);
});

test('a missing key file degrades to 503 instead of crashing', async () => {
  const stash = path.join(home, 'settings.json');
  fs.renameSync(stash, `${stash}.bak`);
  try {
    const res = await bg('/ofm/v1/models', { headers: auth() });
    assert.equal(res.status, 503);
  } finally {
    fs.renameSync(`${stash}.bak`, stash);
  }
});
