// A phone-sized setup card: open <your-gateway>/setup on the Android device and
// copy the values straight into the chat app. Never renders the gateway token.
import { Hono } from 'hono';
import { env } from './env.js';
import { PROVIDERS, resolveProviders } from './providers.js';

export const setup = new Hono();

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function publicBase(c) {
  const host =
    c.req.header('x-forwarded-host') ??
    c.req.header('host') ??
    new URL(c.req.url).host;
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '') ?? 'https';
  return `${proto}://${host}`;
}

const pick = {
  chatt: {
    name: 'ChatterUI',
    url: 'https://github.com/Vali-98/ChatterUI/releases/latest',
    steps: [
      'Install the APK from the releases page.',
      'Left menu → API → Create Connection.',
      'Type: Generic → <b>Chat Completions</b>.',
      'Endpoint: paste the base URL above (the app appends <code>/chat/completions</code> itself).',
      'API Key: paste your gateway token as the key.',
      'Model: the model id above. Add the provider prefix (for example <code>groq/openai/gpt-oss-120b</code>) to pin one provider.',
    ],
  },
  chatbox: {
    name: 'Chatbox',
    url: 'https://chatboxai.app/',
    steps: [
      'Install Chatbox from the Play Store.',
      'Settings → AI Provider → Add Custom Provider → <b>OpenAI API Compatible</b>.',
      'API Host: your gateway URL + <code>/v1</code>, nothing after it.',
      'API Key: your gateway token.',
      'Add model ids from the list above; <code>auto</code> lets the gateway choose.',
    ],
  },
};

setup.get('/', (c) => {
  const getEnv = (k) => env(c, k);
  const base = `${publicBase(c)}/v1`;
  const active = resolveProviders(getEnv);
  const app = pick[(getEnv('SETUP_APP') ?? 'chatt').toLowerCase()] ?? pick.chatt;

  const configured = PROVIDERS.filter((p) => active.some((a) => a.id === p.id));
  const missing = PROVIDERS.filter((p) => !active.some((a) => a.id === p.id));
  const rows = active.flatMap((p) =>
    (p.models?.length ? p.models : [p.defaultModel]).filter(Boolean).map((m) => ({ provider: p.id, model: m, label: p.label }))
  );

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b0f19">
<title>Free LLM gateway — phone setup</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f19; --card:#141a29; --line:#243047; --text:#e8edf7; --muted:#93a1bb; --accent:#6ee7b7; --warn:#fbbf24; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:18px 16px 48px; }
  h1 { font-size:1.35rem; margin:6px 0 2px; }
  h2 { font-size:1.02rem; margin:0 0 10px; }
  p { margin:8px 0; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; margin:14px 0; }
  .row { display:flex; align-items:center; gap:10px; background:#0a0f1c; border:1px solid var(--line); border-radius:12px; padding:10px 12px; margin:10px 0; }
  code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9rem; word-break:break-all; }
  .row code { flex:1; color:var(--accent); }
  button { background:var(--accent); color:#062014; border:0; border-radius:9px; padding:9px 13px; font-weight:700; font-size:.82rem; }
  ol { padding-left:20px; margin:8px 0 0; }
  li { margin:7px 0; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:.74rem; color:var(--muted); margin:0 6px 6px 0; }
  .ok { color:var(--accent); border-color:#245c46; }
  .miss { color:var(--warn); border-color:#5c4a17; }
  .warn { background:#2a2110; border:1px solid #5c4a17; color:#fde68a; border-radius:12px; padding:12px; font-size:.88rem; }
  a { color:#93c5fd; }
  table { width:100%; border-collapse:collapse; font-size:.86rem; }
  th,td { text-align:left; padding:7px 4px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:.76rem; text-transform:uppercase; letter-spacing:.04em; }
</style>
</head><body>
<h1>Free LLM gateway</h1>
<p>Point your Android chat app here — it falls back across ${active.length} configured free provider${active.length === 1 ? '' : 's'}.</p>

<div class="card">
  <h2>1. Paste this into the app</h2>
  <div class="row"><code id="base">${esc(base)}</code><button onclick="cp('base')">Copy</button></div>
  <div class="row"><code id="key">…your GATEWAY_TOKEN…</code><button onclick="cp('key')">Copy</button></div>
  <p style="font-size:.82rem">The key is the <code>GATEWAY_TOKEN</code> value set on the server. It is never shown here — get it from your host's env vars.</p>
</div>

<div class="card">
  <h2>Test it from this phone</h2>
  <p style="font-size:.82rem">Paste your token and send one real message. You'll see which provider answered, or exactly why each one refused.</p>
  <div class="row"><input id="tok" type="password" placeholder="paste GATEWAY_TOKEN" autocomplete="off" autocapitalize="off" spellcheck="false" style="flex:1;background:transparent;border:0;color:var(--text);font:inherit;min-width:0"><button onclick="probe()">Test</button></div>
  <p id="verdict" style="font-size:.9rem"></p>
  <pre id="probe-out" class="mono" style="white-space:pre-wrap;font-size:.78rem;background:#0a0f1c;border:1px solid var(--line);border-radius:12px;padding:10px;display:none;overflow-x:auto"></pre>
</div>

<div class="card">
  <h2>2. ${esc(app.name)} on Android</h2>
  <ol>${app.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
  <p><a href="${esc(app.url)}">Download ${esc(app.name)}</a></p>
</div>

<div class="card">
  <h2>3. Models you can pick</h2>
  ${rows.length
    ? `<table><thead><tr><th>In the app</th><th>Provider</th></tr></thead><tbody>
       <tr><td><code>auto</code></td><td>gateway picks, with fallback</td></tr>
       ${rows.map((r) => `<tr><td><code>${esc(r.provider)}/${esc(r.model)}</code></td><td>${esc(r.label)}</td></tr>`).join('')}
       </tbody></table>`
    : ''}
</div>

<div class="card">
  <h2>Provider status</h2>
  <div>
    ${configured.map((p) => `<span class="pill ok">✓ ${esc(p.label)}</span>`).join('')}
    ${missing.map((p) => `<span class="pill miss">— ${esc(p.label)}</span>`).join('')}
  </div>
  <p style="font-size:.82rem">Add a key as an env var (${missing.slice(0, 2).map((p) => `<code>${esc(p.keyEnv)}</code>`).join(', ')}…) and redeploy to activate that provider. Keyless providers (OVHcloud, LLM7) need nothing.</p>
</div>

${configured.length ? '' : `<div class="warn">No providers configured yet. Add at least one API key env var, or rely on the keyless providers.</div>`}

<script>
function cp(id) {
  const el = document.getElementById(id);
  if (id === 'key') { alert('Use the GATEWAY_TOKEN from your server env vars.'); return; }
  navigator.clipboard?.writeText(el.textContent.trim()).then(
    () => { el.textContent = 'copied ✓'; setTimeout(() => location.reload(), 800); },
    () => alert(el.textContent.trim())
  );
}

// One real request straight from the phone, so the deploy is proven end to end.
async function probe() {
  const out = document.getElementById('probe-out');
  const verdict = document.getElementById('verdict');
  const tok = (document.getElementById('tok').value || '').trim();
  if (!tok) { verdict.textContent = 'Paste your gateway token first.'; return; }
  verdict.textContent = 'Asking the gateway…';
  out.style.display = 'block';
  out.textContent = '';
  const started = Date.now();
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'Reply with exactly: gateway ok' }], max_tokens: 24 }),
    });
    const ms = Date.now() - started;
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    const provider = res.headers.get('x-gateway-provider');
    const model = res.headers.get('x-gateway-model');
    if (res.ok) {
      const reply = body?.choices?.[0]?.message?.content ?? '(empty reply)';
      verdict.innerHTML = '<span style="color:var(--accent)">✓ Working</span> — ' + (provider ? 'answered by <b>' + provider + '</b> (' + model + ')' : 'answered') + ' in ' + ms + ' ms';
      out.textContent = reply + '\n\n--- raw ---\n' + text.slice(0, 1200);
    } else if (res.status === 401) {
      verdict.innerHTML = '<span style="color:var(--warn)">Token rejected</span> — it must match GATEWAY_TOKEN exactly.';
      out.textContent = text.slice(0, 600);
    } else {
      const attempts = body?.error?.attempts ?? body?.attempts ?? [];
      verdict.innerHTML = '<span style="color:var(--warn)">No provider answered (' + res.status + ')</span> — see the per-provider reasons below.';
      out.textContent = (body?.error?.message ?? text.slice(0, 400)) + '\n\n' +
        attempts.map((a) => '• ' + a.provider + (a.model ? ' / ' + a.model : '') + ': ' + (a.error ?? ('HTTP ' + a.status))).join('\n');
    }
  } catch (err) {
    verdict.innerHTML = '<span style="color:var(--warn)">Request never reached the gateway</span> — ' + err.message;
  }
}
</script>
</body></html>`;

  return c.html(html);
});

setup.get('/cheatsheet', (c) => {
  const getEnv = (k) => env(c, k);
  const active = resolveProviders(getEnv);
  const base = `${publicBase(c)}/v1`;
  return c.text(
    [
      `Base URL (any OpenAI-compatible app): ${base}`,
      'API key: <GATEWAY_TOKEN>',
      'Model: auto  (or provider/model, e.g. groq/openai/gpt-oss-120b)',
      '',
      'Active providers:',
      ...active.map((p) => `  - ${p.id}: ${(p.models?.length ? p.models : [p.defaultModel]).join(', ')}`),
      '',
      'curl test:',
      `  curl -s ${base}/chat/completions -H "Authorization: Bearer $GATEWAY_TOKEN" \\`,
      '    -H "Content-Type: application/json" \\',
      '    -d \'{"model":"auto","messages":[{"role":"user","content":"hi"}]}\'',
    ].join('\n')
  );
});
