// A phone-sized setup card: open <your-gateway>/setup on the Android device and
// copy the values straight into the chat app. Never renders the gateway token.
import { Hono } from 'hono';
import { env } from './env.js';
import { PROVIDERS, resolveProviders } from './providers.js';
import { ofmHealthy, ofmKey, ofmModels, ofmStatus } from './ofm.js';

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

setup.get('/', async (c) => {
  const getEnv = (k) => env(c, k);
  const ofm = ofmStatus();
  const ofmUp = ofm.hasKey && await ofmHealthy();
  const ofmModelsList = ofmUp ? await ofmModels() : [];
  const ofmKeyValue = ofmKey();
  const base = `${publicBase(c)}/v1`;
  const ofmBase = `${publicBase(c)}/ofm/v1`;
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

${ofmModelsList.length ? `<div class="card">
  <h2>Our Free Model — no key of your own needed</h2>
  <p>This server also runs the standalone <code>dsh-our-free-model</code> service, whose models need no account. Point the app at the same host but the <code>/ofm/v1</code> base URL:</p>
  <div class="row"><code id="ofmbase">${esc(ofmBase)}</code><button onclick="cp('ofmbase')">Copy</button></div>
  <div class="row"><code id="ofmkey">${esc(ofmKeyValue ?? '')}</code><button onclick="cp('ofmkey')">Copy key</button></div>
  <p style="font-size:.82rem">Key is the standalone service's own <code>forwardKey</code>, read from this server's data directory. Pick any model id below.</p>
  <table><thead><tr><th>Model id</th><th>Context</th></tr></thead><tbody>
    ${ofmModelsList.map((m) => `<tr><td><code>${esc(m.id)}</code></td><td>${m.context ? `${Math.round(m.context / 1024)}k` : '—'}</td></tr>`).join('')}
  </tbody></table>
</div>` : `<div class="warn">The bundled <code>dsh-our-free-model</code> service is not running yet${ofm.error ? ` (${esc(ofm.error)})` : ''}. It starts automatically with the server; reload this page in a few seconds.</div>`}

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
</script>
</body></html>`;

  return c.html(html);
});

setup.get('/cheatsheet', (c) => {
  const getEnv = (k) => env(c, k);
  const active = resolveProviders(getEnv);
  const base = `${publicBase(c)}/v1`;
  const ofmBase = `${publicBase(c)}/ofm/v1`;
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
